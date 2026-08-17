/**
 * The `versions` row names written here are a contract shared with
 * runner-proxy's status reader, which re-derives them by hand. These tests pin
 * both halves: the exact names/values the writer emits, and that those same
 * names hydrate the admin overview's runner tile.
 */

import { describe, it, expect } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import {
  writeRunnerTelemetry,
  type RunnerTelemetryState,
} from '../../../src/services/runner-telemetry.js';
import { type RunnerEngineStatus } from '../../../src/services/runner-proxy.js';
import type { Database } from '../../../src/db/client.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../../../src/util/engine.js';
import { createDbFake, versionsTable } from '../../helpers/db-fake.js';
import {
  canonicalRow,
  createRunnerTelemetryReaderForFake,
  fakeRunnerValidation,
  makeRunnerProxy,
  readyRunnerEnv,
} from '../../helpers/runner-proxy-factory.js';

const dialect = new MySqlDialect();

interface WrittenVersion {
  name: string;
  version: string;
  updatedAt: string;
}

/** Runs the writer against a recording `db.execute` and decodes the bound params. */
async function recordWrites(
  engine: Engine,
  state: RunnerTelemetryState,
  checkedAt: string,
): Promise<WrittenVersion[]> {
  const written: WrittenVersion[] = [];
  const db = {
    execute: async (query: SQL) => {
      const { sql: text, params } = dialect.sqlToQuery(query);
      expect(text).toContain('INSERT INTO versions');
      expect(text).toContain('ON DUPLICATE KEY UPDATE');
      const [name, version, updatedAt] = params as [string, string, string];
      written.push({ name, version, updatedAt });
      return undefined;
    },
  } as unknown as Database;

  await writeRunnerTelemetry(db, engine, state, checkedAt);
  return written;
}

function valueOf(written: WrittenVersion[], name: string): string | undefined {
  return written.find((row) => row.name === name)?.version;
}

/** Feeds exactly the rows the writer produced back through the status reader. */
async function readBackStatus(written: WrittenVersion[]): Promise<{
  codex: RunnerEngineStatus;
  claude: RunnerEngineStatus;
}> {
  const db = createDbFake(new Map([[versionsTable, written.map((row) => ({ ...row }))]]));
  const svc = makeRunnerProxy(readyRunnerEnv(), {
    // Telemetry is projected only for engines that actually hold verified
    // canonical auth, so both are present here; this suite is about the row
    // names, not about the canonical gate.
    runnerValidation: fakeRunnerValidation({
      codex: canonicalRow({ id: 1, engine: ENGINE_CODEX }),
      claude: canonicalRow({ id: 2, engine: ENGINE_CLAUDE }),
    }),
    readTelemetry: createRunnerTelemetryReaderForFake(db as unknown as Database),
  });
  const status = await svc.status();
  return status.last_result as { codex: RunnerEngineStatus; claude: RunnerEngineStatus };
}

const CHECKED_AT = '2026-05-20T10:09:50Z';

describe('writeRunnerTelemetry', () => {
  it('writes the unsuffixed ok rows for codex', async () => {
    const written = await recordWrites(ENGINE_CODEX, 'ok', CHECKED_AT);

    expect(written.map((row) => row.name)).toEqual([
      'runner_state',
      'runner_last_check',
      'runner_last_ok',
    ]);
    expect(valueOf(written, 'runner_state')).toBe('ok');
    expect(valueOf(written, 'runner_last_check')).toBe(CHECKED_AT);
    expect(valueOf(written, 'runner_last_ok')).toBe(CHECKED_AT);
    expect(valueOf(written, 'runner_last_fail')).toBeUndefined();
    for (const row of written) expect(row.updatedAt).toBe(CHECKED_AT);
  });

  it('writes the unsuffixed fail rows for codex', async () => {
    const written = await recordWrites(ENGINE_CODEX, 'fail', CHECKED_AT);

    expect(written.map((row) => row.name)).toEqual([
      'runner_state',
      'runner_last_check',
      'runner_last_fail',
    ]);
    expect(valueOf(written, 'runner_state')).toBe('fail');
    expect(valueOf(written, 'runner_last_check')).toBe(CHECKED_AT);
    expect(valueOf(written, 'runner_last_fail')).toBe(CHECKED_AT);
    expect(valueOf(written, 'runner_last_ok')).toBeUndefined();
    for (const row of written) expect(row.updatedAt).toBe(CHECKED_AT);
  });

  it('suffixes every claude row with _claude on ok', async () => {
    const written = await recordWrites(ENGINE_CLAUDE, 'ok', CHECKED_AT);

    expect(written.map((row) => row.name)).toEqual([
      'runner_state_claude',
      'runner_last_check_claude',
      'runner_last_ok_claude',
    ]);
    expect(valueOf(written, 'runner_state_claude')).toBe('ok');
    expect(valueOf(written, 'runner_last_check_claude')).toBe(CHECKED_AT);
    expect(valueOf(written, 'runner_last_ok_claude')).toBe(CHECKED_AT);
    expect(valueOf(written, 'runner_last_fail_claude')).toBeUndefined();
    for (const row of written) expect(row.updatedAt).toBe(CHECKED_AT);
  });

  it('suffixes every claude row with _claude on fail', async () => {
    const written = await recordWrites(ENGINE_CLAUDE, 'fail', CHECKED_AT);

    expect(written.map((row) => row.name)).toEqual([
      'runner_state_claude',
      'runner_last_check_claude',
      'runner_last_fail_claude',
    ]);
    expect(valueOf(written, 'runner_state_claude')).toBe('fail');
    expect(valueOf(written, 'runner_last_check_claude')).toBe(CHECKED_AT);
    expect(valueOf(written, 'runner_last_fail_claude')).toBe(CHECKED_AT);
    expect(valueOf(written, 'runner_last_ok_claude')).toBeUndefined();
    for (const row of written) expect(row.updatedAt).toBe(CHECKED_AT);
  });

  it('never writes an unsuffixed name for claude', async () => {
    for (const state of ['ok', 'fail'] as const) {
      const written = await recordWrites(ENGINE_CLAUDE, state, CHECKED_AT);
      for (const row of written) expect(row.name.endsWith('_claude')).toBe(true);
    }
  });
});

describe('writeRunnerTelemetry round-trips through RunnerProxyService.status()', () => {
  it('hydrates only the codex engine from an ok write', async () => {
    const { codex, claude } = await readBackStatus(
      await recordWrites(ENGINE_CODEX, 'ok', CHECKED_AT),
    );

    expect(codex.state).toBe('ok');
    expect(codex.last_check).toBe(CHECKED_AT);
    expect(codex.last_ok).toBe(CHECKED_AT);
    expect(codex.last_fail).toBeNull();
    expect(claude).toMatchObject({ state: null, last_check: null, last_ok: null, last_fail: null });
  });

  it('hydrates only the codex engine from a fail write', async () => {
    const { codex, claude } = await readBackStatus(
      await recordWrites(ENGINE_CODEX, 'fail', CHECKED_AT),
    );

    expect(codex.state).toBe('fail');
    expect(codex.last_check).toBe(CHECKED_AT);
    expect(codex.last_fail).toBe(CHECKED_AT);
    expect(codex.last_ok).toBeNull();
    expect(claude).toMatchObject({ state: null, last_check: null, last_ok: null, last_fail: null });
  });

  it('hydrates only the claude engine from an ok write', async () => {
    const { codex, claude } = await readBackStatus(
      await recordWrites(ENGINE_CLAUDE, 'ok', CHECKED_AT),
    );

    expect(claude.state).toBe('ok');
    expect(claude.last_check).toBe(CHECKED_AT);
    expect(claude.last_ok).toBe(CHECKED_AT);
    expect(claude.last_fail).toBeNull();
    expect(codex).toMatchObject({ state: null, last_check: null, last_ok: null, last_fail: null });
  });

  it('hydrates only the claude engine from a fail write', async () => {
    const { codex, claude } = await readBackStatus(
      await recordWrites(ENGINE_CLAUDE, 'fail', CHECKED_AT),
    );

    expect(claude.state).toBe('fail');
    expect(claude.last_check).toBe(CHECKED_AT);
    expect(claude.last_fail).toBe(CHECKED_AT);
    expect(claude.last_ok).toBeNull();
    expect(codex).toMatchObject({ state: null, last_check: null, last_ok: null, last_fail: null });
  });
});
