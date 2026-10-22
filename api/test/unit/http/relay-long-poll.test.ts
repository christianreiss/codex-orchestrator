import { afterEach, expect, it, vi } from 'vitest';
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
