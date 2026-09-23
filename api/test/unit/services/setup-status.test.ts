import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clientConfigDocuments, versions } from '../../../src/db/schema.js';
import type { Database } from '../../../src/db/client.js';
import type { Env } from '../../../src/env.js';
import type { Keyring } from '../../../src/security/keyring.js';
import { SetupStatusService } from '../../../src/services/setup-status.js';
import { SETUP_WIZARD_STATE_KEY } from '../../../src/services/setup-wizard.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'setup-status-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function service(db: DbFake, env: Partial<Env> = {}): SetupStatusService {
  return new SetupStatusService(
    db as unknown as Database,
    { MIGRATIONS_DIR: dir, DATA_ROOT: dir, PUBLIC_BASE_URL: 'https://o.example', ...env } as Env,
    {} as Keyring,
  );
}

function wizardRow(engines: string[] | null) {
  return {
    name: SETUP_WIZARD_STATE_KEY,
    version: JSON.stringify({ completed_at: null, dismissed_at: null, last_step: 'engines', engines }),
    updatedAt: '2026-09-23T00:00:00Z',
  };
}

describe('SetupStatusService', () => {
  it('builds auth next actions from configured engines and adds fleet defaults before the first host', async () => {
    const db = createDbFake();
    const status = await service(db, { DEFAULT_HOST_ENGINES: 'codex' }).status();

    expect(status.default_engines).toEqual(['codex']);
    expect(status.next_actions.map((action) => action.id)).toEqual([
      'auth_codex',
      'fleet_defaults',
      'first_host',
      'first_sync',
    ]);
    expect(status.next_actions.find((action) => action.id === 'fleet_defaults')).toEqual({
      id: 'fleet_defaults',
      complete: false,
      label: 'Save fleet model defaults',
      href: '/admin/setup?step=defaults',
    });
    expect(status.checks[0]).toMatchObject({ id: 'database', ok: true });
  });

  it('prefers the wizard engine answer over configured engines', async () => {
    const db = createDbFake(new Map([[versions, [wizardRow(['claude'])]]]));
    const status = await service(db, { DEFAULT_HOST_ENGINES: 'codex' }).status();

    expect(status.configured_engines).toEqual(['codex']);
    expect(status.default_engines).toEqual(['claude']);
    expect(status.next_actions.filter((action) => action.id.startsWith('auth_')).map((a) => a.id)).toEqual([
      'auth_claude',
    ]);
  });

  it('falls back to configured engines when the wizard answer is empty', async () => {
    const db = createDbFake(new Map([[versions, [wizardRow([])]]]));
    const status = await service(db, { DEFAULT_HOST_ENGINES: 'codex,claude' }).status();

    expect(status.default_engines).toEqual(['codex', 'claude']);
  });

  it('marks fleet defaults complete only for a Codex client config row', async () => {
    const claudeOnly = createDbFake(new Map([[clientConfigDocuments, [{ id: 1, engine: 'claude' }]]]));
    const withCodex = createDbFake(new Map([[clientConfigDocuments, [{ id: 2, engine: 'codex' }]]]));

    const pick = (status: Awaited<ReturnType<SetupStatusService['status']>>) =>
      status.next_actions.find((action) => action.id === 'fleet_defaults')?.complete;
    expect(pick(await service(claudeOnly).status())).toBe(false);
    expect(pick(await service(withCodex).status())).toBe(true);
  });

  it('reports an unreachable database as a failing check instead of throwing', async () => {
    const db = createDbFake();
    db.execute = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:3306'));
    // Every other read must be skipped; one that reached the fake would throw.
    db.select = () => {
      throw new Error('select must not run while the database is down');
    };

    const status = await service(db).status();

    expect(status.critical_complete).toBe(false);
    expect(status.checks.find((check) => check.id === 'database')).toMatchObject({
      ok: false,
      detail: 'connect ECONNREFUSED 127.0.0.1:3306',
    });
    expect(status.checks.find((check) => check.id === 'migrations')).toMatchObject({ ok: false });
    expect(status.owner_created).toBe(false);
  });
});
