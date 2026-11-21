import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { readDbConfig } from '../../helpers/test-db.js';

const db = readDbConfig();

it.skipIf(!db)('flushes complete CLI reports to slow readers before returning the command exit code', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orchestrator-cli-report-'));
  const versions = Array.from({ length: 1200 }, (_, i) => String(7000 + i));
  const env = {
    ...process.env,
    DB_HOST: db!.host,
    DB_PORT: String(db!.port ?? 3306),
    DB_USERNAME: db!.user,
    DB_PASSWORD: db!.password,
    DB_DATABASE: db!.database,
    ENCRYPTION_ACTIVE_KEY: randomBytes(32).toString('base64'),
    MIGRATIONS_DIR: directory,
  };

  async function command(...args: string[]) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/db/migrate-cli.ts', ...args], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const errors: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    const chunks: Buffer[] = [];
    for await (const chunk of child.stdout) {
      chunks.push(Buffer.from(chunk));
      // A real pipe under backpressure still has unwritten bytes when main returns.
      await delay(10);
    }
    return { code: await closed, text: Buffer.concat(chunks).toString(), error: Buffer.concat(errors).toString() };
  }

  try {
    // --list and --check only read the ledger. No fixture SQL executes.
    for (const version of versions) {
      await writeFile(join(directory, version + '_slow_consumer_report_fixture.sql'), 'SELECT 1;\n');
    }
    for (const [flag, code] of [['--list', 0], ['--check', 1]] as const) {
      const result = await command(flag, '--json');
      expect(result.code).toBe(code);
      const report = JSON.parse(result.text);
      expect(report.pending).toBe(versions.length);
      expect(report.states.filter((s: { status: string }) => s.status === 'pending')
        .map((s: { version: string }) => s.version)).toEqual(versions);
    }
    const error = await command('--unrecognized-test-option');
    expect(error.code).toBe(1);
    expect(error.error).toContain('unknown option: --unrecognized-test-option');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
