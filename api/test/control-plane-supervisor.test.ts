import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { supervisorFixture } from './helpers/supervisor.js';
import { mutateOwnerState } from '../src/control-plane/state/runtime.js';
import { stageUpdate } from '../src/control-plane/state/rows.js';
import { watchdogPolicy } from '../src/control-plane/streams/policies.js';
import { WatchdogsService } from '../src/services/watchdogs.js';
import { tickOwnedSchedules } from '../src/services/schedules/owner.js';
import { recoveryBudget } from '../src/services/agent-supervisor/policy.js';
import { OwnerStateSnapshot } from '../src/control-plane/state/store.js';
import { decrypt } from '../src/security/secret-box.js';

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});
function fixture(engine = 'codex') {
  const f = supervisorFixture(engine);
  closers.push(f.close);
  return f;
}
async function patch(
  f: ReturnType<typeof fixture>,
  table: 'agentWorkStates' | 'agentSessions' | 'agentWatchdogs' | 'agentScheduleRuns',
  id: string,
  value: Record<string, unknown>,
) {
  await mutateOwnerState(f.owner, {
    kind: 'test.patch',
    payload: { id },
    prepare: (ctx) => {
      stageUpdate(ctx, table, id, value);
      return null;
    },
  });
}

describe('external fleet task supervisor', () => {
  it.each(['codex', 'claude', 'grok'])(
    'automatically arms %s once and preserves the launch model',
    async (engine) => {
      const f = fixture(engine);
      await f.service.tick();
      await f.service.tick();
      expect(f.state.snapshot().table('agentWatchdogs').all()).toHaveLength(3);
      const work = f.service.list().states[0]!;
      expect(work.model).toBe('fixture-model');
      expect(work.attempts).toBe(0);
      expect(
        watchdogPolicy(f.state.snapshot(), f.state.snapshot().sessions.get(f.agents[0]!.id)!)
          .progress_timeout_seconds,
      ).toBe(900);
    },
  );
  it('persists a ten-minute reminder and does not repeat it on an unchanged scan', async () => {
    const f = fixture();
    await f.service.tick();
    const at = new Date(Date.parse(f.now) + 601000);
    await f.service.tick(at);
    const count = f.state.snapshot().messages.all().length;
    expect(count).toBe(3);
    await f.service.tick(at);
    expect(f.state.snapshot().messages.all()).toHaveLength(count);
  });
  it('protects explicit agent waits, user questions, idle observations, STOP and paused incidents', async () => {
    const f = fixture();
    await f.service.tick();
    const a = f.agents[0]!;
    await f.service.report(a.id, f.token, {
      task_key: 'wait',
      state: 'waiting_agent',
      waiting_for: `agent:${f.agents[1]!.addressId}`,
    });
    expect(
      watchdogPolicy(f.state.snapshot(), f.state.snapshot().sessions.get(a.id)!).progress_timeout_seconds,
    ).toBeNull();
    await f.service.report(a.id, f.token, { task_key: 'wait', state: 'waiting_user' });
    expect(
      watchdogPolicy(f.state.snapshot(), f.state.snapshot().sessions.get(a.id)!).terminate_requested,
    ).toBe(false);
    await f.service.report(a.id, f.token, { task_key: 'wait', state: 'working' });
    await patch(f, 'agentSessions', a.id, { activity: { state: 'idle' } });
    expect(
      watchdogPolicy(f.state.snapshot(), f.state.snapshot().sessions.get(a.id)!).progress_timeout_seconds,
    ).toBeNull();
    await patch(f, 'agentSessions', a.id, { activity: null, closeRequestedAt: new Date().toISOString() });
    expect(
      watchdogPolicy(f.state.snapshot(), f.state.snapshot().sessions.get(a.id)!).progress_timeout_seconds,
    ).toBeNull();
  });
  it('detects a three-agent cycle once and creates durable operator attention', async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++)
      await f.service.report(f.agents[i]!.id, f.token, {
        task_key: 'cycle',
        state: 'waiting_agent',
        waiting_for: `agent:${f.agents[(i + 1) % 3]!.addressId}`,
      });
    await f.service.tick();
    expect(f.service.list().states.some((w) => w.escalation === 'dependency_cycle')).toBe(true);
    const notices = f.state.snapshot().table('agentChatNotices').all().length;
    expect(notices).toBeGreaterThan(0);
    await f.service.tick();
    expect(f.state.snapshot().table('agentChatNotices').all()).toHaveLength(notices);
  });
  it('rejects foreign work messages and stale versions without changing state', async () => {
    const f = fixture(),
      a = f.agents[0]!;
    await f.service.report(a.id, f.token, { task_key: 'one', state: 'working' });
    const before = f.service.list().states[0]!;
    await expect(
      f.service.report(a.id, f.token, { task_key: 'one', state: 'waiting_agent', message_id: randomUUID() }),
    ).rejects.toThrow('not owned');
    await expect(
      f.service.report(a.id, f.token, { task_key: 'one', state: 'completed', version: before.version + 1 }),
    ).rejects.toThrow('changed');
  });
  describe('task_key derivation', () => {
    async function ownedMessage(f: ReturnType<typeof fixture>, addressId: string) {
      await f.service.tick();
      await f.service.tick(new Date(Date.parse(f.now) + 601000));
      return f.state
        .snapshot()
        .messages.all()
        .find((m) => m.senderAddressId === addressId || m.targetAddressId === addressId)!;
    }
    it('derives the task key from the work message when task_key is omitted', async () => {
      const f = fixture(),
        a = f.agents[0]!,
        message = await ownedMessage(f, a.addressId);
      await f.service.report(a.id, f.token, { state: 'working', message_id: message.id });
      expect(f.state.snapshot().table('agentWorkStates').get(a.addressId)!.taskKey).toBe(
        `message:${message.id}`,
      );
    });
    it('keeps the current task key for a wait without task_key', async () => {
      const f = fixture(),
        a = f.agents[0]!,
        message = await ownedMessage(f, a.addressId);
      await f.service.report(a.id, f.token, { task_key: 'stable', state: 'working' });
      await f.service.report(a.id, f.token, { state: 'waiting_agent', message_id: message.id });
      expect(f.state.snapshot().table('agentWorkStates').get(a.addressId)!.taskKey).toBe('stable');
    });
    it('names both task_key and message_id when neither is supplied', async () => {
      const f = fixture(),
        a = f.agents[0]!;
      await expect(f.service.report(a.id, f.token, { state: 'working' })).rejects.toThrow(
        /task_key or message_id/,
      );
    });
  });
  it('starts an immutable two-hour incident on capacity, including before the first scan', async () => {
    const f = fixture(),
      a = f.agents[0]!,
      dogs = new WatchdogsService(f.db, f.keyring);
    await dogs.activity(a.id, f.token, {
      last_progress_at: f.now,
      failure: 'capacity',
      retry_not_before: new Date(Date.now() + 3600000).toISOString(),
    });
    const work = f.service.list(`agent:${a.addressId}`).states[0]!;
    expect(work.incidentAt).not.toBeNull();
    expect(Date.parse(work.deadlineAt!) - Date.parse(work.incidentAt!)).toBe(7200000);
    const dog = f.state.snapshot().table('agentWatchdogs').get(work.watchdogId!)!;
    expect(dog.status).toBe('capacity_wait');
    const due = f.state.snapshot().table('agentSchedules').get(dog.scheduleId)!.nextDueAt!;
    expect(Date.parse(due)).toBeGreaterThanOrEqual(Date.now() + 3590000);
    await dogs.activity(a.id, f.token, { last_progress_at: f.now, failure: 'capacity' });
    expect(f.service.list(`agent:${a.addressId}`).states[0]!.deadlineAt).toBe(work.deadlineAt);
  });
  it('retains budget after a snapshot restart and pauses at the deadline without canceling admitted work', async () => {
    const f = fixture();
    await f.service.tick();
    const w = f.service.list().states[0]!;
    await patch(f, 'agentWorkStates', w.addressId, {
      incidentAt: f.now,
      deadlineAt: new Date(Date.parse(f.now) + 7200000).toISOString(),
    });
    const row = f.state.snapshot().table('agentWorkStates').get(w.addressId)!;
    const restart = new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, { agentWorkStates: [row] });
    expect(recoveryBudget(restart.table('agentWorkStates').get(w.addressId)!, 5, Date.parse(f.now))).toBe(
      'recovery_limit',
    );
    await f.service.tick(new Date(Date.parse(f.now) + 7200001));
    expect(f.service.list().states.find((x) => x.addressId === w.addressId)!.escalation).toBe(
      'recovery_deadline',
    );
  });
  it('uses the existing execution lane, blocks a sixth attempt and pins the original prompt', async () => {
    const f = fixture(),
      a = f.agents[0]!,
      dogs = new WatchdogsService(f.db, f.keyring);
    await dogs.activity(a.id, f.token, { last_progress_at: f.now, failure: 'capacity' });
    const w = f.service.list(`agent:${a.addressId}`).states[0]!,
      dog = f.state.snapshot().table('agentWatchdogs').get(w.watchdogId!)!;
    await tickOwnedSchedules(f.db, f.keyring, new Date(Date.now() + 400000));
    const run = f.state.snapshot().table('agentScheduleRuns').by('scheduleId', dog.scheduleId)[0]!;
    expect(run).toBeDefined();
    const message = f.state.snapshot().messages.get(run.messageId!)!;
    await mutateOwnerState(f.owner, {
      kind: 'test.failure',
      payload: {},
      prepare: (ctx) => {
        stageUpdate(ctx, 'agentBusMessages', message.id, {
          status: 'dead',
          lastErrorCode: 'schedule_capacity',
        });
        stageUpdate(ctx, 'agentScheduleRuns', run.id, {
          status: 'capacity_wait',
          recoveryCount: 4,
          nextAttemptAt: f.now,
        });
        return null;
      },
    });
    await tickOwnedSchedules(f.db, f.keyring, new Date(Date.now() + 500000));
    expect(f.state.snapshot().table('agentScheduleRuns').get(run.id)!.status).toBe('blocked');
    const encrypted = f.fake.inserts.find((x) => x.table && (x.values as Record<string, unknown>).promptEnc)
      ?.values as Record<string, unknown>;
    expect(decrypt(String(encrypted.promptEnc), f.keyring)).toContain('exact native transcript');
  });
  it('turning the fleet switch off disables automatic termination immediately', async () => {
    const f = fixture();
    await f.service.tick();
    await f.service.setEnabled(false, 1);
    expect(f.service.list().effective).toBe(false);
    expect(
      f.state
        .snapshot()
        .table('agentWatchdogs')
        .all()
        .every((d) => d.status === 'disabled'),
    ).toBe(true);
  });
});

it('notifies both dependents once when two accepted handoffs complete', async () => {
  const f = fixture(),
    [{ addressId: coordinator }, { addressId: first }, { addressId: second }] = f.agents as [
      (typeof f.agents)[number],
      (typeof f.agents)[number],
      (typeof f.agents)[number],
    ];
  const { stageQueuedMessage, stageServerAddress } = await import('../src/control-plane/state/messages.js');
  const { newQueuedMessage } = await import('../src/services/agent-messaging/views.js');
  const { agentBusConversations } = await import('../src/db/schema.js');
  const ids = [randomUUID(), randomUUID()];
  await mutateOwnerState(f.owner, {
    kind: 'test.handoffs',
    payload: { ids },
    prepare: (ctx) => {
      stageServerAddress(ctx, f.now);
      for (const [index, target] of [first, second].entries()) {
        const conversation = {
          id: randomUUID(),
          addressAId: coordinator,
          addressBId: target,
          createdByAddressId: coordinator,
          nextSequence: 2,
          status: 'active',
          lastActivityAt: f.now,
          canceledAt: null,
          canceledBy: null,
          cancelReason: null,
          createdAt: f.now,
          updatedAt: f.now,
        };
        ctx.draft.upsert('agentBusConversations', conversation);
        ctx.write(async (tx) => tx.insert(agentBusConversations).values(conversation));
        stageQueuedMessage(ctx, {
          ...newQueuedMessage({
            id: ids[index]!,
            conversationId: conversation.id,
            sequence: 1,
            sender: ctx.draft.table('agentBusAddresses').get(coordinator)!,
            senderSessionId: f.agents[0]!.id,
            target: ctx.draft.table('agentBusAddresses').get(target)!,
            kind: 'request',
            content: 'test work',
            contentEnc: 'fixture',
            clientMessageId: randomUUID(),
            expiresAt: '2099-01-01T00:00:00Z',
            now: f.now,
          }),
          status: 'accepted',
          acceptedAt: f.now,
        });
      }
      return null;
    },
  });
  await f.service.tick();
  expect(f.state.snapshot().table('agentWorkDependencies').all()).toHaveLength(2);
  await mutateOwnerState(f.owner, {
    kind: 'test.results',
    payload: { ids },
    prepare: (ctx) => {
      for (const id of ids)
        stageUpdate(ctx, 'agentBusMessages', id, { status: 'completed', taskResultStatus: 'succeeded' });
      return null;
    },
  });
  await f.service.tick();
  expect(
    f.state
      .snapshot()
      .table('agentWorkDependencies')
      .all()
      .map((d) => d.status),
  ).toEqual(['notified', 'notified']);
  const count = f.state
    .snapshot()
    .messages.all()
    .filter((m) => m.kind === 'presence_notice').length;
  expect(count).toBe(2);
  await f.service.tick();
  expect(
    f.state
      .snapshot()
      .messages.all()
      .filter((m) => m.kind === 'presence_notice'),
  ).toHaveLength(count);
});

it('never rearms a completed custom task until a proven new native turn starts', async () => {
  const f = fixture(),
    a = f.agents[0]!;
  await f.service.report(a.id, f.token, { task_key: 'custom-task', state: 'working' });
  await f.service.tick();
  await f.service.report(a.id, f.token, { task_key: 'custom-task', state: 'completed' });
  await f.service.tick();
  expect(f.service.list(`agent:${a.addressId}`).states[0]!.state).toBe('completed');
  expect(
    f.state
      .snapshot()
      .table('agentWatchdogs')
      .by('targetAddressId', a.addressId)
      .filter((d) => d.status === 'watching'),
  ).toHaveLength(0);
  await patch(f, 'agentSessions', a.id, { activeTurnId: randomUUID() });
  await f.service.tick();
  expect(f.service.list(`agent:${a.addressId}`).states[0]!.state).toBe('working');
  expect(
    f.state
      .snapshot()
      .table('agentWatchdogs')
      .by('targetAddressId', a.addressId)
      .filter((d) => d.status === 'watching'),
  ).toHaveLength(1);
});

it('escalates an unanswered explicit wait even without a formal work request', async () => {
  const f = fixture(),
    a = f.agents[0]!,
    peer = f.agents[1]!;
  await f.service.report(a.id, f.token, {
    task_key: 'freeform-wait',
    state: 'waiting_agent',
    waiting_for: `agent:${peer.addressId}`,
  });
  await f.service.tick();
  await f.service.tick(new Date(Date.parse(f.now) + 601000));
  await f.service.tick(new Date(Date.parse(f.now) + 902000));
  expect(f.service.list(`agent:${a.addressId}`).states[0]!.escalation).toBe('handoff_unanswered');
  const notices = f.state.snapshot().table('agentChatNotices').all().length;
  await f.service.tick(new Date(Date.parse(f.now) + 1000000));
  expect(f.state.snapshot().table('agentChatNotices').all()).toHaveLength(notices);
});

it('retains unfinished and paused supervisor work against history cleanup', async () => {
  const f = fixture(),
    a = f.agents[0]!;
  await f.service.report(a.id, f.token, { task_key: 'paused', state: 'waiting_user' });
  const work = f.service.list(`agent:${a.addressId}`).states[0]!;
  await f.service.pause(work.target, work.version);
  const { retentionFacts } = await import('../src/services/server-retention/ram.js');
  const facts = retentionFacts(f.state.snapshot(), '2099-01-01T00:00:00Z');
  expect(facts.protectedAddresses.has(a.addressId)).toBe(true);
  expect(facts.protectedSessions.has(a.id)).toBe(true);
});

it('records an unconfirmed owned-process exit as its own escalation reason', async () => {
  const f = fixture(),
    a = f.agents[0]!;
  await f.service.tick();
  await new WatchdogsService(f.db, f.keyring).activity(a.id, f.token, {
    last_progress_at: f.now,
    failure: 'blocked',
    termination_unconfirmed: true,
  });
  await f.service.tick();
  expect(f.service.list(`agent:${a.addressId}`).states[0]!.escalation).toBe('termination_unconfirmed');
});
