import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { OwnerStateSnapshot, OwnerStateStore, type PreparedOwnerState } from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { bindOwnerRuntime, mutateOwnerState, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import { registerOwnedMessagingSession } from '../../../src/control-plane/state/session-registration.js';
import { stageEndNames, stageLaunchName, stageReleaseFixedName, translateOwnedAgent } from '../../../src/control-plane/state/names.js';
import { stageUpdate } from '../../../src/control-plane/state/rows.js';
import type { Env } from '../../../src/env.js';
import type { Host } from '../../../src/db/schema.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { captureLegacyDrainManifest } from '../../../src/control-plane/legacy-drain.js';

/**
 * External clients carry their configured name as a fixed, reserved launch name
 * (docs/external-clients.md → Name). Production case 2026-11-05: client "Jessica"
 * got the pool name "Viktoria" because an ended web01 Codex session still held
 * "Jessica" in its 24-hour quarantine, and `agent_translate("Jessica")` resolved
 * to that insecure host and failed with `agent_messaging_host_ineligible`.
 */
const FLEET = 1,
  EXTERNAL = 2,
  WEB01 = 3;
const env = { AGENT_PORTAL_BRIDGE_TTL_SECONDS: 3600 } as Env;
const queues: DeadlineQueue[] = [];
afterEach(() => {
  queues.splice(0).forEach((q) => q.close());
});

const host = (id: number, extra: Record<string, unknown>) => ({
  id,
  fqdn: `host-${id}`,
  apiKey: `key-${id}`,
  apiKeyHash: null,
  status: 'active',
  configVersion: 0,
  secure: 1,
  engines: 'codex,claude,grok',
  internalRole: null,
  expiresAt: null,
  insecureEnabledUntil: null,
  ...extra,
});

function harness(extra: Record<string, Record<string, unknown>[]> = {}) {
  const seed = {
    hosts: [
      host(FLEET, {}),
      host(EXTERNAL, { fqdn: 'external.internal', engines: 'external', internalRole: 'external' }),
      // Insecure host whose window is closed: not eligible for messaging.
      host(WEB01, { secure: 0 }),
    ],
    versions: [{ name: 'agent_messaging_enabled', version: '1' }],
    ...extra,
  };
  const fake = createDbFake(
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
        await run(fake as unknown as PersistenceTransaction);
      },
      async record() {},
    },
  });
  const runtime: OwnerRuntime = { state, deadlines, assertOwner() {}, execute: (command) => executor.execute(command) };
  bindOwnerRuntime(fake, runtime);
  const hostRow = (id: number) => (fake.tables.get(schema.hosts) as Host[]).find((row) => row.id === id)!;
  const register = (sessionId: string, fixedName: string | null, hostId = EXTERNAL, requestedAddress?: string) =>
    registerOwnedMessagingSession(
      runtime,
      hostRow(hostId),
      {
        engine: (hostId === EXTERNAL ? 'external' : 'claude') as 'claude',
        username: 'external-client',
        cwd: '/external/client',
        invocationKind: 'interactive',
        sessionId,
        bridgeToken: `token-${sessionId}-${'x'.repeat(40)}`,
        requestedAddress: requestedAddress ?? null,
        continuity: 'reset',
        adapterProtocol: 'external-rest-v1',
        fixedName,
      },
      env,
    );
  return { state, runtime, register };
}

const session = (id: string, hostId: number, addressId: string, launchName: string | null, endedAt: string | null) => ({
  id,
  hostId,
  engine: 'codex',
  agentBusAddressId: addressId,
  bindingGeneration: 1,
  launchName,
  endedAt,
});
const address = (id: string, hostId: number, currentSessionId: string | null, launchName: string | null) => ({
  id,
  address: `agent:${id}`,
  hostId,
  engine: 'codex',
  enabled: 1,
  archivedAt: null,
  displayAlias: null,
  launchName,
  currentSessionId,
});
const pool = (...names: [string, string | null][]) =>
  names.map(([name, currentSessionId]) => ({ nameKey: name.toLowerCase(), name, currentSessionId }));

describe('external client names', () => {
  it('gives the first registration its configured name and keeps it on re-registration', async () => {
    const h = harness({ agentNamePool: pool(['Viktoria', null], ['Jessica', null]) });
    const sessionId = randomUUID();
    const first = (await h.register(sessionId, 'Jessica')) as { address: { id: string; name: string } };
    expect(first.address.name).toBe('Jessica');
    const snapshot = h.state.snapshot();
    expect(snapshot.addresses.get(first.address.id)?.launchName).toBe('Jessica');
    expect(snapshot.sessions.get(sessionId)?.launchName).toBe('Jessica');
    expect(snapshot.table('agentNamePool').get('jessica')?.currentSessionId).toBe(sessionId);
    // Periodic re-registration of the same lifecycle keeps the name and its lease.
    const leases = snapshot.table('agentNameLeases').all().length;
    const again = (await h.register(sessionId, 'Jessica')) as { address: { id: string; name: string } };
    expect(again.address).toMatchObject({ id: first.address.id, name: 'Jessica' });
    expect(h.state.snapshot().table('agentNameLeases').all()).toHaveLength(leases);
    // After agent_session_finished the bridge registers a new lifecycle on the same address.
    const ended = new Date().toISOString();
    await mutateOwnerState(h.runtime, {
      kind: 'test.finish',
      payload: {},
      prepare(context) {
        stageUpdate(context, 'agentSessions', sessionId, { endedAt: ended, status: 'ended' });
        stageUpdate(context, 'agentBusAddresses', first.address.id, { currentSessionId: null });
        stageEndNames(context, sessionId, ended);
        return null;
      },
    });
    const next = randomUUID();
    const resumed = (await h.register(next, 'Jessica', EXTERNAL, `agent:${first.address.id}`)) as {
      address: { id: string; name: string };
    };
    expect(resumed.address).toMatchObject({ id: first.address.id, name: 'Jessica' });
    expect(h.state.snapshot().table('agentNamePool').get('jessica')?.currentSessionId).toBe(next);
    // A name outside the pool works the same way and is resolvable.
    const other = randomUUID();
    const bot = (await h.register(other, 'Hermes Bot')) as { address: { id: string; name: string } };
    expect(bot.address.name).toBe('Hermes Bot');
    expect(translateOwnedAgent(h.state.snapshot(), 'hermes bot', new Date().toISOString()).uuid).toBe(bot.address.id);
  });

  it('never captures an external virtual session in the legacy drain, so a restart cannot pin its old name', async () => {
    // Production 2026-11-05: after the deploy the owner captured Jessica's session for
    // legacy recovery; every poll renewed the capture and registration (and with it
    // the fixed name) never ran again while the client kept polling.
    const h = harness({ agentNamePool: pool(['Viktoria', null], ['Ida', null]) });
    const external = randomUUID(),
      fleet = randomUUID();
    await h.register(external, 'Jessica');
    await h.register(fleet, null, FLEET);
    const now = new Date().toISOString();
    await mutateOwnerState(h.runtime, {
      kind: 'test.controls',
      payload: {},
      prepare(context) {
        for (const id of [external, fleet]) {
          const binding = context.draft.table('agentSessions').get(id)!.bindingGeneration;
          context.draft.upsert('agentNativeControls', {
            sessionId: id,
            instanceId: randomUUID(),
            bindingGeneration: binding,
            status: 'ready',
            requestId: null,
            updatedAt: now,
          } as never);
        }
        return null;
      },
    });
    const manifest = captureLegacyDrainManifest(h.state.snapshot());
    expect(manifest.map((record) => record.id)).toEqual([fleet]);
  });

  it('only honours a fixed name on the server-owned external host', async () => {
    const h = harness({ agentNamePool: pool(['Viktoria', null]) });
    const result = (await h.register(randomUUID(), 'Jessica', FLEET)) as { address: { name: string } };
    expect(result.address.name).toBe('Viktoria');
  });

  it('heals the production case: takes the name from a quarantined web01 lease and resolves to the client', async () => {
    const web01Session = randomUUID(),
      web01Address = randomUUID(),
      external = randomUUID(),
      externalAddress = randomUUID(),
      ended = '2026-11-05T14:32:42.000Z',
      now = new Date().toISOString(),
      cooldown = new Date(Date.now() + 3_600_000).toISOString();
    const h = harness({
      agentSessions: [
        session(web01Session, WEB01, web01Address, 'Jessica', ended),
        { ...session(external, EXTERNAL, externalAddress, 'Viktoria', null), engine: 'external', username: 'external-client', cwd: '/external/client', invocationKind: 'interactive', bridgeTokenHash: '' },
      ],
      agentBusAddresses: [
        address(web01Address, WEB01, null, 'Jessica'),
        { ...address(externalAddress, EXTERNAL, external, 'Viktoria'), engine: 'external' },
      ],
      agentNamePool: pool(['Jessica', web01Session], ['Viktoria', external], ['Paula', null]),
      agentNameLeases: [
        { id: 3046, sessionId: web01Session, nameKey: 'jessica', name: 'Jessica', addressId: web01Address, startedAt: '2026-11-05T10:00:00.000Z', endedAt: ended, cooldownUntil: cooldown },
        { id: 3057, sessionId: external, nameKey: 'viktoria', name: 'Viktoria', addressId: externalAddress, startedAt: '2026-11-05T14:40:00.000Z', endedAt: null, cooldownUntil: null },
      ],
    });
    const name = await mutateOwnerState(h.runtime, {
      kind: 'test.heal',
      payload: {},
      prepare(context) {
        const value = stageLaunchName(context, external, externalAddress, now, {}, 'Jessica');
        context.draft.upsert('agentBusAddresses', { ...context.draft.table('agentBusAddresses').get(externalAddress)!, launchName: value });
        return value;
      },
    });
    expect(name).toBe('Jessica');
    const snapshot = h.state.snapshot();
    expect(snapshot.table('agentNamePool').get('jessica')?.currentSessionId).toBe(external);
    const released = snapshot.table('agentNameLeases').get(3046)!;
    expect(released.endedAt).toBe(ended);
    expect(released.cooldownUntil! <= new Date().toISOString()).toBe(true);
    // The stale web01 address no longer shows the name; its next resume renames it.
    expect(snapshot.addresses.get(web01Address)?.launchName).toBeNull();
    // The pool name ends with the usual quarantine and still reaches the client meanwhile.
    expect(snapshot.table('agentNameLeases').get(3057)?.endedAt).toBe(now);
    expect(translateOwnedAgent(snapshot, 'Jessica', new Date().toISOString())).toMatchObject({
      uuid: externalAddress,
      status: 'active',
    });
  });

  it('renames a live fleet holder with the existing replacement semantics', async () => {
    const fleet = randomUUID(),
      fleetAddress = randomUUID(),
      external = randomUUID(),
      externalAddress = randomUUID(),
      now = new Date().toISOString();
    const h = harness({
      agentSessions: [
        session(fleet, FLEET, fleetAddress, 'Jessica', null),
        { ...session(external, EXTERNAL, externalAddress, null, null), engine: 'external' },
      ],
      agentBusAddresses: [address(fleetAddress, FLEET, fleet, 'Jessica'), { ...address(externalAddress, EXTERNAL, external, null), engine: 'external' }],
      agentNamePool: pool(['Jessica', fleet], ['Paula', null]),
      agentNameLeases: [
        { id: 1, sessionId: fleet, nameKey: 'jessica', name: 'Jessica', addressId: fleetAddress, startedAt: now, endedAt: null, cooldownUntil: null },
      ],
    });
    await mutateOwnerState(h.runtime, {
      kind: 'test.take',
      payload: {},
      prepare: (context) => stageLaunchName(context, external, externalAddress, now, {}, 'Jessica'),
    });
    const snapshot = h.state.snapshot();
    expect(snapshot.table('agentNamePool').get('jessica')?.currentSessionId).toBe(external);
    expect(snapshot.table('agentNamePool').get('paula')?.currentSessionId).toBe(fleet);
    expect(snapshot.sessions.get(fleet)?.launchName).toBe('Paula');
    expect(snapshot.addresses.get(fleetAddress)?.launchName).toBe('Paula');
    expect(snapshot.table('agentNameLeases').get(1)?.endedAt).toBe(now);
  });

  it('never hands a reserved external name to a fleet launch, and frees it on release', async () => {
    const external = randomUUID(),
      externalAddress = randomUUID(),
      resumed = randomUUID(),
      resumedAddress = randomUUID(),
      fresh = randomUUID(),
      freshAddress = randomUUID(),
      long = '2026-10-01T00:00:00.000Z',
      now = new Date().toISOString();
    const h = harness({
      agentSessions: [
        // The external lifecycle ended long ago: its lease quarantine is over.
        { ...session(external, EXTERNAL, externalAddress, 'Jessica', long), engine: 'external' },
        session(resumed, FLEET, resumedAddress, null, null),
        session(fresh, FLEET, freshAddress, null, null),
      ],
      agentBusAddresses: [
        { ...address(externalAddress, EXTERNAL, null, 'Jessica'), engine: 'external' },
        address(resumedAddress, FLEET, resumed, null),
        address(freshAddress, FLEET, fresh, null),
      ],
      agentNamePool: pool(['Jessica', external]),
      agentNameLeases: [
        { id: 1, sessionId: external, nameKey: 'jessica', name: 'Jessica', addressId: externalAddress, startedAt: long, endedAt: long, cooldownUntil: '2026-10-02T00:00:00.000Z' },
        // A fleet address that once held the name tries to resume it.
        { id: 2, sessionId: randomUUID(), nameKey: 'jessica', name: 'Jessica', addressId: resumedAddress, startedAt: '2026-09-01T00:00:00.000Z', endedAt: '2026-09-02T00:00:00.000Z', cooldownUntil: '2026-09-03T00:00:00.000Z' },
      ],
    });
    const stage = (sessionId: string, addressId: string) =>
      mutateOwnerState(h.runtime, {
        kind: 'test.launch',
        payload: {},
        prepare: (context) => stageLaunchName(context, sessionId, addressId, now),
      });
    await expect(stage(fresh, freshAddress)).resolves.toBeNull();
    await expect(stage(resumed, resumedAddress)).resolves.toBeNull();
    // Still the client's name for lookups, even after its lease quarantine.
    expect(translateOwnedAgent(h.state.snapshot(), 'jessica', now).uuid).toBe(externalAddress);
    // Disable/delete releases the reservation; the pool may hand it out again.
    await mutateOwnerState(h.runtime, {
      kind: 'test.release',
      payload: {},
      prepare: (context) => stageReleaseFixedName(context, externalAddress, now),
    });
    expect(h.state.snapshot().addresses.get(externalAddress)?.launchName).toBeNull();
    await expect(stage(fresh, freshAddress)).resolves.toBe('Jessica');
  });

  it('prefers a reachable holder over a quarantined one on an ineligible host', () => {
    const web01Session = randomUUID(),
      web01Address = randomUUID(),
      fleet = randomUUID(),
      fleetAddress = randomUUID(),
      now = new Date().toISOString(),
      soon = new Date(Date.now() + 3_600_000).toISOString();
    const seed = {
      hosts: [host(FLEET, {}), host(WEB01, { secure: 0 })],
      versions: [{ name: 'agent_messaging_enabled', version: '1' }],
      agentSessions: [session(web01Session, WEB01, web01Address, 'Paula', now), session(fleet, FLEET, fleetAddress, 'Paula', null)],
      agentBusAddresses: [address(web01Address, WEB01, null, 'Paula'), address(fleetAddress, FLEET, fleet, 'Paula')],
      agentNamePool: pool(['Paula', web01Session]),
      agentNameLeases: [
        { id: 1, sessionId: web01Session, nameKey: 'paula', name: 'Paula', addressId: web01Address, startedAt: now, endedAt: now, cooldownUntil: soon },
        { id: 2, sessionId: fleet, nameKey: 'paula', name: 'Paula', addressId: fleetAddress, startedAt: now, endedAt: null, cooldownUntil: null },
      ],
    };
    const snapshot = new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed as unknown as StateSeed);
    expect(translateOwnedAgent(snapshot, 'Paula', now).uuid).toBe(fleetAddress);
    // Without a reachable alternative the pool holder still answers (callers decide eligibility).
    const alone = new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {
      ...seed,
      agentBusAddresses: [seed.agentBusAddresses[0]],
      agentNameLeases: [seed.agentNameLeases[0]],
    } as unknown as StateSeed);
    expect(translateOwnedAgent(alone, 'Paula', now).uuid).toBe(web01Address);
  });
});
