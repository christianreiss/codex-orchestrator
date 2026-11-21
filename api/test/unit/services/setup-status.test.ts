import { createReadStream, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { registerHealthRoutes } from '../../../src/routes/health.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminUsers, clientConfigDocuments, hosts, providerAccounts, versions } from '../../../src/db/schema.js';
import type { Database } from '../../../src/db/client.js';
import type { Env } from '../../../src/env.js';
import type { Keyring } from '../../../src/security/keyring.js';
import { SetupStatusService } from '../../../src/services/setup-status.js';
import { SETUP_WIZARD_STATE_KEY } from '../../../src/services/setup-wizard.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';
import { SUPPORTED_WRAPPER_PLATFORMS } from '../../../src/services/wrapper-bin-registry.js';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, createReadStream: vi.fn(fs.createReadStream) };
});

let dir: string;

beforeEach(() => {
  vi.mocked(createReadStream).mockClear();
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

function installWrapperFixture() {
  const binary = 'verified-wrapper';
  const sha256 = createHash('sha256').update(binary).digest('hex');
  for (const platform of SUPPORTED_WRAPPER_PLATFORMS) {
    const root = join(dir, 'wrapper', 'v2', 'bin', 'cxx', platform);
    mkdirSync(join(root, 'v1.0.0'), { recursive: true });
    writeFileSync(join(root, 'v1.0.0', 'cxx'), binary);
    const [os, arch] = platform.split('-');
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({
      engine: 'cxx', os, arch, current: '1.0.0',
      builds: [{ version: '1.0.0', sha256, size_bytes: Buffer.byteLength(binary) }],
    }));
  }
  return binary;
}

describe('SetupStatusService', () => {
  it('uses only critical checks and retains verified digests across public readiness requests', async () => {
    installWrapperFixture();
    const db = createDbFake();
    const reads = vi.spyOn(db.tables, 'get');
    const app = Fastify();
    try {
      await registerHealthRoutes(app, {
        db: db as unknown as Database,
        env: { MIGRATIONS_DIR: dir, DATA_ROOT: dir, PUBLIC_BASE_URL: 'https://o.example' } as Env,
        keyring: {} as Keyring,
      } as RouteContext);
      for (let i = 0; i < 2; i++) {
        const response = await app.inject({ method: 'GET', url: '/readyz' });
        const checks = response.json().checks;
        expect(checks.map((check: { id: string }) => check.id)).toEqual([
          'database', 'migrations', 'runner', 'signer', 'wrappers', 'public_base_url',
        ]);
        expect(checks).toContainEqual(expect.objectContaining({ id: 'wrappers', ok: true }));
      }
      expect(createReadStream).toHaveBeenCalledTimes(SUPPORTED_WRAPPER_PLATFORMS.length);
      for (const table of [adminUsers, clientConfigDocuments, hosts, providerAccounts]) {
        expect(reads).not.toHaveBeenCalledWith(table);
      }
    } finally {
      await app.close();
    }
  });

  it('reuses verified wrapper digests between polls and rechecks changed binaries', async () => {
    const binary = installWrapperFixture();
    const checker = service(createDbFake());
    const wrappers = async () => (await checker.status()).checks.find(check => check.id === 'wrappers');
    expect(await wrappers()).toMatchObject({ ok: true });
    expect(createReadStream).toHaveBeenCalledTimes(SUPPORTED_WRAPPER_PLATFORMS.length);
    expect(await wrappers()).toMatchObject({ ok: true });
    expect(createReadStream).toHaveBeenCalledTimes(SUPPORTED_WRAPPER_PLATFORMS.length);

    const path = join(dir, 'wrapper', 'v2', 'bin', 'cxx', SUPPORTED_WRAPPER_PLATFORMS[0]!, 'v1.0.0', 'cxx');
    writeFileSync(path, 'corrupt!-wrapper'); // Same size; mtime must invalidate the cached digest.
    utimesSync(path, 1_800_000_000, 1_800_000_000);
    expect(await wrappers()).toMatchObject({ ok: false, detail: expect.stringContaining('checksum mismatch') });
    expect(createReadStream).toHaveBeenCalledTimes(SUPPORTED_WRAPPER_PLATFORMS.length + 1);
    writeFileSync(path, binary);
    utimesSync(path, 1_800_000_001, 1_800_000_001);
    expect(await wrappers()).toMatchObject({ ok: true });
    expect(createReadStream).toHaveBeenCalledTimes(SUPPORTED_WRAPPER_PLATFORMS.length + 2);
    // Release tools may atomically replace an artifact while preserving its build timestamp.
    const replacement = path + '.new';
    writeFileSync(replacement, 'corrupt!-wrapper');
    utimesSync(replacement, 1_800_000_001, 1_800_000_001);
    renameSync(replacement, path);
    expect(await wrappers()).toMatchObject({ ok: false, detail: expect.stringContaining('checksum mismatch') });
    expect(createReadStream).toHaveBeenCalledTimes(SUPPORTED_WRAPPER_PLATFORMS.length + 3);
  });

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

  it('includes Grok auth readiness without requiring the other provider logins', async () => {
    const db = createDbFake(new Map([[versions, [wizardRow(['grok'])]]]));
    const status = await service(db).status();
    expect(status.default_engines).toEqual(['grok']);
    expect(status.next_actions.filter(action => action.id.startsWith('auth_')).map(action => action.id)).toEqual(['auth_grok']);
    expect(status.canonical_auth.grok).toBe(false);
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
