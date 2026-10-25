import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionCredentials, ownedCredentialDeadline } from '../../../src/control-plane/credentials.js';
import { ConnectionPresence } from '../../../src/control-plane/presence.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
import { ownedBridge, ownedRelay } from '../../../src/control-plane/state/messaging.js';
import type { OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import type { StateRow, StateSeed } from '../../../src/control-plane/state/catalog.js';
import { sha256 } from '../../../src/security/hash.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import * as schema from '../../../src/db/schema.js';
import { createDbFake } from '../../helpers/db-fake.js';

afterEach(() => vi.useRealTimers());
function harness(options: { expired?: boolean; insecureUntil?: number } = {}) {
  const epoch = randomUUID(),
    id = randomUUID(),
    token = 'bridge-token',
    errors = vi.fn();
  const seed: StateSeed = {
    versions: [{ name: 'agent_messaging_enabled', version: '1', updatedAt: '' }],
    hosts: [
      {
        id: 1,
        status: 'active',
        apiKeyHash: 'a'.repeat(64),
        engines: 'codex,claude,grok',
        secure: options.insecureUntil === undefined ? 1 : 0,
        insecureEnabledUntil: options.insecureUntil === undefined ? null : new Date(options.insecureUntil),
        expiresAt: null,
        ip4: '127.0.0.1',
        ip6: null,
        allowRoamingIps: 0,
        reverseDnsMode: 0,
      } as StateRow<'hosts'>,
    ],
    agentBusRelays: [{ id, hostId: 1, username: 'root', status: 'active', tokenHash: sha256(token),
      tokenExpiresAt: new Date(options.expired ? -1 : 900_000).toISOString(),
      hostAuthFingerprint: sha256('a'.repeat(64)), generation: 1, instanceId: randomUUID(),
      stopRequestedAt: null, stoppedAt: null } as StateRow<'agentBusRelays'>],
    agentSessions: [
      {
        id,
        hostId: 1,
        username: 'root',
        engine: 'codex',
        status: 'active',
        bridgeTokenHash: sha256(token),
        bridgeExpiresAt: new Date(options.expired ? -1 : 900_000).toISOString(),
        hostAuthFingerprint: sha256('a'.repeat(64)),
        bindingGeneration: 1,
        agentBusAddressId: null,
        endedAt: null,
        expiresAt: null,
      } as StateRow<'agentSessions'>,
    ],
  };
  const fake = createDbFake(
    new Map(
      Object.entries(seed).map(([name, rows]) => [
        (schema as unknown as Record<string, unknown>)[name],
        structuredClone([...rows]) as Record<string, unknown>[],
      ]),
    ),
  );
  const select = vi.spyOn(fake, 'select'),
    update = vi.spyOn(fake, 'update');
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch, sequence: 0n }, seed));
  const deadlines = new DeadlineQueue(errors);
  const executor = new CommandExecutor({
    state,
    persistence: {
      receipt: vi.fn(async () => undefined),
      transaction: async (run) => {
        await run(fake as unknown as PersistenceTransaction);
      },
      record: vi.fn(async () => {}),
    },
    assertOwner() {},
    loseOwner: errors,
    committed() {},
    notificationError: errors,
  });
  const runtime: OwnerRuntime = {
    state,
    deadlines,
    assertOwner() {},
    execute: (command) => executor.execute(command),
  };
  const presence = new ConnectionPresence(errors),
    credentials = new ConnectionCredentials(runtime, presence, { session: 900_000, relay: 900_000 });
  const attach = () =>
    presence.attach({
      connectionId: randomUUID(),
      hostId: 1,
      username: 'root',
      scope: { topic: 'session', session_id: id, binding_generation: 1 },
    });
  const renew = (overrides = {}) =>
    credentials.renewBootstrap({
      kind: 'session',
      id,
      token,
      hostId: 1,
      username: 'root',
      bindingGeneration: 1,
      authorizeHost() {},
      ...overrides,
    });
  const close = () => {
    credentials.close();
    presence.close();
    deadlines.close();
  };
  return { id, token, state, credentials, presence, deadlines, errors, select, update, attach, renew, close };
}

describe('connection-derived credential validity', () => {
  it('keeps live credential authority in command draft views and revokes it on detach', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const f = harness();
    try {
      const attachment = f.attach();
      await vi.advanceTimersByTimeAsync(7_200_000);
      const view = f.state.begin().view();
      expect(ownedBridge(view, f.id, f.token).session.id).toBe(f.id);
      expect(ownedCredentialDeadline(view, 'session', f.id)).toBeGreaterThan(Date.now());
      attachment.detach();
      expect(() => ownedBridge(view, f.id, f.token)).toThrow('expired');
    } finally { f.close(); }
  });

  it('does not transfer volatile authority to a reconstructed snapshot with the same epoch', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const f = harness();
    try {
      f.attach(); await vi.advanceTimersByTimeAsync(7_200_000);
      const source = f.state.snapshot();
      const seed = Object.fromEntries(['versions', 'hosts', 'agentSessions'].map(name => {
        const table = name as 'versions' | 'hosts' | 'agentSessions';
        return [name, source.table(table).all()];
      })) as StateSeed;
      const reconstructed = new OwnerStateSnapshot(source.revision, seed);
      expect(() => ownedBridge(reconstructed, f.id, f.token)).toThrow('expired');
      const restarted = new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {}, source);
      expect(() => ownedBridge(restarted, f.id, f.token)).toThrow('expired');
    } finally { f.close(); }
  });

  it('does not inherit a live grant across changed draft bindings', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const f = harness();
    try {
      f.attach(); await vi.advanceTimersByTimeAsync(7_200_000);
      const draft = f.state.begin(), session = draft.table('agentSessions').get(f.id)!;
      draft.upsert('agentSessions', { ...session, bindingGeneration: session.bindingGeneration + 1 });
      expect(() => ownedBridge(draft.view(), f.id, f.token)).toThrow('expired');
      const rotated = f.state.begin();
      rotated.upsert('agentSessions', { ...session, bridgeTokenHash: sha256('rotated') });
      expect(() => ownedBridge(rotated.view(), f.id, 'rotated')).toThrow('expired');
    } finally { f.close(); }
  });

  it('revokes a held session draft when connection credentials close', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const f = harness();
    try {
      f.attach(); await vi.advanceTimersByTimeAsync(7_200_000);
      const view = f.state.begin().view();
      expect(() => ownedBridge(view, f.id, f.token)).not.toThrow();
      f.credentials.close();
      expect(() => ownedBridge(view, f.id, f.token)).toThrow('expired');
    } finally { f.close(); }
  });

  it('keeps relay draft grants live only while their attachment remains connected', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const f = harness();
    try {
      const attachment = f.presence.attach({ connectionId: randomUUID(), hostId: 1, username: 'root',
        scope: { topic: 'relay', relay_id: f.id } });
      await vi.advanceTimersByTimeAsync(7_200_000);
      const view = f.state.begin().view();
      expect(ownedRelay(view, f.id, f.token).relay.id).toBe(f.id);
      attachment.detach();
      expect(() => ownedRelay(view, f.id, f.token)).toThrow('expired');
    } finally { f.close(); }
  });

  it('renews and revokes only the affected credential subscribers across a fleet', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = harness();
    const own = vi.fn(),
      unrelated = vi.fn();
    f.credentials.subscribe('session', f.id, own);
    // A relay with the same ID is a different authority; other sessions do not
    // rebuild their projections when this session extends its volatile grant.
    const unsubscribe = f.credentials.subscribe('relay', f.id, unrelated);
    for (let n = 0; n < 200; n++) f.credentials.subscribe('session', randomUUID(), unrelated);
    const attachment = f.attach();
    expect(own).toHaveBeenCalledOnce();
    own.mockClear();
    await vi.advanceTimersByTimeAsync(450_000);
    expect(own).toHaveBeenCalledOnce();
    expect(unrelated).not.toHaveBeenCalled();
    attachment.detach();
    expect(own).toHaveBeenCalledTimes(2);
    expect(unrelated).not.toHaveBeenCalled();
    unsubscribe();
    f.close();
  });
  it('keeps two hours of authenticated idle connection authority without SQL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = harness();
    f.attach();
    await vi.advanceTimersByTimeAsync(7_200_000);
    expect(ownedBridge(f.state.snapshot(), f.id, f.token).session.id).toBe(f.id);
    expect(ownedCredentialDeadline(f.state.snapshot(), 'session', f.id)).toBeGreaterThan(Date.now());
    expect(f.state.snapshot().sessions.get(f.id)?.bridgeExpiresAt).toBe(new Date(900_000).toISOString());
    expect(f.select).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.errors).not.toHaveBeenCalled();
    f.close();
  });
  it('removes volatile authority on disconnect without losing a replacement attachment', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = harness();
    const old = f.attach();
    await vi.advanceTimersByTimeAsync(1_000_000);
    const next = f.attach();
    old.detach();
    expect(() => ownedBridge(f.state.snapshot(), f.id, f.token)).not.toThrow();
    next.detach();
    expect(() => ownedBridge(f.state.snapshot(), f.id, f.token)).toThrow('expired');
    expect(f.deadlines.size()).toBe(0);
    f.close();
  });
  it('never extends an insecure host grant', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = harness({ insecureUntil: 120_000 });
    f.attach();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(() => ownedBridge(f.state.snapshot(), f.id, f.token)).toThrow('eligible host');
    expect(f.update).not.toHaveBeenCalled();
    expect(f.deadlines.size()).toBe(0);
    f.close();
  });
  it('cannot renew a grant after an event-loop stall across its deadline', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = harness();
    f.attach();
    vi.setSystemTime(1_000_000);
    expect(() => ownedBridge(f.state.snapshot(), f.id, f.token)).toThrow('expired');
    f.close();
  });
  it('immediately invalidates a current attachment when the durable credential rotates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = harness();
    f.attach();
    const draft = f.state.begin(),
      session = f.state.snapshot().sessions.get(f.id)!;
    draft.upsert('agentSessions', { ...session, bridgeTokenHash: sha256('replacement') });
    f.state.publish(draft.seal({ ...f.state.revision(), sequence: 1n }));
    expect(() => ownedBridge(f.state.snapshot(), f.id, f.token)).toThrow('Invalid agent bridge');
    expect(f.deadlines.size()).toBe(0);
    f.close();
  });
  it('requires host authority and the same token and binding for finite reconnect renewal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = harness({ expired: true });
    await expect(f.renew({ token: 'wrong' })).rejects.toThrow('identity mismatch');
    await expect(f.renew({ bindingGeneration: 2 })).rejects.toThrow('generation changed');
    await expect(
      f.renew({
        authorizeHost() {
          throw new Error('host revoked');
        },
      }),
    ).rejects.toThrow('host revoked');
    expect(f.update).not.toHaveBeenCalled();
    await f.renew();
    expect(f.update).toHaveBeenCalledOnce();
    expect(f.state.snapshot().sessions.get(f.id)?.bindingGeneration).toBe(1);
    await f.renew();
    expect(f.update).toHaveBeenCalledOnce();
    expect(f.select).not.toHaveBeenCalled();
    f.close();
  });
  it('cannot recreate volatile authority by attaching an expired token without host reauthentication', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = harness({ expired: true });
    f.attach();
    expect(() => ownedBridge(f.state.snapshot(), f.id, f.token)).toThrow('expired');
    expect(f.deadlines.size()).toBe(0);
    f.close();
  });
});
