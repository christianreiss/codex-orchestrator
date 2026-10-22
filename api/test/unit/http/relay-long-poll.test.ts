import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { relayLongPoll } from '../../../src/http/relay-long-poll.js';
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
  const key = () => `relay-${++keys}:token-hash`;

  it('runs one idle check per fallback period for all parked slots and never polls while idle', async () => {
    vi.useFakeTimers();
    const shared = { key: key(), check: vi.fn(async () => true) };
    const poll = vi.fn(async () => null);
    const waiters = Array.from({ length: 8 }, () =>
      relayLongPoll(poll, Date.now() + 5000, () => false, undefined, shared),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(await Promise.all(waiters)).toEqual(Array(8).fill(null));
    // t=0, 2 s and 4 s: one check per period, not one per slot.
    expect(shared.check).toHaveBeenCalledTimes(3);
    expect(poll).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never shares work: every slot runs its own fenced claim', async () => {
    vi.useFakeTimers();
    const shared = { key: key(), check: vi.fn(async () => false) };
    let claimed = false;
    const poll = vi.fn(async () => (claimed ? null : ((claimed = true), { id: 'work' })));
    const waiters = Array.from({ length: 8 }, () =>
      relayLongPoll(poll, Date.now() + 2500, () => false, undefined, shared),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(2500);
    const results = await Promise.all(waiters);
    expect(results.filter(Boolean)).toEqual([{ id: 'work' }]);
  });

  it('never shares an error: each slot reaches its own admission failure', async () => {
    vi.useFakeTimers();
    const shared = { key: key(), check: vi.fn(async () => Promise.reject(new Error('shared check failed'))) };
    const revoked = new Error('revoked');
    const poll = vi.fn(async () => {
      throw revoked;
    });
    const waiters = Array.from({ length: 3 }, () =>
      relayLongPoll(poll, Date.now() + 25000, () => false, undefined, shared).catch((error: unknown) => error),
    );
    expect(await Promise.all(waiters)).toEqual([revoked, revoked, revoked]);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(shared.check).toHaveBeenCalledTimes(1);
    // The failed answer is not left behind for the next waiter.
    const next = relayLongPoll(async () => null, Date.now() + 100, () => false, undefined, shared);
    await vi.advanceTimersByTimeAsync(100);
    expect(await next).toBeNull();
    expect(shared.check).toHaveBeenCalledTimes(2);
  });

  it('drops a shared idle answer when a wake event arrives', async () => {
    vi.useFakeTimers();
    let idle = true;
    const shared = { key: key(), check: vi.fn(async () => idle) };
    let claimed = false;
    const poll = vi.fn(async () => (claimed ? null : ((claimed = true), { id: 'work' })));
    const waiters = Array.from({ length: 4 }, () =>
      relayLongPoll(poll, Date.now() + 25000, () => false, undefined, shared),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(shared.check).toHaveBeenCalledTimes(1);
    idle = false;
    wsPublisher.publish('agent_messaging.message.changed', { message_id: 'work' });
    await vi.advanceTimersByTimeAsync(0);
    // One fresh check for the new revision, then every slot tries its own claim.
    expect(shared.check).toHaveBeenCalledTimes(2);
    expect(poll).toHaveBeenCalledTimes(4);
    idle = true;
    await vi.advanceTimersByTimeAsync(25000);
    const results = await Promise.all(waiters);
    expect(results.filter(Boolean)).toEqual([{ id: 'work' }]);
  });

  it('rechecks when a wake lands while the shared check is still in flight', async () => {
    vi.useFakeTimers();
    let release!: (idle: boolean) => void;
    const shared = {
      key: key(),
      check: vi
        .fn<() => Promise<boolean>>()
        .mockImplementationOnce(() => new Promise<boolean>((resolve) => (release = resolve)))
        .mockResolvedValue(false),
    };
    const poll = vi.fn(async () => ({ id: 'work' }));
    const waiter = relayLongPoll(poll, Date.now() + 25000, () => false, undefined, shared);
    await vi.advanceTimersByTimeAsync(0);
    wsPublisher.publish('agent_messaging.message.changed', { message_id: 'work' });
    release(true);
    expect(await waiter).toEqual({ id: 'work' });
    expect(shared.check).toHaveBeenCalledTimes(2);
  });

  it('aligns a late joiner to the shared grid, so a change without an event reaches it in the same period', async () => {
    vi.useFakeTimers();
    let idle = true;
    const shared = { key: key(), check: vi.fn(async () => idle) };
    const poll = vi.fn(async () => ({ id: 'requeued' }));
    const first = relayLongPoll(poll, Date.now() + 25000, () => false, undefined, shared);
    await vi.advanceTimersByTimeAsync(1500);
    const late = relayLongPoll(poll, Date.now() + 25000, () => false, undefined, shared);
    await vi.advanceTimersByTimeAsync(100);
    expect(shared.check).toHaveBeenCalledTimes(1);
    idle = false;
    // Both recheck together at t=2 s; a drifting joiner would wait out its own period until t=3.6 s.
    await vi.advanceTimersByTimeAsync(400);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(shared.check).toHaveBeenCalledTimes(2);
    expect(await Promise.all([first, late])).toEqual([{ id: 'requeued' }, { id: 'requeued' }]);
  });

  it('sees a change without an event within one fallback period', async () => {
    vi.useFakeTimers();
    let idle = true;
    const shared = { key: key(), check: vi.fn(async () => idle) };
    const poll = vi.fn(async () => ({ id: 'requeued' }));
    const waiters = Array.from({ length: 4 }, () =>
      relayLongPoll(poll, Date.now() + 25000, () => false, undefined, shared),
    );
    await vi.advanceTimersByTimeAsync(100);
    idle = false; // e.g. a lease expired: no event is published
    await vi.advanceTimersByTimeAsync(1899);
    expect(poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await Promise.all(waiters)).toEqual(Array(4).fill({ id: 'requeued' }));
  });

  it('never shares an answer between different credentials', async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => true);
    const a = relayLongPoll(async () => null, Date.now() + 100, () => false, undefined, { key: key(), check });
    const b = relayLongPoll(async () => null, Date.now() + 100, () => false, undefined, { key: key(), check });
    await vi.advanceTimersByTimeAsync(100);
    expect(await Promise.all([a, b])).toEqual([null, null]);
    expect(check).toHaveBeenCalledTimes(2);
  });
});
