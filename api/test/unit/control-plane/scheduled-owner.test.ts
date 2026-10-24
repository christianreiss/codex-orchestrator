import { messagingMaintenanceObligations } from '../../../src/ops/maintenance-obligations.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import * as schema from '../../../src/db/schema.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { tickOwnedWatchdogs } from '../../../src/services/schedules/watchdog-owner.js';
import { tickOwnedSchedules } from '../../../src/services/schedules/owner.js';
import { watchdogObligations } from '../../../src/ops/schedule-obligations.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import type { Database } from '../../../src/db/client.js';

function fixture(engine = 'codex', deadline = '2099-01-01T00:00:00.000Z') {
  const now = new Date().toISOString(),
    epoch = randomUUID();
  const seed = {
    versions: [{ name: 'agent_messaging_enabled', version: '1', updatedAt: now }],
    hosts: [{ id: 1, status: 'active', secure: 1, engines: engine, expiresAt: null }],
    agentBusAddresses: [
      {
        id: 'target',
        hostId: 1,
        engine,
        enabled: 1,
        archivedAt: null,
        currentSessionId: 'session',
        lastUpstreamSessionId: 'native',
        continuity: 'native',
      },
    ],
    agentSessions: [
      {
        id: 'session',
        endedAt: null,
        closeRequestedAt: null,
        heartbeatAt: '2000-01-01T00:00:00.000Z',
        bridgeExpiresAt: '2000-01-01T00:00:00.000Z',
        bindingGeneration: 1,
      },
    ],
    agentSchedules: [
      { id: 'schedule', enabled: 1, deletedAt: null, nextDueAt: null, version: 1, updatedAt: now },
    ],
    agentScheduleRuns: [
      {
        id: 'run',
        scheduleId: 'schedule',
        targetAddressId: 'target',
        messageId: 'message',
        status: 'accepted',
        persistent: 1,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ],
    agentBusMessages: [
      {
        id: 'message',
        status: 'accepted',
        acceptedAt: now,
        taskResultStatus: null,
        cancelRequestedAt: null,
        lastErrorCode: null,
      },
    ],
    agentWatchdogs: [
      {
        id: 'watchdog',
        targetAddressId: 'target',
        nativeSessionId: 'native',
        sessionId: 'session',
        scheduleId: 'schedule',
        status: 'watching',
        deadlineAt: deadline,
        version: 1,
        quotaAccountId: null,
        messageId: 'message',
      },
    ],
  } as unknown as StateSeed;
  const db = createDbFake(
    new Map(
      Object.entries(seed).map(([name, rows]) => [
        (schema as unknown as Record<string, unknown>)[name],
        structuredClone([...rows]) as Record<string, unknown>[],
      ]),
    ),
  );
  const select = vi.spyOn(db, 'select'),
    update = vi.spyOn(db, 'update');
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch, sequence: 0n }, seed)),
    errors = vi.fn(),
    deadlines = new DeadlineQueue(errors);
  const execute = new CommandExecutor({
    state,
    persistence: {
      receipt: vi.fn(async () => undefined),
      transaction: async (run) => {
        await run(db as unknown as PersistenceTransaction);
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
    execute: (command) => execute.execute(command),
  };
  bindOwnerRuntime(db, runtime);
  return {
    db: db as unknown as Database,
    select,
    update,
    state,
    runtime,
    errors,
    close: () => deadlines.close(),
  };
}
describe('owned scheduled recovery', () => {
  it('does not time out leased or accepted connection-owned executions', () => {
    const snapshot = new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {
      agentBusMessages: ['leased', 'accepted'].map((status) => ({
        id: status,
        status,
        ownershipMode: 'connection',
        expiresAt: '2000-01-01T00:00:00.000Z',
        leaseUntil: null,
        updatedAt: '2000-01-01T00:00:00.000Z',
      })),
    } as unknown as StateSeed);
    expect(
      messagingMaintenanceObligations(snapshot, {
        relayConnected: () => false,
        sessionConnected: () => false,
        receiverConnected: () => false,
        revision: () => '1',
        conferenceHasPendingDeliveries: () => false,
      }),
    ).toEqual([]);
  });
  it.each(['codex', 'claude', 'grok'])(
    'does not restart %s work because transport and bootstrap credentials are stale',
    async (engine) => {
      const f = fixture(engine);
      for (let index = 0; index < 100; index++) await tickOwnedWatchdogs(f.db);
      expect(f.select).not.toHaveBeenCalled();
      expect(f.update).not.toHaveBeenCalled();
      expect(watchdogObligations(f.state.snapshot(), () => false, 'detached').map((row) => row.key)).toEqual([
        'input:watchdog',
        'deadline:watchdog',
      ]);
      await tickOwnedSchedules(f.db, testKeyring());
      expect(f.state.snapshot().table('agentScheduleRuns').get('run')?.status).toBe('accepted');
      expect(f.update).not.toHaveBeenCalled();
      expect(f.errors).not.toHaveBeenCalled();
      f.close();
    },
  );
  it('enforces an actual watchdog deadline without making accepted execution retryable', async () => {
    const f = fixture('codex', '2000-01-01T00:00:00.000Z');
    await tickOwnedWatchdogs(f.db);
    expect(f.state.snapshot().table('agentWatchdogs').get('watchdog')?.status).toBe('expired');
    expect(f.state.snapshot().table('agentSchedules').get('schedule')?.enabled).toBe(0);
    expect(f.state.snapshot().table('agentScheduleRuns').get('run')?.status).toBe('accepted');
    expect(f.state.snapshot().table('agentBusMessages').get('message')?.status).toBe('accepted');
    expect(f.errors).not.toHaveBeenCalled();
    f.close();
  });
});
