import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { relayGridDelay, relayLongPoll, relayLongPollConfig } from '../../../src/http/relay-long-poll.js';

// The grid logic is period-independent; these cases were written against a 2 s grid.
relayLongPollConfig.gridMs = 2000;
import { wsPublisher } from '../../../src/ws/publisher.js';

afterEach(() => vi.useRealTimers());

it('bounds empty relay SQL work to one check every two seconds', async () => {
  vi.useFakeTimers();
  const poll = vi.fn(async () => null);
  const result = relayLongPoll(poll, Date.now() + 5000, () => false);
  await vi.advanceTimersByTimeAsync(5000);
  expect(poll.mock.calls.length).toBeLessThanOrEqual(4);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await result).toBeNull();
});

it('wakes promptly when a message arrives during an empty query', async () => {
  vi.useFakeTimers();
  const delivery = { id: 'work' };
  const poll = vi
    .fn()
    .mockImplementationOnce(async () => {
      wsPublisher.publish('agent_messaging.message.changed', { message_id: 'work' });
      return null;
    })
    .mockResolvedValue(delivery);
  const result = relayLongPoll(poll, Date.now() + 25000, () => false);
  await vi.advanceTimersByTimeAsync(0);
  expect(poll).toHaveBeenCalledTimes(2);
  expect(await result).toEqual(delivery);
  expect(vi.getTimerCount()).toBe(0);
});

it('ignores routine heartbeat events and honors an exact deadline', async () => {
  vi.useFakeTimers();
  const poll = vi.fn(async () => null);
  const result = relayLongPoll(poll, Date.now() + 2500, () => false);
  await vi.advanceTimersByTimeAsync(100);
  wsPublisher.publish('agent_messaging.address.changed', {});
  wsPublisher.publish('host.daemon.changed', { host_id: 1 });
  wsPublisher.publish('host.updated', { id: 1, source: 'daemon_window' });
  await vi.advanceTimersByTimeAsync(100);
  expect(poll).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2300);
  expect(await result).toBeNull();
  expect(poll).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('wakes on committed work while waiting and stops after a disconnect', async () => {
  vi.useFakeTimers();
  let gone = false;
  const poll = vi.fn(async () => null);
  const result = relayLongPoll(poll, Date.now() + 25000, () => gone);
  await vi.advanceTimersByTimeAsync(100);
  wsPublisher.publish('agent_messaging.message.changed', {});
  await vi.advanceTimersByTimeAsync(0);
  expect(poll).toHaveBeenCalledTimes(2);
  gone = true;
  await vi.advanceTimersByTimeAsync(2000);
  expect(await result).toBeNull();
  expect(poll).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('propagates revoked admission and unsubscribes after errors', async () => {
  vi.useFakeTimers();
  const subscribe = vi.spyOn(wsPublisher, 'subscribe');
  const error = new Error('revoked');
  await expect(
    relayLongPoll(
      async () => {
        throw error;
      },
      Date.now() + 25000,
      () => false,
    ),
  ).rejects.toBe(error);
  expect(subscribe).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  subscribe.mockRestore();
});

it('settles immediately and removes listeners when the socket closes', async () => {
  vi.useFakeTimers();
  const connection = new EventEmitter();
  const poll = vi.fn(async () => null);
  const result = relayLongPoll(poll, Date.now() + 25000, () => false, connection);
  await vi.advanceTimersByTimeAsync(100);
  connection.emit('close');
  expect(await result).toBeNull();
  expect(poll).toHaveBeenCalledTimes(1);
  expect(connection.listenerCount('close')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

describe('shared idle checks across waiters of one relay credential', () => {
  let keys = 0;
  const key = (token = 'token-hash') => `relay-${++keys}:${token}-${keys}`;
  // A database check takes time; resolving in a microtask would hide whether a sibling joined the one in flight.
  const io = <T>(value: T, ms = 10) => () => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

  it('does not fall back to two-second polling in the tail of a ten-second grid', async () => {
    vi.useFakeTimers();
    relayLongPollConfig.gridMs = 10_000;
    try {
      const k = key();
      const first = relayGridDelay(k, Date.now());
      const check = vi.fn(async () => true);
      const poll = vi.fn(async () => null);
      const result = relayLongPoll(poll, Date.now() + first + 9000, () => false, undefined, { key: k, check });
      await vi.advanceTimersByTimeAsync(first + 8000);
      expect(check).toHaveBeenCalledTimes(1);
      // A committed work event still wakes this final, longer wait promptly.
      wsPublisher.publish('agent_messaging.message.changed', {});
      await vi.advanceTimersByTimeAsync(0);
      expect(check).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toBeNull();
      expect(poll).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { relayLongPollConfig.gridMs = 2000; }
  });

  it('gives every new request its own first poll, then one shared check per grid point', async () => {
    vi.useFakeTimers();
    const k = key();
    const check = vi.fn(io(true));
    const poll = vi.fn(async () => null);
    const waiters = Array.from({ length: 8 }, () =>
      relayLongPoll(poll, Date.now() + 9000, () => false, undefined, { key: k, check }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(8);
    expect(check).not.toHaveBeenCalled();
    const first = relayGridDelay(k, Date.now());
    await vi.advanceTimersByTimeAsync(first);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9000 - first);
    expect(await Promise.all(waiters)).toEqual(Array(8).fill(null));
    expect(check).toHaveBeenCalledTimes(Math.ceil((9000 - first) / 2000));
    expect(poll).toHaveBeenCalledTimes(8);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives a request that enters after a stop its own refusal, never a sibling idle answer', async () => {
    vi.useFakeTimers();
    const k = key();
    const check = vi.fn(io(true, 500));
    const parked = relayLongPoll(async () => null, Date.now() + 5000, () => false, undefined, { key: k, check });
    await vi.advanceTimersByTimeAsync(relayGridDelay(k, Date.now()));
    expect(check).toHaveBeenCalledTimes(1); // a shared idle check is in flight
    const revoked = new Error('agent_messaging_relay_unauthorized');
    const late = relayLongPoll(
      async () => {
        throw revoked;
      },
      Date.now() + 5000,
      () => false,
      undefined,
      { key: k, check },
    );
    await expect(late).rejects.toBe(revoked);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await parked).toBeNull();
  });

  it('never shares work or a false answer: every slot runs its own fenced claim', async () => {
    vi.useFakeTimers();
    const k = key();
    const check = vi.fn(io(false));
    let claimed = false;
    const poll = vi.fn(async () => {
      if (poll.mock.calls.length <= 8 || claimed) return null;
      claimed = true;
      return { id: 'work' };
    });
    const waiters = Array.from({ length: 8 }, () =>
      relayLongPoll(poll, Date.now() + 2500 + relayGridDelay(k, Date.now()), () => false, undefined, { key: k, check }),
    );
    await vi.advanceTimersByTimeAsync(relayGridDelay(k, Date.now()) + 10);
    expect(check).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(16);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await Promise.all(waiters)).filter(Boolean)).toEqual([{ id: 'work' }]);
  });

  it('never shares an error: each slot reaches its own admission failure', async () => {
    vi.useFakeTimers();
    const k = key();
    const check = vi.fn(
      () => new Promise<boolean>((_resolve, reject) => setTimeout(() => reject(new Error('shared check failed')), 10)),
    );
    const revoked = new Error('revoked');
    let admitted = 3;
    const poll = vi.fn(async () => {
      if (admitted-- > 0) return null;
      throw revoked;
    });
    const waiters = Array.from({ length: 3 }, () =>
      relayLongPoll(poll, Date.now() + 25000, () => false, undefined, { key: k, check }).catch((error: unknown) => error),
    );
    await vi.advanceTimersByTimeAsync(relayGridDelay(k, Date.now()) + 10);
    expect(await Promise.all(waiters)).toEqual([revoked, revoked, revoked]);
    expect(check).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops an in-flight answer when a wake arrives and rechecks once for everyone', async () => {
    vi.useFakeTimers();
    const k = key();
    let release!: (idle: boolean) => void;
    const check = vi
      .fn<() => Promise<boolean>>()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => (release = resolve)))
      .mockImplementation(io(false));
    const poll = vi.fn(async (): Promise<{ id: string } | null> => (poll.mock.calls.length <= 2 ? null : { id: 'work' }));
    const a = relayLongPoll(poll, Date.now() + 25000, () => false, undefined, { key: k, check });
    const b = relayLongPoll(poll, Date.now() + 25000, () => false, undefined, { key: k, check });
    await vi.advanceTimersByTimeAsync(relayGridDelay(k, Date.now()));
    expect(check).toHaveBeenCalledTimes(1);
    wsPublisher.publish('agent_messaging.message.changed', { message_id: 'work' });
    release(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(check).toHaveBeenCalledTimes(2);
    expect(await Promise.all([a, b])).toEqual([{ id: 'work' }, { id: 'work' }]);
  });

  it('lets a latecomer join an older in-flight check only while no admission event intervened', async () => {
    vi.useFakeTimers();
    for (const relayChanged of [false, true]) {
      const k = key();
      const check = vi.fn(io(true, 3000));
      const poll = vi.fn(async () => null);
      const w1 = relayLongPoll(poll, Date.now() + 9000, () => false, undefined, { key: k, check });
      await vi.advanceTimersByTimeAsync(relayGridDelay(k, Date.now()));
      expect(check).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);
      if (relayChanged) wsPublisher.publish('agent_messaging.relay.changed', { relay_id: k, status: 'stopped' });
      const w2 = relayLongPoll(poll, Date.now() + 9000, () => false, undefined, { key: k, check });
      // Next grid point: the first check is still in flight.
      await vi.advanceTimersByTimeAsync(1900);
      expect(check).toHaveBeenCalledTimes(relayChanged ? 2 : 1);
      await vi.advanceTimersByTimeAsync(12000);
      expect(await Promise.all([w1, w2])).toEqual([null, null]);
    }
  });

  it('never lets a different credential join', async () => {
    vi.useFakeTimers();
    const check = vi.fn(io(true));
    const a = key('token-a');
    const b = key('token-b');
    // Stop after both first grid points, before either credential's second one.
    const firstChecks = Math.max(relayGridDelay(a, Date.now()), relayGridDelay(b, Date.now()));
    const wa = relayLongPoll(async () => null, Date.now() + 4100, () => false, undefined, { key: a, check });
    const wb = relayLongPoll(async () => null, Date.now() + 4100, () => false, undefined, { key: b, check });
    await vi.advanceTimersByTimeAsync(firstChecks);
    expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4101);
    expect(await Promise.all([wa, wb])).toEqual([null, null]);
  });

  it('keeps followers going when the waiter that started the check disconnects', async () => {
    vi.useFakeTimers();
    const k = key();
    const connection = new EventEmitter();
    const check = vi.fn(io(true, 50));
    const poll = vi.fn(async () => null);
    const starter = relayLongPoll(poll, Date.now() + 25000, () => false, connection, { key: k, check });
    await vi.advanceTimersByTimeAsync(0);
    const follower = relayLongPoll(poll, Date.now() + 25000, () => false, undefined, { key: k, check });
    await vi.advanceTimersByTimeAsync(relayGridDelay(k, Date.now()));
    expect(check).toHaveBeenCalledTimes(1);
    connection.emit('close');
    await vi.advanceTimersByTimeAsync(50);
    expect(await starter).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(25000);
    expect(await follower).toBeNull();
    expect(connection.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('converges staggered entries on one grid point', async () => {
    vi.useFakeTimers();
    const k = key();
    // Put the first grid point 1.5 s ahead so three entries can arrive before it.
    const phase = relayGridDelay(k, 0) % 2000;
    vi.setSystemTime(1_000_000 + ((((phase - 1500) % 2000) + 2000) % 2000));
    expect(relayGridDelay(k, Date.now())).toBe(1500);
    const check = vi.fn(io(true));
    const poll = vi.fn(async () => null);
    const waiters = [relayLongPoll(poll, Date.now() + 3000, () => false, undefined, { key: k, check })];
    await vi.advanceTimersByTimeAsync(500);
    waiters.push(relayLongPoll(poll, Date.now() + 2500, () => false, undefined, { key: k, check }));
    await vi.advanceTimersByTimeAsync(500);
    waiters.push(relayLongPoll(poll, Date.now() + 2000, () => false, undefined, { key: k, check }));
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(510);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await Promise.all(waiters)).toEqual([null, null, null]);
  });

  it('sees a change without an event at the next grid point, within two seconds', async () => {
    vi.useFakeTimers();
    const k = key();
    let idle = true;
    const check = vi.fn(() => io(idle)());
    const poll = vi.fn(async (): Promise<{ id: string } | null> => (idle ? null : { id: 'requeued' }));
    const waiters = Array.from({ length: 4 }, () =>
      relayLongPoll(poll, Date.now() + 25000, () => false, undefined, { key: k, check }),
    );
    await vi.advanceTimersByTimeAsync(relayGridDelay(k, Date.now()) + 10);
    expect(check).toHaveBeenCalledTimes(1);
    idle = false; // e.g. a lease expired: no event is published
    await vi.advanceTimersByTimeAsync(1989);
    expect(poll).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(11);
    expect(await Promise.all(waiters)).toEqual(Array(4).fill({ id: 'requeued' }));
  });
});
