import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { RowDataPacket } from 'mysql2';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createOwnedControlPlane } from '../../../src/control-plane/bootstrap.js';
import { ownedCredentialDeadline } from '../../../src/control-plane/credentials.js';
import { requestHost } from '../../../src/control-plane/state/admission.js';
import {
  SUSPEND_RECOVERY_GRACE_MS, livenessDueAt, sessionAbandonDueAt,
  sessionAttached, sessionAttachmentTransition,
} from '../../../src/control-plane/state/owner-liveness.js';
import { OwnerStateProvider } from '../../../src/control-plane/streams/provider.js';
import { StreamAuthorization } from '../../../src/control-plane/streams/authorization.js';
import { mutateOwnerState } from '../../../src/control-plane/state/runtime.js';
import { stageUpdate } from '../../../src/control-plane/state/rows.js';
import { runMigrations } from '../../../src/db/migrator.js';
import { agentSessions, hosts, versions } from '../../../src/db/schema.js';
import { sha256 } from '../../../src/security/hash.js';
import {
  createIsolatedTestDb,
  isolatedDbSetupTimeoutMs,
  isolatedDbTeardownTimeoutMs,
  readDbConfig,
} from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

describe.skipIf(!readDbConfig())('owner attachment recovery on MySQL', () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedTestDb>>;
  let owner: Awaited<ReturnType<typeof createOwnedControlPlane>> | undefined;
  let hostId: number, database: string, directory: string;
  const hostKey = randomUUID(), token = randomUUID(), receiver = randomUUID();
  const seen = new Date(Date.now() - 3 * 86_400_000).toISOString();
  let expires: string;
  const ttl = 15 * 60_000;
  beforeAll(async () => {
    fixture = await createIsolatedTestDb('recovery');
    expires = new Date(Date.now() + 10 * 60_000).toISOString();
    const [[row]] = await fixture.pool.query<RowDataPacket[]>('SELECT DATABASE() AS db');
    database = row!.db;
    directory = await mkdtemp(join(tmpdir(), 'attachment-owner-'));
    const [insert] = await fixture.db.insert(hosts).values({
      fqdn: 'attachment.fixture.test', apiKey: hostKey, secure: 1, engines: 'codex', status: 'active',
      createdAt: seen, updatedAt: seen,
    });
    hostId = insert.insertId;
    await fixture.db.insert(versions).values({ name: 'agent_messaging_enabled', version: '1', updatedAt: seen })
      .onDuplicateKeyUpdate({ set: { version: '1' } });
  }, isolatedDbSetupTimeoutMs);
  afterEach(async () => {
    await owner?.close();
    owner = undefined;
    if (fixture && hostId) await fixture.db.delete(agentSessions).where(eq(agentSessions.hostId, hostId));
  });
  afterAll(async () => {
    await fixture?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, isolatedDbTeardownTimeoutMs);
  const start = async () => {
    owner = await createOwnedControlPlane({
      pool: fixture.pool, handle: {}, keyring: testKeyring(),
      env: { ...loadTestEnv(), DATA_ROOT: directory, DB_DATABASE: database },
      error: (cause) => { throw cause; },
    });
    return owner;
  };
  const seed = async (patch: Partial<typeof agentSessions.$inferInsert> = {}) => {
    const id = randomUUID();
    await fixture.db.insert(agentSessions).values({
      id, hostId, username: 'fixture', cwd: '/fixture', engine: 'codex', invocationKind: 'interactive',
      status: 'active', hostAuthFingerprint: sha256(hostKey), bridgeTokenHash: sha256(token),
      bindingGeneration: 3, bridgeExpiresAt: expires, startedAt: seen, heartbeatAt: seen, createdAt: seen,
      updatedAt: seen, adapterCapabilities: { suspend_recovery_version: 1 },
      receiver: { generation: receiver, probes: {}, heartbeat_at: seen }, ...patch,
    });
    return id;
  };
  const persisted = async (id: string) => {
    const [row] = await fixture.db.select().from(agentSessions).where(eq(agentSessions.id, id));
    return row!;
  };
  const provider = () => {
    const runtime = owner!.runtime;
    const auth = new StreamAuthorization(runtime, hostId, requestHost(runtime.state.snapshot().hosts.get(hostId)!, hostKey));
    return new OwnerStateProvider(runtime, auth, randomUUID(), 'fixture');
  };
  const open = (id: string, topic: 'session' | 'receiver' = 'session', bridgeToken = token, generation = 3) =>
    provider().open({ topic, session_id: id, binding_generation: generation,
      ...(topic === 'receiver' ? { receiver_generation: receiver } : {}) }, { bridge_token: bridgeToken });

  it('persists the first attachment before publication, ignores other streams and stamps the final detach', async () => {
    const id = await seed(), boot = await start();
    await expect(open(id, 'session', randomUUID())).rejects.toThrow();
    await expect(open(id, 'session', token, 2)).rejects.toThrow();
    expect((await persisted(id)).suspendAttachmentGeneration).toBeNull();
    const first = await open(id);
    expect(await persisted(id)).toMatchObject({ suspendAttachmentGeneration: 3, suspendRecoveryUntil: null, heartbeatAt: seen });
    const rev = boot.runtime.state.revision();
    const second = await open(id, 'receiver');
    expect(boot.runtime.state.revision()).toEqual(rev);
    expect(sessionAbandonDueAt(boot.runtime, boot.runtime.state.snapshot(), id, ttl)).toBeNull();
    expect(livenessDueAt(boot.runtime, boot.runtime.state.snapshot(), ttl)).toBeNull();
    await first.detach();
    expect((await persisted(id)).suspendAttachmentGeneration).toBe(3);
    expect(boot.runtime.state.revision()).toEqual(rev);
    const before = Date.now();
    await second.detach();
    await sessionAttachmentTransition(boot.runtime, id);
    const row = await persisted(id), at = Date.parse(row.heartbeatAt);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
    expect(row).toMatchObject({ suspendAttachmentGeneration: null, suspendRecoveryUntil: null });
    expect(sessionAbandonDueAt(boot.runtime, boot.runtime.state.snapshot(), id, ttl)).toBe(at + SUSPEND_RECOVERY_GRACE_MS);
    await boot.close();
    await start();
    expect(await persisted(id)).toMatchObject({ heartbeatAt: row.heartbeatAt, suspendRecoveryUntil: null });
  });

  it('consumes a committed attachment once after loss before the first snapshot, independent of authorization', async () => {
    const id = await seed(), old = await start();
    await open(id);
    old.ownership.lose(new Error('abrupt owner loss before first snapshot'));
    await old.close();
    const before = Date.now(), next = await start(), row = await persisted(id);
    const until = Date.parse(row.suspendRecoveryUntil!);
    expect(until).toBeGreaterThanOrEqual(before + SUSPEND_RECOVERY_GRACE_MS);
    expect(until).toBeLessThanOrEqual(Date.now() + SUSPEND_RECOVERY_GRACE_MS);
    expect(row.heartbeatAt).toBe(seen);
    const snap = next.runtime.state.snapshot();
    expect(sessionAttached(next.runtime, snap, id)).toBe(false);
    expect(sessionAbandonDueAt(next.runtime, snap, id, ttl)).toBe(until);
    expect(ownedCredentialDeadline(snap, 'session', id)).toBe(Date.parse(expires));
    await expect(open(id, 'session', randomUUID())).rejects.toThrow();
    await next.close();
    await start();
    expect((await persisted(id)).suspendRecoveryUntil).toBe(row.suspendRecoveryUntil);
    // A new proven connection replaces the spent window; orderly shutdown records a real disconnect.
    await open(id);
    expect((await persisted(id)).suspendRecoveryUntil).toBeNull();
    await owner!.close();
    const closed = await persisted(id);
    expect(closed.suspendAttachmentGeneration).toBeNull();
    expect(Date.parse(closed.heartbeatAt)).toBeGreaterThan(Date.parse(seen));
  });

  it('refuses the first stream when its durable marker fails and never opens a window from that failure', async () => {
    const id = await seed(), boot = await start();
    await fixture.pool.query(`CREATE TRIGGER fail_session_marker BEFORE UPDATE ON agent_sessions
      FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test marker write unavailable'`);
    try {
      await expect(open(id)).rejects.toThrow();
      expect(boot.ownership.status()).toBe('lost');
      expect(await persisted(id)).toMatchObject({ suspendAttachmentGeneration: null, suspendRecoveryUntil: null });
    } finally {
      await fixture.pool.query('DROP TRIGGER fail_session_marker');
    }
    await boot.close();
    await start();
    expect((await persisted(id)).suspendRecoveryUntil).toBeNull();
  });

  it('never opens another grace on a restart after the consumed deadline or restores a credential', async () => {
    const deadline = Date.now() - 60_000;
    const id = await seed({ suspendAttachmentGeneration: 3, suspendRecoveryUntil: new Date(deadline).toISOString(),
      bridgeExpiresAt: seen });
    const boot = await start(), snapshot = boot.runtime.state.snapshot();
    expect(sessionAbandonDueAt(boot.runtime, snapshot, id, ttl)).toBe(deadline);
    expect(ownedCredentialDeadline(snapshot, 'session', id)).toBe(Date.parse(seen));
    await expect(open(id, 'session', randomUUID())).rejects.toThrow();
    expect(sessionAttached(boot.runtime, snapshot, id)).toBe(false);
  });

  it('ignores an old-generation detach while a new generation has a proven stream', async () => {
    const id = await seed(), boot = await start(), old = await open(id);
    await mutateOwnerState(boot.runtime, {
      kind: 'test.binding.change', payload: { id }, prepare(ctx) {
        stageUpdate(ctx, 'agentSessions', id, { bindingGeneration: 4 });
        return null;
      },
    });
    const next = await open(id, 'session', token, 4);
    await old.detach();
    expect(await persisted(id)).toMatchObject({ suspendAttachmentGeneration: 4, suspendRecoveryUntil: null });
    await next.detach();
    expect((await persisted(id)).suspendAttachmentGeneration).toBeNull();
  });

  it('replays 0148 from either individually committed ALTER and preserves existing sessions', async () => {
    const id = await seed();
    for (const missing of ['suspend_attachment_generation', 'suspend_recovery_until']) {
      await fixture.pool.query('DELETE FROM schema_migrations WHERE version = ?', ['0148']);
      await fixture.pool.query('ALTER TABLE agent_sessions DROP COLUMN ??', [missing]);
      const result = await runMigrations(fixture.pool);
      expect(result.outcomes.map(row => row.version)).toEqual(['0148']);
      expect(await persisted(id)).toMatchObject({ heartbeatAt: seen, suspendAttachmentGeneration: null, suspendRecoveryUntil: null });
      expect((await runMigrations(fixture.pool)).outcomes).toHaveLength(0);
    }
  });

  it('discards stale-generation, finished, closing, reboot and unsupported markers without reviving a session', async () => {
    const stale = await seed({ suspendAttachmentGeneration: 2 });
    const ended = await seed({ endedAt: seen, status: 'failed', suspendAttachmentGeneration: 3 });
    const reboot = await seed({ status: 'reboot_wait', suspendAttachmentGeneration: 3 });
    const closing = await seed({ closeRequestedAt: seen, suspendAttachmentGeneration: 3 });
    const legacy = await seed({ adapterCapabilities: null, suspendAttachmentGeneration: 3 });
    const headless = await seed({ invocationKind: 'execute', suspendAttachmentGeneration: 3 });
    const fresh = await seed();
    const gone = await start();
    for (const id of [stale, ended, reboot, closing, legacy, headless, fresh]) {
      expect(await persisted(id)).toMatchObject({ suspendAttachmentGeneration: null, suspendRecoveryUntil: null, heartbeatAt: seen });
    }
    for (const id of [ended, reboot])
      expect(sessionAbandonDueAt(gone.runtime, gone.runtime.state.snapshot(), id, ttl)).toBeNull();
  });
});
