import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql, { type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations, migrationStatus, type MigrationPool } from '../../../src/db/migrator.js';
import { readDbConfig } from '../../helpers/test-db.js';

const config = readDbConfig();
const baseline = 'CREATE TABLE `first_record` (id INT PRIMARY KEY);\nCREATE TABLE `second_record` (id INT PRIMARY KEY);';
const filename = '0001_test_marker.sql';

// The server commits actual MySQL DDL. Only the point at which the connection
// disappears is injected. A fresh connection must infer everything from MySQL.
function lostConnection(pool: Pool, match: RegExp, phase: 'before' | 'after'): MigrationPool {
  return { getConnection: async () => {
    const conn = await pool.getConnection();
    const query = async (sql: string, params?: unknown[]) => {
      if (!match.test(sql)) return conn.query(sql, params);
      if (phase === 'after') await conn.query(sql, params);
      conn.destroy();
      throw new Error('fixture lost the MySQL connection');
    };
    return { query, release: () => conn.release(), destroy: () => conn.destroy(),
      beginTransaction: () => conn.beginTransaction(), rollback: () => conn.rollback(),
      commit: () => query('COMMIT'),
    } as unknown as PoolConnection;
  } };
}

describe.skipIf(!config)('baseline recovery on disposable MySQL', () => {
  let pool: Pool;
  let admin: mysql.Connection;
  let database: string;
  let root: string;
  let opts: { initSchema: true; dir: string; baselineFile: string };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cxx-migrator-'));
    opts = { initSchema: true, dir: root, baselineFile: join(root, 'baseline.txt') };
    await writeFile(opts.baselineFile, baseline);
    await writeFile(join(root, filename), 'CREATE TABLE IF NOT EXISTS evolved (id INT PRIMARY KEY);');
    database = 'review_migrator_' + randomUUID().replaceAll('-', '');
    admin = await mysql.createConnection({ ...config!, database: undefined });
    await admin.query(`CREATE DATABASE \`${database}\``);
    pool = mysql.createPool({ ...config!, database });
  });

  afterEach(async () => {
    if (pool) await pool.end();
    if (admin) {
      try { await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); }
    }
    await rm(root, { recursive: true, force: true });
  });

  it.each(['before', 'after'] as const)('recovers when the second CREATE disconnects %s commit', async phase => {
    await expect(runMigrations(lostConnection(pool, /^CREATE TABLE `second_record`/, phase), opts))
      .rejects.toThrow(/baseline.*statement 2/);
    const [ledger] = await pool.query<RowDataPacket[]>('SELECT version, statements FROM schema_migrations');
    expect(ledger).toMatchObject([{ version: '@init-schema', statements: 1 }]);
    await expect(runMigrations(pool, { dir: root })).rejects.toThrow('baseline initialization is unfinished');
    await expect(migrationStatus(pool, root)).rejects.toThrow('baseline initialization is unfinished');
    const resumed = await runMigrations(pool, opts);
    expect(resumed.baseline?.applied).toBe(true);
    expect(resumed.outcomes.map(row => row.filename)).toEqual([filename]);
    expect((await migrationStatus(pool, root)).map(row => row.status)).toEqual(['applied']);
    const again = await runMigrations(pool, opts);
    expect(again.baseline?.applied).toBe(false);
    expect(again.outcomes).toEqual([]);
  });

  it.each([/^CREATE INDEX/, /^ALTER TABLE/])('recognizes committed index/foreign-key DDL after losing %s', async pattern => {
    const index = 'CREATE INDEX `lookup_id` ON `second_record` (`id`);';
    const fk = 'ALTER TABLE `second_record` ADD CONSTRAINT `fk_first` FOREIGN KEY (`id`) REFERENCES `first_record`(`id`) ON DELETE cascade ON UPDATE no action;';
    await writeFile(opts.baselineFile, [baseline, index, fk].join('\n'));
    await expect(runMigrations(lostConnection(pool, pattern, 'after'), opts)).rejects.toThrow('fixture lost');
    expect((await runMigrations(pool, opts)).baseline?.applied).toBe(true);
    const [constraints] = await pool.query<RowDataPacket[]>(
      "SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE()");
    expect(constraints).toMatchObject([{ CONSTRAINT_NAME: 'fk_first' }]);
  });

  it.each(['before', 'after'] as const)('stores seed and progress together across a lost COMMIT reply %s commit', async phase => {
    await writeFile(opts.baselineFile, baseline + '\nINSERT INTO first_record VALUES (7);');
    await expect(runMigrations(lostConnection(pool, /^COMMIT$/, phase), opts)).rejects.toThrow('fixture lost');
    await runMigrations(pool, opts);
    const [rows] = await pool.query<RowDataPacket[]>('SELECT id FROM first_record');
    expect(rows).toMatchObject([{ id: 7 }]);
  });

  it('refuses an edited baseline, schema drift and a different table with the pending name', async () => {
    await expect(runMigrations(lostConnection(pool, /^CREATE TABLE `second_record`/, 'before'), opts))
      .rejects.toThrow('fixture lost');
    await writeFile(opts.baselineFile, baseline.replaceAll('INT PRIMARY KEY', 'BIGINT PRIMARY KEY'));
    await expect(runMigrations(pool, opts)).rejects.toThrow('original baseline artifact');
    await writeFile(opts.baselineFile, baseline);
    await pool.query('CREATE TABLE second_record (id BIGINT PRIMARY KEY)');
    await expect(runMigrations(pool, opts)).rejects.toThrow('effect uncertain');
    await pool.query('DROP TABLE second_record');
    await pool.query('ALTER TABLE first_record ADD COLUMN legitimate_note VARCHAR(50)');
    await expect(runMigrations(pool, opts)).rejects.toThrow('effect uncertain');
    const [ledger] = await pool.query<RowDataPacket[]>('SELECT version, statements FROM schema_migrations');
    expect(ledger).toMatchObject([{ version: '@init-schema', statements: 1 }]);
  });

  it('keeps an unmarked partial database intact and adopts its completed legacy schema', async () => {
    await pool.query('CREATE TABLE first_record (id INT PRIMARY KEY)');
    await pool.query('INSERT INTO first_record VALUES (42)');
    await expect(runMigrations(pool, opts)).rejects.toThrow('unmarked partial schema');
    await pool.query('CREATE TABLE second_record (id INT PRIMARY KEY)');
    const report = await runMigrations(pool, opts);
    expect(report.baseline?.applied).toBe(false);
    expect(report.outcomes.map(row => row.filename)).toEqual([filename]);
    const [rows] = await pool.query<RowDataPacket[]>('SELECT id FROM first_record');
    expect(rows).toMatchObject([{ id: 42 }]);
  });

  it('recovers the distributed baseline then applies every shipped migration', async () => {
    await expect(runMigrations(lostConnection(pool, /^CREATE TABLE `admin_passkeys`/, 'after'), { initSchema: true }))
      .rejects.toThrow('fixture lost');
    const resumed = await runMigrations(pool, { initSchema: true });
    expect(resumed.baseline?.applied).toBe(true);
    expect(resumed.outcomes.length).toBeGreaterThan(0);
    expect((await migrationStatus(pool)).every(row => row.status === 'applied')).toBe(true);
    const next = await runMigrations(pool, { initSchema: true });
    expect(next.baseline?.applied).toBe(false);
    expect(next.outcomes).toHaveLength(0);
  }, 120_000);
});
