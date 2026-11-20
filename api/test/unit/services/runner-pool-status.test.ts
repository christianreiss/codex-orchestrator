/**
 * API-AUTH-02: the accountless canonical head is a compatibility pointer for
 * pre-account wrappers. It stays on the account that created it and resolves
 * to null once that account is paused, while leases keep serving the other
 * enabled accounts. The Dashboard runner badge, "Run verification" and setup
 * status must describe that pool, not the pointer. The scenarios run the real
 * runner validation over the database fake; only the runner verdict is faked.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authCanonicalHeads, authPayloads, providerAccounts } from '../../../src/db/schema.js';
import type { Database } from '../../../src/db/client.js';
import type { Env } from '../../../src/env.js';
import { sha256 } from '../../../src/security/hash.js';
import { Keyring } from '../../../src/security/keyring.js';
import { encrypt } from '../../../src/security/secret-box.js';
import {
  createRunnerValidationService,
  enabledProviderAccountIds,
  resolvePooledCanonicalPayload,
  type CanonicalPayloadRow,
} from '../../../src/services/runner-validation.js';
import { SetupStatusService } from '../../../src/services/setup-status.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';
import { fakeAuthStore, makeRunnerProxy, readyRunnerEnv } from '../../helpers/runner-proxy-factory.js';

const keyring = Keyring.fromEnv({ ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } as never);

function payload(id: number, accountId: number, state: 'verified' | 'failed', stamp: string) {
  const token = `valid-account-${accountId}-token-123`;
  const body = JSON.stringify({
    last_refresh: stamp,
    auths: { 'api.openai.com': { token, token_type: 'bearer' } },
    auth_mode: 'apikey',
    OPENAI_API_KEY: token,
  });
  return {
    id,
    accountId,
    engine: 'codex',
    lastRefresh: stamp,
    sha256: sha256(body),
    body: encrypt(body, keyring),
    sourceHostId: null,
    createdAt: stamp,
    verificationState: state,
    verificationCheckedAt: stamp,
    verificationReason: state === 'failed' ? 'expired' : null,
    generation: id,
  };
}

function account(id: number, state: 'enabled' | 'paused') {
  return { id, engine: 'codex', label: `ChatGPT ${id}`, state, payloadId: id, mergedIntoAccountId: null };
}

/** Account 1 created the head; account 2 joined later. */
function pool(first: { state: 'enabled' | 'paused'; verification: 'verified' | 'failed' }, second = true): DbFake {
  return createDbFake(
    new Map<unknown, Record<string, unknown>[]>([
      [providerAccounts, [account(1, first.state), ...(second ? [account(2, 'enabled')] : [])]],
      [
        authPayloads,
        [
          payload(1, 1, first.verification, '2026-11-01T08:00:00Z'),
          ...(second ? [payload(2, 2, 'verified', '2026-11-02T08:00:00Z')] : []),
        ],
      ],
      [authCanonicalHeads, [{ engine: 'codex', payloadId: 1, generation: 1 }]],
    ]),
  );
}

function runner(db: DbFake, onVerify?: (input: unknown) => void) {
  const database = db as unknown as Database;
  return makeRunnerProxy(readyRunnerEnv(), {
    runnerValidation: createRunnerValidationService({ db: database, keyring }),
    authStore: fakeAuthStore({}, onVerify),
    poolAccountIds: (engine) => enabledProviderAccountIds(database, engine),
    readTelemetry: async () =>
      new Map([
        ['runner_state', 'ok'],
        ['runner_last_check', '2026-11-02T09:00:00Z'],
        ['runner_last_ok', '2026-11-02T09:00:00Z'],
      ]),
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runner-pool-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function setupCodexAuth(db: DbFake): Promise<boolean> {
  const env = { MIGRATIONS_DIR: dir, DATA_ROOT: dir, PUBLIC_BASE_URL: 'https://o.example' } as Env;
  return (await new SetupStatusService(db as unknown as Database, env, keyring).status()).canonical_auth.codex;
}

describe('admin auth surfaces describe the account pool (API-AUTH-02)', () => {
  it('verifies and reports the healthy account after the head account is paused', async () => {
    const db = pool({ state: 'paused', verification: 'verified' });
    const verified: Array<{ row: { id: number } }> = [];
    const proxy = runner(db, (input) => verified.push(input as { row: { id: number } }));

    const result = await proxy.run({}, 'codex');
    expect(result).toMatchObject({ status: 'ok', payload_id: 2 });
    expect(verified.map((input) => input.row.id)).toEqual([2]);
    expect((await proxy.status()).engines?.codex).toMatchObject({ state: 'ok', last_ok: '2026-11-02T09:00:00Z' });
    expect(await setupCodexAuth(db)).toBe(true);
  });

  it('looks past a failed head on an enabled account to a verified one', async () => {
    const db = pool({ state: 'enabled', verification: 'failed' });
    const verified: Array<{ row: { id: number } }> = [];

    expect(await runner(db, (input) => verified.push(input as { row: { id: number } })).run({}, 'codex')).toMatchObject({
      payload_id: 2,
    });
    expect(verified.map((input) => input.row.id)).toEqual([2]);
    expect(await setupCodexAuth(db)).toBe(true);
  });

  // Production reads owner RAM. A removed account keeps its payload rows with
  // the body cleared (drainOwnedProviders); the head still points at one.
  it('reads past a removed head account in owner state', async () => {
    const removed = { ...payload(1, 1, 'failed', '2026-11-01T08:00:00Z'), body: null, verificationReason: 'account removed' };
    const seed = {
      providerAccounts: [
        { ...account(1, 'enabled'), state: 'removed', payloadId: null, generation: 1, createdAt: '2026-11-01T08:00:00Z', updatedAt: '2026-11-03T08:00:00Z' },
        { ...account(2, 'enabled'), generation: 2, createdAt: '2026-11-02T08:00:00Z', updatedAt: '2026-11-02T08:00:00Z' },
      ],
      authPayloads: [removed, payload(2, 2, 'verified', '2026-11-02T08:00:00Z')],
      authCanonicalHeads: [{ engine: 'codex', payloadId: 1, generation: 1, updatedAt: '2026-11-01T08:00:00Z' }],
    } as unknown as StateSeed;
    const db = createDbFake();
    const runtime = {
      state: new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed)),
      deadlines: new DeadlineQueue((error) => { throw error; }),
      assertOwner() {},
      execute: () => { throw new Error('read-only scenario'); },
    } as unknown as OwnerRuntime;
    bindOwnerRuntime(db as unknown as Database, runtime);
    const verified: Array<{ row: { id: number } }> = [];
    try {
      expect(await runner(db, (input) => verified.push(input as { row: { id: number } })).run({}, 'codex')).toMatchObject({
        status: 'ok',
        payload_id: 2,
      });
      expect(verified.map((input) => input.row.id)).toEqual([2]);
      expect(await setupCodexAuth(db)).toBe(true);
    } finally {
      runtime.deadlines.close();
    }
  });

  it('reports no usable auth when the only verified credential belongs to a paused account', async () => {
    const db = pool({ state: 'paused', verification: 'verified' }, false);

    expect(await runner(db).run({}, 'codex')).toMatchObject({ status: 'fail', probed: false });
    expect((await runner(db).status()).engines?.codex).toMatchObject({ state: 'idle' });
    expect(await setupCodexAuth(db)).toBe(false);
  });
});

describe('resolvePooledCanonicalPayload', () => {
  const row = (id: number, verificationState: string, lastRefresh = '2026-11-01T08:00:00Z') =>
    ({ id, engine: 'codex', verificationState, lastRefresh }) as CanonicalPayloadRow;

  it('keeps a verified head without reading the pool', async () => {
    const resolve = vi.fn(async (_engine: string, accountId?: number) => (accountId === undefined ? row(1, 'verified') : null));
    expect((await resolvePooledCanonicalPayload({ resolveCanonicalPayload: resolve }, 'codex', [2, 3]))?.id).toBe(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('prefers the newest verified pool credential and falls back to the head verdict', async () => {
    const rows: Record<string, CanonicalPayloadRow | null> = {
      head: row(1, 'failed'),
      2: row(2, 'verified', '2026-11-02T08:00:00Z'),
      3: row(3, 'verified', '2026-11-03T08:00:00Z'),
      4: row(4, 'pending', '2026-11-04T08:00:00Z'),
    };
    const validation = {
      resolveCanonicalPayload: async (_engine: string, accountId?: number) => rows[accountId ?? 'head'] ?? null,
    };
    expect((await resolvePooledCanonicalPayload(validation, 'codex', [2, 3, 4]))?.id).toBe(3);
    expect((await resolvePooledCanonicalPayload(validation, 'codex', [4]))?.id).toBe(1);
  });
});
