import { randomUUID } from 'node:crypto';
import type { Database } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import { sha256 } from '../../src/security/hash.js';
import { CommandExecutor } from '../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../src/control-plane/deadlines.js';
import {
  OwnerStateSnapshot,
  OwnerStateStore,
  type PreparedOwnerState,
} from '../../src/control-plane/state/store.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../src/control-plane/state/runtime.js';
import { ConnectionPresence, bindOwnerPresence } from '../../src/control-plane/presence.js';
import type { PersistenceTransaction } from '../../src/control-plane/persistence.js';
import type { StateSeed } from '../../src/control-plane/state/catalog.js';
import { createDbFake } from './db-fake.js';
import { testKeyring } from './test-keyring.js';
import { AgentSupervisor } from '../../src/services/agent-supervisor.js';

export function supervisorFixture(engine = 'codex', overrides: StateSeed = {}, database?: Database) {
  const now = new Date().toISOString(),
    hostId = 94251,
    token = 'supervisor-bridge',
    key = 'supervisor-host-key';
  const agents = Array.from({ length: 3 }, (_, index) => ({
    id: randomUUID(),
    addressId: randomUUID(),
    native: randomUUID(),
    name: `Agent ${index}`,
  }));
  const seed = {
    versions: ['agent_messaging_enabled', 'agent_supervisor_enabled'].map((name) => ({
      name,
      version: '1',
      updatedAt: now,
    })),
    hosts: [
      {
        id: hostId,
        fqdn: 'supervisor.test',
        apiKey: key,
        status: 'active',
        secure: 1,
        engines: 'codex,claude,grok',
        internalRole: null,
        expiresAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    hostDaemons: [
      {
        hostId,
        settings: {
          enabled: false,
          resident_enabled: true,
          username: 'root',
          default_cwd: '',
          max_parallel: 8,
          idle_minutes: 60,
          question_minutes: 1440,
        },
        updatedAt: now,
      },
    ],
    agentSessions: agents.map((a) => ({
      id: a.id,
      hostId,
      engine,
      username: 'root',
      cwd: '/repo',
      workspace: null,
      activity: null,
      launchName: a.name,
      agentBusAddressId: a.addressId,
      upstreamSessionId: a.native,
      invocationKind: 'interactive',
      status: 'active',
      activeTurnId: randomUUID(),
      bindingGeneration: 1,
      adapterCapabilities: {
        watchdog_protocol_version: 1,
        supervisor_protocol_version: 1,
        supervisor_model: 'fixture-model',
      },
      adapterProtocol: 'cxx-agent-listen-v1',
      receiver: null,
      closeRequestedAt: null,
      hostAuthFingerprint: sha256(key),
      bridgeTokenHash: sha256(token),
      bridgeExpiresAt: '2099-01-01T00:00:00Z',
      startedAt: now,
      heartbeatAt: now,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    })),
    agentBusAddresses: agents.map((a) => ({
      id: a.addressId,
      address: `agent:${a.addressId}`,
      hostId,
      engine,
      username: 'root',
      cwd: '/repo',
      cwdHash: sha256('/repo'),
      launchName: a.name,
      displayAlias: null,
      enabled: 1,
      archivedAt: null,
      currentSessionId: a.id,
      lastUpstreamSessionId: a.native,
      bindingGeneration: 1,
      continuity: 'native',
      adapterCapabilities: { watchdog_protocol_version: 1, supervisor_protocol_version: 1 },
      readiness: 'ready',
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    })),
    ...overrides,
  } as unknown as StateSeed;
  const fake = createDbFake(
    new Map(
      Object.entries(seed).map(([name, rows]) => [
        (schema as unknown as Record<string, unknown>)[name],
        structuredClone(rows) as unknown as Record<string, unknown>[],
      ]),
    ),
  );
  const originalInsert = fake.insert.bind(fake);
  let dispatch = 0;
  fake.insert = (table: unknown) => {
    if (table === schema.agentBusMessages)
      return {
        values: (row: Record<string, unknown>) => {
          const id = ++dispatch;
          fake.inserts.push({ table, values: row });
          fake.tables.set(table, [...(fake.tables.get(table) ?? []), { ...row, dispatchOrder: id }]);
          return Promise.resolve([{ insertId: id }]);
        },
      };
    const builder = originalInsert(table) as { values: (row: Record<string, unknown>) => unknown };
    return {
      values: (row: Record<string, unknown>) =>
        builder.values({ ...row, ...(row.promptEnc ? { encrypted: row.promptEnc } : {}) }),
    };
  };
  const db = database ?? (fake as unknown as Database),
    state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed));
  const deadlines = new DeadlineQueue((e) => {
    throw e;
  });
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
        if (database) await database.transaction((tx) => run(tx as unknown as PersistenceTransaction));
        else await run(fake as unknown as PersistenceTransaction);
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
  bindOwnerRuntime(db, owner);
  const presence = new ConnectionPresence((e) => {
    throw e;
  });
  bindOwnerPresence(owner, presence);
  for (const a of agents)
    presence.attach({
      connectionId: randomUUID(),
      hostId,
      username: 'root',
      scope: { topic: 'session', session_id: a.id, binding_generation: 1, native_instance_id: randomUUID() },
    });
  const keyring = testKeyring(),
    service = new AgentSupervisor(db, keyring);
  return {
    agents,
    db,
    state,
    owner,
    fake,
    service,
    keyring,
    token,
    now,
    presence,
    close: () => {
      presence.close();
      deadlines.close();
    },
  };
}
