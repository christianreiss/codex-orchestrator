import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboxDispatcher, type EffectHandler } from '../../../src/control-plane/outbox.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
import type { OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';

afterEach(() => vi.useRealTimers());
function fixture(status = 'pending', at = 0, replaySafe = false) {
  const id = randomUUID(),
    errors = vi.fn(),
    writes = vi.fn(async () => {});
  const state = new OwnerStateStore(
    new OwnerStateSnapshot(
      { epoch: randomUUID(), sequence: 0n },
      {
        controlPlaneOutbox: [
          {
            id,
            principal: 'fixture',
            requestId: randomUUID(),
            kind: 'email',
            target: 'fixture',
            status,
            attempts: 0,
            availableAt: new Date(at).toISOString(),
            createdAt: new Date(0).toISOString(),
            completedAt: null,
          },
        ],
      },
    ),
  );
  const deadlines = new DeadlineQueue(errors);
  const tx = { update: () => ({ set: () => ({ where: writes }) }) } as unknown as PersistenceTransaction;
  const executor = new CommandExecutor({
    state,
    persistence: {
      receipt: async () => undefined,
      transaction: async (run) => {
        await run(tx);
      },
      record: async () => {},
    },
    assertOwner: () => {},
    loseOwner: errors,
    notificationError: errors,
    committed: () => {},
  });
  const runtime: OwnerRuntime = {
    state,
    deadlines,
    assertOwner: () => {},
    execute: (command) => executor.execute(command),
  };
  const handler = vi.fn<EffectHandler>(async () => ({ status: 'delivered' }));
  const dispatcher = new OutboxDispatcher(runtime, {
    handlers: new Map([['email', handler]]),
    replaySafeKinds: new Set(replaySafe ? ['email'] : []),
    readPayload: async () => ({ body: 'fixture' }),
    error: errors,
  });
  return { id, state, deadlines, executor, handler, dispatcher, errors, writes };
}

describe('durable effect dispatch', () => {
  it('replays an interrupted effect only when the receiver contract explicitly permits it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = fixture('dispatching', 0, true);
    await f.dispatcher.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.handler).toHaveBeenCalledOnce();
    expect(f.state.snapshot().table('controlPlaneOutbox').has(f.id)).toBe(false);
    await f.dispatcher.close();
  });
  it('persists dispatching before external I/O and delivery before dropping active metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = fixture();
    f.handler.mockImplementationOnce(async () => {
      expect(f.state.snapshot().table('controlPlaneOutbox').get(f.id)?.status).toBe('dispatching');
      expect(f.writes).toHaveBeenCalledOnce();
      return { status: 'delivered' };
    });
    await f.dispatcher.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.handler).toHaveBeenCalledOnce();
    expect(f.writes).toHaveBeenCalledTimes(2);
    expect(f.state.snapshot().table('controlPlaneOutbox').has(f.id)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    f.dispatcher.close();
  });
  it('never retries an ambiguous external effect after a lost response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = fixture();
    f.handler.mockRejectedValueOnce(new Error('SMTP response lost'));
    await f.dispatcher.start();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.handler).toHaveBeenCalledOnce();
    expect(f.state.snapshot().table('controlPlaneOutbox').get(f.id)?.status).toBe('uncertain');
    expect(vi.getTimerCount()).toBe(0);
    f.dispatcher.close();
  });
  it('reconstructs interrupted dispatch as uncertain without repeating its side effect', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = fixture('dispatching');
    await f.dispatcher.start();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.handler).not.toHaveBeenCalled();
    expect(f.state.snapshot().table('controlPlaneOutbox').get(f.id)?.status).toBe('uncertain');
    expect(vi.getTimerCount()).toBe(0);
    f.dispatcher.close();
  });
  it('schedules an explicitly safe retry, never scans when nothing is due', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = fixture('pending', 700_000);
    f.handler.mockResolvedValueOnce({ status: 'retry', afterMs: 1000 });
    await f.dispatcher.start();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(f.handler).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.handler).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    f.dispatcher.close();
  });
});
