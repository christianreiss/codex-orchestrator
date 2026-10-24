import { ConnectionPresence, bindOwnerPresence } from '../src/control-plane/presence.js';
import { trackHostActivity, stopHostActivity } from '../src/control-plane/state/host-activity.js';
import { createInsecureWindowService, insecureWindowActiveAt } from '../src/services/insecure-window.js';
import { InsecureWindowAdminService } from '../src/services/insecure-window-admin.js';
import { requestHost } from '../src/control-plane/state/admission.js';
import { admissionInterestAt } from '../src/control-plane/state/admission-interest.js';
import { HostManagementService } from '../src/services/host-management.js';
import { ClientConfigService } from '../src/services/client-config.js';
import { ModelDefaultsService } from '../src/services/model-defaults.js';
import { loadTestEnv, testKeyring } from './helpers/test-keyring.js';
import { makeAdminEventsWriter } from '../src/services/admin-events-writer.js';
import { projectHostDeletion, projectAdminUserDeletion } from '../src/control-plane/state/deletion.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import * as schema from '../src/db/schema.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { CommandExecutor } from '../src/control-plane/commands.js';
import type { PersistenceTransaction } from '../src/control-plane/persistence.js';
import { DeadlineQueue } from '../src/control-plane/deadlines.js';
import {
  OwnerStateSnapshot,
  OwnerStateStore,
  type PreparedOwnerState,
} from '../src/control-plane/state/store.js';
import { bindOwnerRuntime, mutateOwnerState, type OwnerRuntime } from '../src/control-plane/state/runtime.js';
import type { StateSeed } from '../src/control-plane/state/catalog.js';
import { createHostAuthService } from '../src/services/host-auth.js';
import { hostAuthFingerprint } from '../src/services/agent-messaging/internals.js';
import { readFleetEngineState, setFleetEngineEnabled } from '../src/services/engine-switch.js';
import { pruneHosts } from '../src/services/host-lifecycle.js';
import { stageHostRegistration } from '../src/control-plane/state/host-registration.js';
import { SettingsService } from '../src/services/settings.js';
import { createDbFake } from './helpers/db-fake.js';
import { sha256 } from '../src/security/hash.js';

const key = 'sk-codex-owner-fixture';
const epoch = '12345678-1234-1234-1234-123456789012';
const queues: DeadlineQueue[] = [];
const closes: Array<() => void> = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
  for (const queue of queues.splice(0)) queue.close();
});
function host(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: 1,
    fqdn: 'fixture.example.test',
    apiKey: key,
    apiKeyHash: null,
    apiKeyEnc: null,
    status: 'active',
    secure: 1,
    allowRoamingIps: 0,
    reverseDnsMode: 0,
    ip4: '203.0.113.5',
    ip6: null,
    insecureEnabledUntil: null,
    insecureGraceUntil: null,
    expiresAt: null,
    internalRole: null,
    lastContactAt: now,
    createdAt: now,
    updatedAt: now,
    engines: 'codex,claude,grok',
    configVersion: 1,
    apiCalls: 1,
    ...overrides,
  };
}
function harness(seed: Record<string, Record<string, unknown>[]> = {}) {
  const fake = createDbFake(
    new Map(
      Object.entries(seed).map(([name, rows]) => [
        (schema as unknown as Record<string, unknown>)[name],
        structuredClone(rows),
      ]),
    ),
  );
  const db = fake as unknown as Database;
  const select = vi.spyOn(fake, 'select');
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch, sequence: 0n }, seed as StateSeed));
  const deadlines = new DeadlineQueue((error) => {
    throw error;
  });
  queues.push(deadlines);
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state,
    assertOwner() {},
    loseOwner(error) {
      throw error;
    },
    committed() {},
    notificationError(error) {
      throw error;
    },
    persistence: {
      async receipt() {
        return undefined;
      },
      async transaction(run) {
        await run(fake as unknown as PersistenceTransaction);
      },
      async record() {},
    },
  });
  const runtime: OwnerRuntime = {
    state,
    deadlines,
    assertOwner() {},
    execute: (command) => executor.execute(command),
  };
  bindOwnerRuntime(db, runtime);
  const presence = new ConnectionPresence((error) => {
    throw error;
  });
  bindOwnerPresence(runtime, presence);
  trackHostActivity(runtime);
  closes.push(() => {
    stopHostActivity(runtime);
    presence.close();
  });
  const env = { AUTH_RUNNER_BYPASS_SUBNETS: '', AUTH_RUNNER_IP_BYPASS: false } as Env;
  const auth = createHostAuthService({ db, env });
  const req = (ip = '203.0.113.5') =>
    ({
      headers: { 'x-api-key': key },
      clientIp: ip,
      method: 'POST',
      log: { warn: vi.fn() },
    }) as unknown as FastifyRequest;
  return { db, fake, select, state, runtime, auth, req, presence };
}

describe('owned host admission and cross-domain engine suspension', () => {
  it('retains a connected idle host but honors its absolute expiry', async () => {
    const old = '2000-01-01T00:00:00Z';
    const h = harness({ hosts: [host({ lastContactAt: old, createdAt: old })] });
    h.presence.attach({
      connectionId: 'fixture',
      hostId: 1,
      username: 'root',
      scope: { topic: 'daemon', native_instance_id: 'fixture' },
    });
    expect(await pruneHosts(h.db)).toBe(0);
    await mutateOwnerState(h.runtime, {
      kind: 'fixture.expire',
      payload: {},
      prepare: (ctx) => {
        const row = ctx.snapshot.hosts.get(1)!;
        ctx.draft.upsert('hosts', { ...row, expiresAt: old });
        return null;
      },
    });
    expect(await pruneHosts(h.db)).toBe(1);
  });

  it('preserves legacy fingerprint while admitting from RAM without SQL', async () => {
    const h = harness({ hosts: [host()] });
    const current = await h.auth.authenticate(h.req(), { checkApiDisabled: true });
    expect(current.apiKeyHash).toBeNull();
    expect(hostAuthFingerprint(current)).toBe(sha256(key));
    expect(h.state.snapshot().hosts.get(1)?.authFingerprint).toBe(sha256(key));
    expect(h.state.snapshot().hosts.by('credentialLookupHash', sha256(key))).toHaveLength(1);
    expect(h.select).not.toHaveBeenCalled();
    expect(h.fake.updates).toHaveLength(0);
  });

  it('preserves hashed-host fingerprint without storing the presented key', async () => {
    const h = harness({ hosts: [host({ apiKey: sha256(key), apiKeyHash: sha256(key) })] });
    const current = await h.auth.authenticate(h.req());
    expect(hostAuthFingerprint(current)).toBe(sha256(sha256(key)));
    expect(h.state.snapshot().hosts.get(1)?.authFingerprint).toBe(sha256(sha256(key)));
    expect(h.state.snapshot().hosts.get(1)).not.toHaveProperty('apiKey');
  });

  it('allows only one competing initial IP binding', async () => {
    const h = harness({ hosts: [host({ ip4: null })] });
    const outcomes = await Promise.allSettled([
      h.auth.authenticate(h.req('203.0.113.5')),
      h.auth.authenticate(h.req('203.0.113.6')),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(h.state.snapshot().hosts.get(1)?.ip4).toBe('203.0.113.5');
    expect(h.select).not.toHaveBeenCalled();
  });

  it('applies the API kill switch from its committed owner state', async () => {
    const h = harness({
      hosts: [host()],
      versions: [{ name: 'api_disabled', version: '0', updatedAt: new Date().toISOString() }],
    });
    await new SettingsService(h.db).setFlag('api_disabled', true);
    await expect(h.auth.authenticate(h.req(), { checkApiDisabled: true })).rejects.toThrow('API disabled');
    expect(h.select).not.toHaveBeenCalled();
  });

  it('suspends the selected engine across work, bindings, conferences and names in one publication', async () => {
    const h = harness({
      hosts: [host()],
      agentBusAddresses: [
        { id: 'a', hostId: 1, engine: 'codex', currentSessionId: 's', bindingGeneration: 7 },
        { id: 'other', hostId: 1, engine: 'claude', currentSessionId: 'other-session', bindingGeneration: 2 },
      ],
      agentSessions: [
        {
          id: 's',
          hostId: 1,
          agentBusAddressId: 'a',
          bindingGeneration: 7,
          endedAt: null,
          bridgeExpiresAt: '2099-01-01T00:00:00Z',
        },
      ],
      agentBusMessages: [
        { id: 'queued', senderAddressId: 'a', targetAddressId: 'other', status: 'queued' },
        { id: 'accepted', senderAddressId: 'other', targetAddressId: 'a', status: 'accepted' },
      ],
      agentBusConversations: [{ id: 'conversation', addressAId: 'a', addressBId: 'other', status: 'open' }],
      agentBusConferences: [{ id: 'room', ownerAddressId: 'a', status: 'open', pin: '1234' }],
      agentBusConferenceMembers: [
        { id: 'member', addressId: 'a', state: 'dispatched', dispatchMessageId: 'queued' },
      ],
      agentNameLeases: [{ id: 1, sessionId: 's', endedAt: null }],
      agentBusRelays: [{ id: 'relay', hostId: 1, status: 'active' }],
    });
    const seen: string[] = [];
    h.state.subscribe((snapshot) => {
      seen.push(String(snapshot.setting('codex_engine_disabled')));
      expect(snapshot.messages.get('accepted')?.status).toBe('ambiguous');
    });
    const result = await setFleetEngineEnabled(h.db, 'codex', false, 'fixture');
    expect(result.hosts_suspended).toBe(1);
    expect(seen).toEqual(['1']);
    expect((await readFleetEngineState(h.db)).codex).toBe(false);
    expect(h.state.snapshot().messages.get('queued')?.status).toBe('canceled');
    expect(h.state.snapshot().addresses.get('a')?.bindingGeneration).toBe(8);
    expect(h.state.snapshot().addresses.get('other')?.bindingGeneration).toBe(2);
    expect(h.state.snapshot().table('agentBusConferences').get('room')?.pin).toBeNull();
    expect(h.state.snapshot().table('agentNameLeases').get(1)?.cooldownUntil).toBeTruthy();
    expect(h.state.snapshot().table('agentBusRelays').get('relay')?.status).toBe('active');
    expect(h.select).not.toHaveBeenCalled();
  });

  it('uses explicit registration grace, then prunes an actually expired host with relay revocation', async () => {
    const old = '2020-01-01T00:00:00Z';
    const h = harness({
      hosts: [host({ createdAt: old, lastContactAt: old })],
      agentBusRelays: [{ id: 'relay', hostId: 1, status: 'active' }],
    });
    await mutateOwnerState(h.runtime, {
      kind: 'fixture.rotation',
      payload: {},
      prepare(ctx) {
        stageHostRegistration(ctx, 1, 'host.rotated', {});
        return null;
      },
    });
    expect(await pruneHosts(h.db)).toBe(0);
    await mutateOwnerState(h.runtime, {
      kind: 'fixture.expire',
      payload: {},
      prepare(ctx) {
        const row = ctx.draft.table('hosts').get(1)!;
        ctx.draft.upsert('hosts', { ...row, expiresAt: old });
        return null;
      },
    });
    expect(await pruneHosts(h.db)).toBe(1);
    expect(h.state.snapshot().hosts.size).toBe(0);
    expect(h.state.snapshot().table('agentBusRelays').get('relay')?.status).toBe('revoked');
    expect(h.select).not.toHaveBeenCalled();
  });
});

describe('owner SQL foreign-key projections', () => {
  it('removes daemon children and clears provenance when a host is deleted', async () => {
    const h = harness({
      hosts: [host()],
      hostDaemonSessions: [{ id: 'daemon', hostId: 1 }],
      hostDaemonOperations: [{ id: 'operation', hostId: 1, sessionId: 'daemon' }],
      hostDaemonPortalBindings: [{ daemonSessionId: 'daemon', portalSessionId: 'portal' }],
      companionDaemonFollows: [{ deviceId: 'device', daemonSessionId: 'daemon' }],
      sharedMemories: [{ id: 1, sourceHostId: 1 }],
      secrets: [{ id: 1, sourceHostId: 1 }],
    });
    const draft = h.state.begin();
    projectHostDeletion(draft, 1);
    expect(draft.table('hostDaemonSessions').size).toBe(0);
    expect(draft.table('hostDaemonOperations').size).toBe(0);
    expect(draft.table('hostDaemonPortalBindings').size).toBe(0);
    expect(draft.table('companionDaemonFollows').size).toBe(0);
    expect(draft.table('sharedMemories').get(1)?.sourceHostId).toBeNull();
    expect(draft.table('secrets').get(1)?.sourceHostId).toBeNull();
  });
  it('removes chatty state only for the deleted administrator', () => {
    const h = harness({
      chattySessions: [
        { id: 'mine', userId: 1 },
        { id: 'other', userId: 2 },
      ],
      chattyRuns: [{ id: 'run', userId: 1 }],
      chattyActions: [{ id: 'action', userId: 1 }],
    });
    const draft = h.state.begin();
    projectAdminUserDeletion(draft, 1);
    expect(
      draft
        .table('chattySessions')
        .all()
        .map((row) => row.userId),
    ).toEqual([2]);
    expect(draft.table('chattyRuns').size).toBe(0);
    expect(draft.table('chattyActions').size).toBe(0);
  });
});

describe('owned host management and configuration', () => {
  it('registers, rotates and deletes with atomic authentication projections and no discovery SQL', async () => {
    const h = harness();
    const service = new HostManagementService({
      db: h.db,
      env: loadTestEnv(),
      keyring: testKeyring(),
      events: makeAdminEventsWriter(h.db),
    });
    const created = await service.register({ fqdn: 'new.owner.test', secure: true, engines: ['codex'] });
    expect(created.host.id).toBeGreaterThan(0);
    expect(h.state.snapshot().hosts.get(created.host.id)?.credentialLookupHash).toBe(
      sha256(created.apiKeyPlain),
    );
    const rotated = await service.register({ fqdn: 'new.owner.test', secure: true, engines: ['codex'] });
    expect(rotated.apiKeyPlain).not.toBe(created.apiKeyPlain);
    expect(h.state.snapshot().hosts.get(created.host.id)?.authFingerprint).toBe(
      sha256(sha256(rotated.apiKeyPlain)),
    );
    await service.setVip(created.host.id, true);
    expect(h.state.snapshot().hosts.get(created.host.id)?.vip).toBe(1);
    await service.delete(created.host.id);
    expect(h.state.snapshot().hosts.get(created.host.id)).toBeUndefined();
    expect(h.select).not.toHaveBeenCalled();
  });
  it('initializes Grok defaults once, renders its owner head and rejects stale config edits', async () => {
    const h = harness();
    const defaults = new ModelDefaultsService(h.db);
    const config = new ClientConfigService(h.db);
    const results = await Promise.all([defaults.ensureGrokDefaults(), defaults.ensureGrokDefaults()]);
    expect(results.sort()).toEqual([false, true]);
    const saved = await config.adminFetch('grok');
    expect(saved.status).toBe('ok');
    expect(saved.content).toContain('grok');
    await expect(
      config.store({ settings: saved.settings, expected_revision: null }, null, 'grok'),
    ).rejects.toThrow('Configuration changed');
    expect(h.state.snapshot().table('clientConfigDocuments').size).toBe(1);
    expect(h.select).not.toHaveBeenCalled();
  });
});

describe('owned insecure access state machine', () => {
  it('keeps repeated waiting activity volatile without command receipts or SQL', async () => {
    const h = harness({ hosts: [host({ secure: 0 })] });
    const windows = createInsecureWindowService({ db: h.db, env: loadTestEnv() });
    const command = vi.spyOn(h.runtime, 'execute');
    const authenticated = requestHost(h.state.snapshot().hosts.get(1)!, key);
    await expect(windows.enforce(authenticated, 'retrieve')).rejects.toThrow('pending');
    const request = h.state.snapshot().table('insecureAuthRequests').by('hostId', 1)[0]!;
    const count = command.mock.calls.length;
    const updates = h.fake.updates.length;
    for (let index = 0; index < 10; index++)
      await expect(windows.enforce(authenticated, 'retrieve')).rejects.toThrow('pending');
    expect(admissionInterestAt(h.runtime, request.id)).toBeTypeOf('number');
    expect(command).toHaveBeenCalledTimes(count);
    expect(h.fake.updates).toHaveLength(updates);
    expect(h.select).not.toHaveBeenCalled();
    expect(h.state.snapshot().table('insecureAuthRequests').get(request.id)?.updatedAt).toBe(
      request.updatedAt,
    );
  });
  it('applies fleet open and panic close atomically including domain grants', async () => {
    const now = new Date().toISOString();
    const h = harness({
      hosts: [host({ secure: 0 })],
      insecureAuthRequests: [
        {
          id: 1,
          hostId: 1,
          status: 'pending',
          requestIp: null,
          requestedAt: now,
          updatedAt: now,
          resolvedAt: null,
          engine: 'codex',
        },
      ],
      insecureDomainAllows: [
        {
          id: 1,
          domain: 'example.test',
          windowMinutes: 10,
          enabledUntil: null,
          revokedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const service = new InsecureWindowAdminService({
      db: h.db,
      env: loadTestEnv(),
      events: makeAdminEventsWriter(h.db),
    });
    const revisions: string[] = [];
    h.state.subscribe(() => revisions.push(h.state.revision().sequence.toString()));
    await service.openFleetWindow(10);
    expect(revisions).toHaveLength(1);
    expect(h.state.snapshot().table('insecureAuthRequests').get(1)?.status).toBe('approved');
    await service.closeFleetWindow('manual');
    expect(revisions).toHaveLength(2);
    expect(h.state.snapshot().setting('insecure_fleet_window_until')).toBeNull();
    expect(h.state.snapshot().hosts.get(1)?.insecureSessionRenewalBlocked).toBe(1);
    expect(
      Date.parse(h.state.snapshot().table('insecureDomainAllows').get(1)!.enabledUntil!),
    ).toBeLessThanOrEqual(Date.now());
    expect(h.select).not.toHaveBeenCalled();
  });
  it('rejects a grant at its exact expiry', () => {
    const now = Date.now();
    expect(insecureWindowActiveAt({ insecureEnabledUntil: new Date(now) }, now)).toBe(false);
  });
});
