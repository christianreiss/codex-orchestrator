import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import type { SQL } from 'drizzle-orm';
import type { Database } from '../../../src/db/client.js';
import { ServerRetentionService } from '../../../src/services/server-retention/index.js';
import { getTestDb } from '../../helpers/test-db.js';

const handle = await getTestDb();
describe.skipIf(!handle)('actual retention candidate queries on mixed legacy collations', () => {
  afterAll(async () => { await handle?.pool.end(); });
  it.each([
    ['utf8mb4_unicode_ci', 'utf8mb4_0900_ai_ci'],
    ['utf8mb4_0900_ai_ci', 'utf8mb4_unicode_ci'],
  ])('prepares all due candidate guards with %s / %s', async (first, second) => {
    const queries: Array<{ sql:string; params:unknown[] }> = [];
    const tx = { execute: async (query:SQL) => { queries.push(new MySqlDialect().sqlToQuery(query)); return [[]]; } };
    const service = new ServerRetentionService({ transaction: async (run:(value:typeof tx)=>Promise<unknown>) => run(tx) } as unknown as Database);
    for (const family of ['conversations','rooms','daemons','addresses'] as const) await service.purgeFamily(family);
    const tables = [...new Set(queries.flatMap(query => [...query.sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/gi)].map(match => match[1]!)))];
    const connection = await handle!.pool.getConnection();
    const database='retention_queries_'+randomUUID().replaceAll('-','');
    const [current] = await connection.query<import('mysql2/promise').RowDataPacket[]>('SELECT DATABASE() AS name');
    const original=String(current[0]!.name);
    try {
      await connection.query(`CREATE DATABASE \`${database}\``);
      for (const [i,table] of tables.entries()) {
        await connection.query(`CREATE TABLE \`${database}\`.\`${table}\` LIKE \`${original}\`.\`${table}\``);
        await connection.query(`ALTER TABLE \`${database}\`.\`${table}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE ${i%2 ? first : second}`);
      }
      // Force the exact two live failing relationships to cross collations.
      for (const [table,collation] of [['agent_bus_conversations',first],['advisor_sessions',second],['agent_room_events',first],['agent_bus_groups',second]])
        await connection.query(`ALTER TABLE \`${database}\`.\`${table}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE ${collation}`);
      await connection.query(`USE \`${database}\``);
      for (const prefix of ['SELECT c.id FROM agent_bus_conversations','SELECT e.id, e.room_id']) {
        const query=queries.find(query=>query.sql.startsWith(prefix))!;
        const old=query.sql.replaceAll('BINARY ','').replaceAll('b.topic COLLATE utf8mb4_unicode_ci','b.topic');
        await expect(connection.query(old,query.params)).rejects.toMatchObject({code:'ER_CANT_AGGREGATE_2COLLATIONS'});
      }
      for (const query of queries) {
        expect(query.sql.trimStart().startsWith('SELECT')).toBe(true);
        const [rows]=await connection.query(query.sql,query.params);
        expect(rows).toEqual([]);
      }
    } finally {
      await connection.query(`USE \`${original}\``);
      await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
      connection.release();
    }
  });
});
