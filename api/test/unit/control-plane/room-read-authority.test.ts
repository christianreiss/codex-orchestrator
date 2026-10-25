import { createHash, randomUUID } from 'node:crypto';
import { vi, afterEach, describe, it, expect } from 'vitest';
import type { Database } from '../../../src/db/client.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { scopedDatabase } from '../../../src/db/fresh-read.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const close: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const stop of close.splice(0)) await stop();
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture(
  engine = 'codex',
  options: {
    disabled?: boolean;
    stale?: boolean;
    oldWrapper?: boolean;
    expired?: boolean;
    targetDisabled?: boolean;
    engineDisabled?: boolean;
  } = {},
) {
  const id = randomUUID(),
    address = randomUUID(),
    token = 'private-fixture-token';
  const now = new Date().toISOString();
  const seed = {
    versions: [
      { name: 'agent_messaging_enabled', version: options.disabled ? '0' : '1' },
      { name: 'workflows_enabled', version: '1' },
      { name: `${engine}_engine_disabled`, version: options.engineDisabled ? '1' : '0' },
    ],
    hosts: [
      {
        id: 1,
        fqdn: 'fixture',
        status: 'active',
        secure: 1,
        engines: 'codex,claude,grok',
        apiKey: 'fixture-host',
        expiresAt: null,
        insecureEnabledUntil: null,
        wrapperVersion: options.oldWrapper ? '0.1.0' : '0.9.129',
      },
    ],
    agentSessions: [
      {
        id,
        hostId: 1,
        username: 'fixture',
        engine,
        endedAt: null,
        expiresAt: null,
        agentBusAddressId: address,
        bindingGeneration: 1,
        bridgeTokenHash: hash(token),
        hostAuthFingerprint: hash('fixture-host'),
        bridgeExpiresAt: new Date(Date.now() + (options.expired ? -60_000 : 60_000)).toISOString(),
        launchName: 'Fixture',
        adapterCapabilities: { workflow_protocol_version: 2 },
      },
    ],
    agentBusAddresses: [
      {
        id: address,
        hostId: 1,
        engine,
        address: `agent:${address}`,
        enabled: options.targetDisabled ? 0 : 1,
        archivedAt: null,
        currentSessionId: id,
        bindingGeneration: options.stale ? 2 : 1,
        launchName: 'Fixture',
      },
    ],
    agentNamePool: [{ nameKey: 'fixture', name: 'Fixture', currentSessionId: id }],
    agentNameLeases: [
      {
        id: 1,
        sessionId: id,
        addressId: address,
        name: 'Fixture',
        nameKey: 'fixture',
        startedAt: now,
        endedAt: null,
        cooldownUntil: null,
      },
    ],
  };
  const raw = {
    select: vi.fn(() => {
      throw new Error('Unexpected SQL read');
    }),
    transaction: vi.fn(() => {
      throw new Error('Unexpected SQL transaction');
    }),
  };
  const db = scopedDatabase(raw) as unknown as Database;
  const deadlines = new DeadlineQueue((error) => {
    throw error;
  });
  close.push(() => deadlines.close());
  const owner: OwnerRuntime = {
    state: new OwnerStateStore(
      new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed as unknown as StateSeed),
    ),
    deadlines,
    assertOwner() {},
    execute: vi.fn(async () => {
      throw new Error('Unexpected owner write');
    }),
  };
  bindOwnerRuntime(db, owner);
  const ctx = { db, env: loadTestEnv(), keyring: testKeyring() };
  return {
    id,
    address,
    token,
    raw,
    owner,
    ctx,
    messaging: new AgentMessagingService(db, ctx.env, ctx.keyring),
  };
}

import { AgentRoomChat } from '../../../src/services/agent-room-chat/index.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { ConnectionPresence, bindOwnerPresence } from '../../../src/control-plane/presence.js';

import { withOwnerRequestScope, finalizeOwnerResponse } from '../../../src/control-plane/state/runtime.js';
function roomFixture(engine: string, count = 1, content = 'PRIVATE HISTORY') {
  const f = fixture(engine),
    roomId = randomUUID(),
    subId = randomUUID(),
    eventId = randomUUID();
  const presence = new ConnectionPresence(() => {});
  bindOwnerPresence(f.owner, presence);
  close.push(() => presence.close());
  function publish(action: (draft: ReturnType<typeof f.owner.state.begin>) => void) {
    const d = f.owner.state.begin();
    action(d);
    const old = f.owner.state.revision();
    f.owner.state.publish(d.seal({ ...old, sequence: old.sequence + 1n }));
  }
  publish((d) => {
    d.upsert('agentBusGroups', {
      id: roomId,
      slug: 'private-fixture',
      title: 'private',
      description: null,
      createdByAddressId: f.address,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    d.upsert('agentBusSubscriptions', {
      id: subId,
      topic: 'group:private-fixture',
      subscriberAddressId: f.address,
      createdAt: new Date().toISOString(),
    });
  });
  const service = new AgentRoomChat(f.ctx.db, f.ctx.env, f.ctx.keyring, f.messaging);
  let unblock!: () => void, reached!: () => void;
  const gate = new Promise<void>((r) => (unblock = r)),
    started = new Promise<void>((r) => (reached = r));
  let reads = 0;
  const row = {
    id: eventId,
    roomId,
    actor: 'admin:1',
    requestId: randomUUID(),
    createdAt: new Date().toISOString(),
    bodyEnc: encrypt(
      JSON.stringify({ name: 'operator', content, attachments: [], kind: 'chat' }),
      f.ctx.keyring,
    ),
  };
  f.raw.select = vi.fn(() => {
    const chain = {
      from() {
        return chain;
      },
      where() {
        return chain;
      },
      orderBy() {
        return chain;
      },
      limit() {
        return chain;
      },
      leftJoin() {
        return chain;
      },
      then(
        resolve: (rows: (typeof row)[]) => unknown,
        reject: (error: unknown) => unknown,
      ): Promise<unknown> {
        return (async () => {
          if (++reads === 1) {
            reached();
            await gate;
            return Array.from({ length: count }, () => ({ ...row, id: randomUUID() }));
          }
          return [];
        })().then(resolve, reject);
      },
    };
    return chain;
  }) as unknown as typeof f.raw.select;
  return {
    ...f,
    service,
    roomId,
    started,
    unblock: () => unblock(),
    revoke: () => publish((d) => d.remove('agentBusSubscriptions', subId)),
    actor: { sessionId: f.id, token: f.token },
  };
}
describe('private room history authority', () => {
  it.each(['codex', 'claude', 'grok'])(
    'rejects %s membership revocation during a cold read',
    async (engine) => {
      const f = roomFixture(engine),
        pending = f.service.read(f.actor, { room_id: f.roomId });
      await f.started;
      f.revoke();
      f.unblock();
      await expect(pending).rejects.toMatchObject({ status: 403 });
    },
  );
  it.each(['codex', 'claude', 'grok'])(
    'fences %s membership revocation at final response',
    async (engine) => {
      const f = roomFixture(engine);
      await withOwnerRequestScope(async () => {
        const pending = f.service.read(f.actor, { room_id: f.roomId });
        await f.started;
        f.unblock();
        const out = await pending;
        expect(out.events[0]?.content).toBe('PRIVATE HISTORY');
        f.revoke();
        expect(() => finalizeOwnerResponse(f.owner, out)).toThrow();
      });
    },
  );
});

it.each(['codex', 'claude', 'grok'])(
  'bounds %s room history by bytes without truncating events',
  async (engine) => {
    const content = 'x'.repeat(30000),
      f = roomFixture(engine, 40, content),
      pending = f.service.read(f.actor, { room_id: f.roomId, limit: 100 });
    await f.started;
    f.unblock();
    const out = await pending;
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(512 * 1024);
    expect(out.events.length).toBeGreaterThan(0);
    expect(out.events.length).toBeLessThan(40);
    expect(out.events.every((e) => e.content === content)).toBe(true);
    expect(out.next_before).not.toBeNull();
    const cursor = JSON.parse(Buffer.from(out.next_before!, 'base64url').toString());
    expect(cursor.id).toBe(out.events[0]!.id);
  },
);
