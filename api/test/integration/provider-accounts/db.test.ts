import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import {
  authCanonicalHeads,
  authEntries,
  authPayloads,
  providerAccounts,
  providerAccountSessions,
  chatgptUsageSnapshots,
  claudeUsageSnapshots,
} from '../../../src/db/schema.js';
import { getTestDb } from '../../helpers/test-db.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';
import { createRunnerValidationService } from '../../../src/services/runner-validation.js';
import { createPooledAuthStoreService } from '../../../src/services/pooled-auth-store.js';
import { ProviderAccountsService } from '../../../src/services/provider-accounts.js';
import { ClaudeUsageService } from '../../../src/services/claude-usage.js';
import { pruneSupersededAuth } from '../../../src/services/auth-generation-retention.js';
import { withAccountTask } from '../../../src/services/account-task.js';
import type { RunnerClient } from '../../../src/services/runner-client.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { sha256 } from '../../../src/security/hash.js';

const handle = await getTestDb();
describe.skipIf(!handle)('provider accounts on MySQL', () => {
  const db = handle?.db as NonNullable<typeof handle>['db'];
  const keyring = testKeyring();
  const validation = createRunnerValidationService({ db, keyring });
  const accounts = new ProviderAccountsService(db, keyring);
  const runner: RunnerClient = {
    isConfigured: () => true,
    verify: async () => ({ ok: true, status: 'ok', reachable: true }),
    verifyClaude: async () => ({ ok: true, status: 'ok', reachable: true }),
  };
  const store = createPooledAuthStoreService({ db, keyring, runnerValidation: validation, runner });
  const auth = (engine: 'codex' | 'claude', tag: string) =>
    engine === 'codex'
      ? {
          last_refresh: '2026-09-30T09:00:00Z',
          tokens: { access_token: `access-${tag}`, refresh_token: `refresh-${tag}`, account_id: tag },
        }
      : {
          last_refresh: '2026-09-30T09:00:00Z',
          claudeAiOauth: { accessToken: `sk-ant-oat01-${tag}`, refreshToken: `refresh-${tag}` },
        };
  const enroll = async (engine: 'codex' | 'claude', tag: string) =>
    (
      await store.storeCandidate({
        engine,
        auth: auth(engine, tag),
        sourceHostId: null,
        requireLastRefresh: false,
        logAction: 'test.account',
      })
    ).account_id!;
  const cleanup = async () => {
    // This suite requires the explicitly opted-in disposable test DB.
    await db.delete(providerAccountSessions);
    await db.delete(authCanonicalHeads);
    await db.delete(authEntries);
    await db.delete(chatgptUsageSnapshots);
    await db.delete(claudeUsageSnapshots);
    await db.delete(authPayloads);
    await db.delete(providerAccounts);
  };
  beforeAll(cleanup);
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await handle!.pool.end();
  });

  it('adopts legacy head bytes without changing its digest or generation and migrates idempotently', async () => {
    const native = auth('codex', 'legacy');
    const entries = validation.normalizeAuthEntries(validation.ensureAuthsFallback(native, 'codex'), 'codex');
    const canonical = validation.canonicalizeAuthPayload(native, entries, native.last_refresh, 'codex');
    const raw = JSON.stringify(canonical);
    const body = encrypt(raw, keyring);
    const result = await db.insert(authPayloads).values({
      engine: 'codex',
      lastRefresh: native.last_refresh,
      sha256: sha256(raw),
      body,
      generation: 7,
      createdAt: native.last_refresh,
      verificationState: 'verified',
    });
    const id = Number(result[0].insertId);
    await db
      .insert(authCanonicalHeads)
      .values({ engine: 'codex', payloadId: id, generation: 7, updatedAt: native.last_refresh });
    const migration = readFileSync(
      new URL('../../../src/db/migrations/0035_provider_accounts.sql', import.meta.url),
      'utf8',
    );
    const connection = await handle!.pool.getConnection();
    try {
      for (let round = 0; round < 2; round++)
        for (const stmt of splitSqlStatements(migration)) await connection.query(stmt);
    } finally {
      connection.release();
    }
    const rows = await db.select().from(providerAccounts);
    expect(rows).toHaveLength(1);
    const adopted = await validation.resolveCanonicalPayload('codex', rows[0]!.id);
    expect(adopted).toMatchObject({ id, body, sha256: sha256(raw), generation: 7 });
  });

  it('enrolls both engine pools independently, deduplicates refresh lineage and keeps admin metadata secret-free', async () => {
    const a = await enroll('claude', 'one');
    await enroll('claude', 'two');
    await enroll('claude', 'three');
    const c = await enroll('codex', 'one');
    expect(await accounts.list('claude')).toHaveLength(3);
    expect(await enroll('claude', 'one')).toBe(a);
    expect(await enroll('codex', 'one')).toBe(c);
    const updated = await store.storeCandidate({
      engine: 'claude',
      auth: {
        ...auth('claude', 'one'),
        claudeAiOauth: { accessToken: 'sk-ant-oat01-rotated', refreshToken: 'refresh-one' },
        last_refresh: '2026-09-30T09:01:00Z',
      },
      sourceHostId: null,
      requireLastRefresh: false,
      logAction: 'test.refresh',
    });
    expect(updated.account_id).toBe(a);
    expect(JSON.stringify(await accounts.list())).not.toMatch(
      /access_token|accessToken|refreshToken|sk-ant-oat01/,
    );
    await expect(accounts.resolveCandidate(auth('codex', 'one'), 'codex', a)).rejects.toThrow('not found');
    await expect(accounts.resolveCandidate(auth('claude', 'two'), 'claude', a)).rejects.toThrow(
      'different account',
    );
  });

  it('enrolls a fresh recognized login despite an idle host binding and keeps explicit targets strict', async () => {
    const original = await enroll('codex', 'original');
    const before = await validation.resolveCanonicalPayload('codex', original);
    const added = await store.storeCandidate({
      engine: 'codex',
      accountId: original,
      accountHint: true,
      auth: auth('codex', 'fresh-login'),
      sourceHostId: 1,
      requireLastRefresh: false,
      logAction: 'test.login',
    });
    expect(added.account_id).not.toBe(original);
    expect((await validation.resolveCanonicalPayload('codex', original))?.body).toBe(before?.body);
    await expect(accounts.resolveCandidate(auth('codex', 'fresh-login'), 'codex', original)).rejects.toThrow(
      'different account',
    );
    expect((await accounts.resolveCandidate(auth('codex', 'original'), 'codex', original, 1, true)).id).toBe(
      original,
    );
    expect(await accounts.list('codex')).toHaveLength(2);
  });

  it('balances atomic reservations, pins overlapping scopes, and excludes paused accounts from new scopes', async () => {
    const ids = [await enroll('claude', 'a'), await enroll('claude', 'b'), await enroll('claude', 'c')];
    const reset = new Date(Date.now() + 3600_000).toISOString();
    for (const [i, id] of ids.entries())
      await new ClaudeUsageService(db, id).store({
        hostId: null,
        accountId: id,
        fiveHourUsedPercent: i === 1 ? 80 : 20,
        fiveHourResetsAt: reset,
        sevenDayUsedPercent: i === 1 ? 80 : 20,
        sevenDayResetsAt: reset,
      });
    const leases = await Promise.all(
      Array.from({ length: 12 }, (_, i) => accounts.acquire(1, 'claude', `scope-${i}`, `session-${i}`, 95)),
    );
    expect(leases.filter((l) => l.account.id === ids[1])).toHaveLength(0);
    expect(leases.filter((l) => l.account.id === ids[0])).toHaveLength(6);
    const pinned = leases[0]!.account.id;
    await accounts.update(pinned, { state: 'paused' });
    expect((await accounts.acquire(1, 'claude', 'scope-0', 'overlapping-session', 95)).account.id).toBe(
      pinned,
    );
    expect((await accounts.acquire(2, 'claude', 'new-scope', 'new-session', 95)).account.id).not.toBe(pinned);
    const retry = await accounts.acquire(1, 'claude', 'scope-0', 'session-0', 95);
    expect(retry.account.id).toBe(pinned);
    await expect(accounts.acquire(2, 'claude', 'scope-0', 'session-0', 95)).rejects.toThrow('already in use');
    await expect(accounts.acquire(1, 'codex', 'scope-0', 'codex-session', 95)).rejects.toThrow(
      'No verified ChatGPT',
    );
  });

  it('drains removal after sessions and rejects expired or foreign heartbeats and credential resurrection', async () => {
    const id = await enroll('claude', 'drain');
    await accounts.acquire(1, 'claude', 'scope', 'lease', 95);
    await accounts.update(id, { state: 'removing' });
    expect((await accounts.get(id)).state).toBe('removing');
    expect((await accounts.heartbeat(1, 'claude', 'lease')).account_id).toBe(id);
    await expect(accounts.heartbeat(2, 'claude', 'lease')).rejects.toThrow('not found');
    await accounts.release(1, 'claude', 'lease');
    expect((await accounts.get(id)).state).toBe('removed');
    expect(await validation.resolveCanonicalPayload('claude', id)).toBeNull();
    expect(
      (await db.select().from(authPayloads).where(eq(authPayloads.accountId, id))).every(
        (r) => r.body === null,
      ),
    ).toBe(true);
    await expect(enroll('claude', 'drain')).rejects.toThrow('retired');
    await db
      .update(authPayloads)
      .set({ purgeAfter: '2001-01-01T00:00:00Z', supersededAt: '2000-01-01T00:00:00Z' })
      .where(eq(authPayloads.accountId, id));
    await pruneSupersededAuth(db);
    await expect(enroll('claude', 'drain')).rejects.toThrow('retired');
    const other = await enroll('claude', 'other');
    await accounts.acquire(1, 'claude', 'scope', 'expired', 95);
    await db
      .update(providerAccountSessions)
      .set({ expiresAt: '2000-01-01T00:00:00Z' })
      .where(eq(providerAccountSessions.id, 'expired'));
    await expect(accounts.heartbeat(1, 'claude', 'expired')).rejects.toThrow('not found');
    expect((await accounts.get(other)).state).toBe('enabled');
  });

  it('releases internal runner reservations on failure and success', async () => {
    const id = await enroll('codex', 'task');
    await expect(
      withAccountTask(
        accounts,
        db,
        validation,
        'codex',
        async () => {
          throw new Error('legacy');
        },
        async (selected) => {
          expect((selected.tokens as Record<string, unknown>).account_id).toBe('task');
          expect((await accounts.list())[0]!.sessions).toHaveLength(1);
          throw new Error('runner failed');
        },
      ),
    ).rejects.toThrow('runner failed');
    expect((await accounts.list())[0]!.sessions).toHaveLength(0);
    expect((await accounts.get(id)).state).toBe('enabled');
  });

  it('prevents a slow successful probe from restoring a concurrently removed account', async () => {
    const id = await enroll('claude', 'race');
    let releaseProbe!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slow: RunnerClient = {
      ...runner,
      verifyClaude: async () => {
        entered();
        await pending;
        return { ok: true, status: 'ok', reachable: true };
      },
    };
    const saving = createPooledAuthStoreService({
      db,
      keyring,
      runnerValidation: validation,
      runner: slow,
    }).storeCandidate({
      engine: 'claude',
      accountId: id,
      auth: {
        ...auth('claude', 'race'),
        claudeAiOauth: { accessToken: 'sk-ant-oat01-new-race', refreshToken: 'new-race-refresh' },
        last_refresh: '2026-09-30T09:01:00Z',
      },
      sourceHostId: null,
      requireLastRefresh: false,
      logAction: 'test.race',
    });
    const outcome = saving.then(
      () => null,
      (error: unknown) => error,
    );
    await started;
    await accounts.update(id, { state: 'removing' });
    releaseProbe();
    expect(await outcome).toMatchObject({ message: 'Account is retired' });
    expect((await accounts.get(id)).state).toBe('removed');
    expect(
      await db
        .select()
        .from(authPayloads)
        .where(and(eq(authPayloads.accountId, id), sql`body IS NOT NULL`)),
    ).toHaveLength(0);
  });
});
