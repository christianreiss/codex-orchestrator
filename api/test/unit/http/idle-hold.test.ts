import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { armWake } from '../../../src/http/idle-hold.js';
import { wsPublisher } from '../../../src/ws/publisher.js';

afterEach(() => vi.useRealTimers());
const any = () => true;

it('times out without an event and unsubscribes', async () => {
  vi.useFakeTimers();
  const subscribe = vi.spyOn(wsPublisher, 'subscribe');
  const wake = armWake(any);
  const held = wake.wait(8000, () => false);
  await vi.advanceTimersByTimeAsync(7999);
  let done = false;
  void held.then(() => (done = true));
  await vi.advanceTimersByTimeAsync(0);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await held).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  expect(subscribe).toHaveBeenCalledTimes(1);
  subscribe.mockRestore();
});

it('resolves at once when a matching event came before the wait', async () => {
  const wake = armWake((type) => type === 'agent_messaging.message.changed');
  wsPublisher.publish('host.updated', {});
  wsPublisher.publish('agent_messaging.message.changed', {});
  expect(await wake.wait(8000, () => false)).toBe(true);
});

it('releases on a matching event during the hold and ignores others', async () => {
  vi.useFakeTimers();
  const wake = armWake((type) => type === 'agent_messaging.message.changed');
  const held = wake.wait(8000, () => false);
  wsPublisher.publish('host.daemon.changed', {});
  await vi.advanceTimersByTimeAsync(100);
  wsPublisher.publish('agent_messaging.message.changed', {});
  expect(await held).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('ends on disconnect and removes its close listener', async () => {
  vi.useFakeTimers();
  const connection = new EventEmitter();
  const held = armWake(any).wait(8000, () => false, connection);
  connection.emit('close');
  expect(await held).toBe(false);
  expect(connection.listenerCount('close')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not hold for a client that is already gone', async () => {
  expect(await armWake(any).wait(8000, () => true)).toBe(false);
});
