import { authorizeAgentInsecureEnable } from '../../../src/control-plane/streams/insecure-enable.js';
import { InsecureWindowAdminService } from '../../../src/services/insecure-window-admin.js';
import { makeAdminEventsWriter } from '../../../src/services/admin-events-writer.js';
import type { Env } from '../../../src/env.js';
import { mutateOwnerState } from '../../../src/control-plane/state/runtime.js';
import { stageUpdate } from '../../../src/control-plane/state/rows.js';
import { recordAuthCall, flushAuthCalls, uninstallOwnedHost } from '../../../src/routes/auth/owner.js';
import type { Database } from '../../../src/db/client.js';
import { sha256 } from '../../../src/security/hash.js';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it, expect, vi } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import {
  OwnerStateSnapshot,
  OwnerStateStore,
  type PreparedOwnerState,
} from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { RebootHandoffs } from '../../../src/services/reboot-handoffs.js';
import { expireRebootHandoffs } from '../../../src/services/reboot-handoffs/binding.js';
import { approveOwnedFreshStart } from '../../../src/services/agent-messaging/task-execution.js';
const queues: DeadlineQueue[] = [];
afterEach(() => queues.splice(0).forEach((q) => q.close()));
function harness(rows: Record<string, Record<string, unknown>[]> = {}) {
  const now = new Date().toISOString();
  const seed = {
    providerAccounts: [
      {
        id: 1,
        engine: 'codex',
        state: 'enabled',
        payloadId: 1,
        lastSelectedAt: null,
        mergedIntoAccountId: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    authPayloads: [{ id: 1, engine: 'codex', accountId: 1, verificationState: 'verified' }],
    ...rows,
  };
  const db = createDbFake(
    new Map(
      Object.entries(seed).map(([name, values]) => [
        (schema as unknown as Record<string, unknown>)[name],
        structuredClone(values),
      ]),
    ),
  );
  const state = new OwnerStateStore(
    new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed as unknown as StateSeed),
  );
  const deadlines = new DeadlineQueue((e) => {
    throw e;
  });
  queues.push(deadlines);
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state,
    assertOwner() {},
    loseOwner(e) {
      throw e;
    },
    committed() {},
    notificationError(e) {
      throw e;
    },
    persistence: {
      async receipt() {
        return undefined;
      },
      async transaction(run) {
        await run(db as unknown as PersistenceTransaction);
      },
      async record() {},
    },
  });
  const owner: OwnerRuntime = {
    state,
    deadlines,
    assertOwner() {},
    execute: (command) => executor.execute(command),
  };
  const select = vi.spyOn(db, 'select');
  bindOwnerRuntime(db, owner);
  return { owner, state, db, select };
}

function fixture(engine: string) {
  const now = new Date().toISOString(),
    sessionId = randomUUID(),
    addressId = randomUUID(),
    id = randomUUID(),
    messageId = randomUUID(),
    claimId = randomUUID();
  const row = {
    id,
    hostId: 1,
    activeHostId: 1,
    addressId,
    oldSessionId: sessionId,
    newSessionId: null,
    engine,
    username: 'root',
    cwd: '/tmp',
    nativeSessionId: 'native',
    bootId: randomUUID(),
    resumeBootId: null,
    requestSha: 'hash',
    reason: 'approved reboot',
    status: 'prepared',
    busMessageIds: [],
    portalMessageIds: [],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: now,
    updatedAt: now,
  };
  const h = harness({
    agentRebootHandoffs: [row],
    agentSessions: [
      {
        id: sessionId,
        hostId: 1,
        engine,
        endedAt: null,
        closeRequestedAt: null,
        upstreamSessionId: 'native',
        activeTurnId: null,
        agentBusAddressId: addressId,
        bindingGeneration: 1,
        bridgeTokenHash: sha256('test-token'),
        hostAuthFingerprint: sha256('host-key'),
        bridgeExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        adapterCapabilities: { reboot_protocol_version: 1 },
        username: 'root',
        cwd: '/tmp',
      },
    ],
    agentBusAddresses: [
      {
        id: addressId,
        hostId: 1,
        engine,
        currentSessionId: sessionId,
        enabled: 1,
        archivedAt: null,
        bindingGeneration: 1,
        lastUpstreamSessionId: 'native',
      },
    ],
    agentBusMessages: [
      {
        id: messageId,
        targetAddressId: addressId,
        status: 'accepted',
        claimId,
        leaseOwner: `session:${sessionId}`,
        deliverySessionId: sessionId,
        cancelRequestedAt: null,
        ownershipMode: 'connection',
        leaseUntil: null,
        executionVersion: 1,
        workKind: 'request',
        kind: 'message',
      },
    ],
    hosts: [
      {
        id: 1,
        secure: 1,
        status: 'active',
        engines: engine,
        expiresAt: null,
        apiKeyHash: 'host-key',
        authFingerprint: sha256('host-key'),
      },
    ],
    versions: [{ name: 'agent_messaging_enabled', version: '1' }],
  });
  return {
    ...h,
    row,
    sessionId,
    addressId,
    id,
    messageId,
    claimId,
    service: new RebootHandoffs(h.db as unknown as Database, testKeyring()),
  };
}
describe('owned reboot and replacement lifecycle', () => {
  it('prepare authenticates the current bridge and keeps retry content out of metadata', async () => {
    const h = fixture('grok'),
      draft = h.state.begin();
    draft.remove('agentRebootHandoffs', h.id);
    h.state.publish(draft.seal({ epoch: h.state.snapshot().revision.epoch, sequence: 1n }));
    const input = {
      request_id: h.id,
      boot_id: randomUUID(),
      reason: 'operator requested',
      continuation: 'resume exact accepted work',
    };
    await expect(h.service.prepare(h.sessionId, 'bad-token', input)).rejects.toThrow(
      'Invalid agent bridge credential',
    );
    const result = await h.service.prepare(h.sessionId, 'test-token', input);
    expect(result).toMatchObject({ request_id: h.id, continuation: input.continuation });
    expect(await h.service.prepare(h.sessionId, 'test-token', input)).toEqual(result);
    await expect(
      h.service.prepare(h.sessionId, 'test-token', { ...input, continuation: 'different' }),
    ).rejects.toThrow('Request ID reused');
    expect(h.state.snapshot().table('agentRebootHandoffs').get(h.id)).not.toHaveProperty('continuationEnc');
    expect(h.select).not.toHaveBeenCalled();
  });
  for (const engine of ['codex', 'claude', 'grok'])
    it(`${engine}: arm preserves claims; finish records uncertainty without requeue; reads use RAM`, async () => {
      const h = fixture(engine);
      await h.service.arm(h.sessionId, h.id);
      expect(h.state.snapshot().table('agentBusMessages').get(h.messageId)).toMatchObject({
        status: 'reboot_hold',
        claimId: h.claimId,
        leaseUntil: null,
      });
      await h.service.status(h.sessionId);
      await h.service.observe(1, h.id);
      await h.service.ready(1, h.id, randomUUID());
      await h.service.restore(h.sessionId);
      await h.service.finish(1, h.id, false);
      expect(h.state.snapshot().table('agentBusMessages').get(h.messageId)).toMatchObject({
        status: 'ambiguous',
        claimId: h.claimId,
        lastErrorCode: 'reboot_resume_without_result',
      });
      expect(h.select).not.toHaveBeenCalled();
    });
  it('disarm and deadline expiry never replay accepted work', async () => {
    const h = fixture('codex');
    await h.service.arm(h.sessionId, h.id);
    await h.service.disarm(1, h.id);
    expect(h.state.snapshot().table('agentBusMessages').get(h.messageId)?.status).toBe('ambiguous');
    expect(h.state.snapshot().table('agentRebootHandoffs').get(h.id)?.status).toBe('disarmed');
    expect(h.select).not.toHaveBeenCalled();
    const other = fixture('grok');
    await other.service.arm(other.sessionId, other.id);
    await expireRebootHandoffs(
      other.db as unknown as Database,
      new Date(Date.now() + 90000000).toISOString(),
    );
    expect(other.state.snapshot().table('agentRebootHandoffs').get(other.id)?.status).toBe('expired');
    expect(other.state.snapshot().table('agentBusMessages').get(other.messageId)?.claimId).toBe(
      other.claimId,
    );
  });
  it('fresh-start rejects accepted work and grants one exact blocked execution', async () => {
    const h = fixture('claude');
    await expect(
      approveOwnedFreshStart(h.owner, h.messageId, 1, 'operator approved', 'admin:1'),
    ).rejects.toThrow('missing native transcript');
    await mutateOwnerState(h.owner, {
      kind: 'test.missing_transcript',
      payload: {},
      prepare: (c) => {
        stageUpdate(c, 'agentBusMessages', h.messageId, {
          status: 'ambiguous',
          lastErrorCode: 'native_transcript_missing',
        });
        return null;
      },
    });
    await approveOwnedFreshStart(h.owner, h.messageId, 1, 'operator approved', 'admin:1');
    expect(h.state.snapshot().table('agentBusMessages').get(h.messageId)).toMatchObject({
      status: 'queued',
      executionVersion: 2,
      claimId: null,
      ownerInstanceId: null,
    });
    await approveOwnedFreshStart(h.owner, h.messageId, 1, 'operator approved', 'admin:1');
    await expect(approveOwnedFreshStart(h.owner, h.messageId, 1, 'different', 'admin:1')).rejects.toThrow(
      'Message changed',
    );
    expect(h.select).not.toHaveBeenCalled();
  });
});

describe('owned host auth routes', () => {
  it('buffers counter writes and stays quiet after flushing dirty usage', async () => {
    const h = harness({ hosts: [{ id: 1, apiCalls: 3, apiKey: 'key', status: 'active' }] });
    const host = { id: 1, apiCalls: 3 } as schema.Host;
    const before = h.state.revision().sequence;
    for (let i = 0; i < 10; i++) expect(await recordAuthCall(h.db as unknown as Database, host)).toBe(4 + i);
    expect(h.state.revision().sequence).toBe(before);
    await flushAuthCalls(h.owner);
    expect(h.state.snapshot().hosts.get(1)?.apiCalls).toBe(13);
    const after = h.state.revision().sequence;
    await flushAuthCalls(h.owner);
    expect(h.state.revision().sequence).toBe(after);
    expect(h.select).not.toHaveBeenCalled();
  });
  it.each(['codex', 'claude', 'grok'] as const)(
    'uninstalls only %s and retains other-engine bindings',
    async (engine) => {
      const host = {
        id: 1,
        fqdn: 'fixture',
        apiKey: 'key',
        status: 'active',
        secure: 1,
        engines: 'codex,claude,grok',
      } as schema.Host;
      const h = harness({
        hosts: [host as unknown as Record<string, unknown>],
        hostAuthStates: ['codex', 'claude', 'grok'].map((e) => ({
          hostId: 1,
          engine: e,
          payloadId: 1,
          seenDigest: 'x',
          seenAt: 'now',
        })),
        hostAuthDigests: ['codex', 'claude', 'grok'].map((e, i) => ({ id: i + 1, hostId: 1, engine: e })),
        installTokens: ['codex', 'claude', 'grok'].map((e, i) => ({ id: i + 1, hostId: 1, engine: e })),
      });
      await uninstallOwnedHost(h.owner, host, engine, false);
      expect(h.state.snapshot().hosts.get(1)?.engines).toBe(
        ['codex', 'claude', 'grok'].filter((e) => e !== engine).join(','),
      );
      expect(h.state.snapshot().table('hostAuthStates').has([1, engine])).toBe(false);
      expect(h.state.snapshot().table('hostAuthStates').all()).toHaveLength(2);
      expect(h.state.snapshot().table('hostAuthDigests').all()).toHaveLength(2);
      expect(h.state.snapshot().table('installTokens').all()).toHaveLength(2);
      expect(h.select).not.toHaveBeenCalled();
    },
  );
  it('last-engine uninstall deletes host and fences rotated credentials', async () => {
    const host = {
        id: 1,
        fqdn: 'fixture',
        apiKey: 'key',
        status: 'active',
        secure: 1,
        engines: 'grok',
      } as schema.Host,
      h = harness({ hosts: [host as unknown as Record<string, unknown>] });
    await expect(uninstallOwnedHost(h.owner, { ...host, apiKey: 'stale' }, 'grok', false)).rejects.toThrow(
      'Host key changed',
    );
    await uninstallOwnedHost(h.owner, host, 'grok', false);
    expect(h.state.snapshot().hosts.has(1)).toBe(false);
  });
});

describe('agent insecure enable owner authorization', () => {
  function setup() {
    const h = fixture('codex'),
      draft = h.state.begin();
    draft.upsert('hosts', {
      ...h.state.snapshot().hosts.get(1)!,
      id: 2,
      secure: 0,
      insecureWindowMinutes: 10,
      insecureEnabledUntil: null,
    });
    h.state.publish(draft.seal({ epoch: h.state.snapshot().revision.epoch, sequence: 1n }));
    const db = h.db as unknown as Database;
    const service = new InsecureWindowAdminService({
      db,
      env: { INSECURE_GRACE_MINUTES: 5 } as Env,
      events: makeAdminEventsWriter(db),
    });
    const proof = {
      sessionId: h.sessionId,
      bridgeToken: 'test-token',
      bindingGeneration: 1,
      hostId: 1,
      addressId: h.addressId,
      targetHostId: 2,
    };
    const grant = () =>
      service.enable(
        2,
        10,
        { host_id: 1, agent_address: `agent:${h.addressId}`, session_id: h.sessionId },
        (snapshot) => authorizeAgentInsecureEnable(snapshot, proof),
      );
    return { ...h, grant, proof };
  }
  it('publishes the durable grant through one owner command without metadata SQL reads', async () => {
    const h = setup(),
      before = h.state.snapshot().revision.sequence;
    await h.grant();
    expect(h.state.snapshot().hosts.get(2)?.insecureEnabledUntil?.getTime()).toBeGreaterThan(Date.now());
    expect(h.state.snapshot().revision.sequence).toBe(before + 1n);
    expect(h.select).not.toHaveBeenCalled();
  });
  it.each(['caller_policy', 'target_policy', 'binding', 'key', 'ended'] as const)(
    'rejects %s changed while the command waits',
    async (kind) => {
      const h = setup();
      let release!: () => void, entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const change = mutateOwnerState(h.owner, {
        kind: 'test.concurrent_change',
        payload: {},
        async prepare(ctx) {
          entered();
          await gate;
          if (kind === 'caller_policy') stageUpdate(ctx, 'hosts', 1, { status: 'blocked' });
          if (kind === 'target_policy') stageUpdate(ctx, 'hosts', 2, { status: 'blocked' });
          if (kind === 'binding') stageUpdate(ctx, 'agentSessions', h.sessionId, { bindingGeneration: 2 });
          if (kind === 'key') stageUpdate(ctx, 'hosts', 1, { apiKeyHash: 'replacement-key' });
          if (kind === 'ended')
            stageUpdate(ctx, 'agentSessions', h.sessionId, { endedAt: new Date().toISOString() });
          return null;
        },
      });
      await ready;
      const result = h.grant();
      const rejected = expect(result).rejects.toThrow();
      release();
      await change;
      await rejected;
      expect(h.state.snapshot().hosts.get(2)?.insecureEnabledUntil).toBeNull();
    },
  );
});
