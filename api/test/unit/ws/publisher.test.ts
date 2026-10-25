import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The in-process event bus behind `/admin/ws`. Three of its properties are
 * load-bearing and unobservable from any route test: a listener that throws
 * must not swallow the rest of the fan-out (one broken socket would silence
 * every other connected admin), the backlog must stay bounded (it grows for the
 * life of the process), and `recent()` is what `/admin/ws/info` reports.
 *
 * `wsPublisher` is a module singleton with no reset, so every test re-imports
 * it from a cleared registry to start on an empty backlog.
 */

const NOW = '2026-07-29T12:00:00Z';

type Publisher = (typeof import('../../../src/ws/publisher.js'))['wsPublisher'];

let wsPublisher: Publisher;

beforeEach(async () => {
  vi.resetModules();
  ({ wsPublisher } = await import('../../../src/ws/publisher.js'));
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('wsPublisher fan-out', () => {
  it('stamps the event and hands the same one to every subscriber', () => {
    const first = vi.fn();
    const second = vi.fn();
    wsPublisher.subscribe(first);
    wsPublisher.subscribe(second);

    wsPublisher.publish('log.created', { id: 7 });

    const event = { type: 'log.created', payload: { id: 7 }, ts: NOW, ...wsPublisher.cursor() };
    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);
    // The same event is what a late reader gets out of the backlog.
    expect(wsPublisher.recent()).toEqual([event]);
  });

  it('stops delivering to a listener once its unsubscribe runs', () => {
    const listener = vi.fn();
    const unsubscribe = wsPublisher.subscribe(listener);

    wsPublisher.publish('host.updated', { id: 1 });
    unsubscribe();
    wsPublisher.publish('host.updated', { id: 2 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'host.updated', payload: { id: 1 }, ts: NOW, sequence: '1' }),
    );
    // Unsubscribing detaches the socket, it does not stop the bus.
    expect(wsPublisher.recent()).toHaveLength(2);
  });

  it('carries on past a listener that throws', () => {
    const before = vi.fn();
    const after = vi.fn();
    wsPublisher.subscribe(before);
    wsPublisher.subscribe(() => {
      throw new Error('socket write failed');
    });
    wsPublisher.subscribe(after);

    expect(() => wsPublisher.publish('toast', { level: 'info' })).not.toThrow();

    // Listeners are a Set, so `after` is reached only if the throw was caught.
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe('wsPublisher backlog', () => {
  it('drops the oldest event once the cap is reached', () => {
    wsPublisher.setBacklogCap(2);

    for (const id of [1, 2, 3]) wsPublisher.publish('log.created', { id });

    expect(wsPublisher.recent().map((e) => e.payload)).toEqual([{ id: 2 }, { id: 3 }]);
  });

  it('floors the cap at 1 so a zero or negative limit still keeps an event', () => {
    for (const cap of [0, -5]) {
      wsPublisher.setBacklogCap(cap);

      for (const id of [1, 2, 3]) wsPublisher.publish('log.created', { id });

      expect(
        wsPublisher.recent().map((e) => e.payload),
        `cap ${cap}`,
      ).toEqual([{ id: 3 }]);
    }
  });

  it('returns the tail of the backlog, newest last, defaulting to 50', () => {
    for (let id = 1; id <= 60; id += 1) wsPublisher.publish('log.created', { id });

    const fifty = wsPublisher.recent();
    expect(fifty).toHaveLength(50);
    expect(fifty[0]!.payload).toEqual({ id: 11 });
    expect(fifty.at(-1)!.payload).toEqual({ id: 60 });

    expect(wsPublisher.recent(3).map((e) => e.payload)).toEqual([{ id: 58 }, { id: 59 }, { id: 60 }]);
    // A limit past the backlog length is not padded.
    expect(wsPublisher.recent(500)).toHaveLength(60);
  });
});

it('advances a monotonic sequence within one owner epoch', () => {
  const initial = wsPublisher.cursor();
  expect(initial.sequence).toBe('0');
  wsPublisher.publish('host.updated', {});
  wsPublisher.publish('host.updated', {});
  expect(wsPublisher.cursor()).toEqual({ epoch: initial.epoch, sequence: '2' });
  expect(wsPublisher.recent().map((event) => event.sequence)).toEqual(['1', '2']);
});

it('publishes changed owner tables once and ignores unchanged revisions', async () => {
  const { OwnerStateSnapshot, OwnerStateStore } = await import('../../../src/control-plane/state/store.js');
  const { publishOwnerStateChanges } = await import('../../../src/ws/publisher.js');
  const state = new OwnerStateStore(
    new OwnerStateSnapshot({ epoch: '11111111-1111-4111-8111-111111111111', sequence: 0n }, {}),
  );
  const stop = publishOwnerStateChanges({
    state,
  } as import('../../../src/control-plane/state/runtime.js').OwnerRuntime);
  state.publish(state.begin().seal({ ...state.revision(), sequence: 1n }));
  expect(wsPublisher.recent()).toEqual([]);
  const draft = state.begin();
  draft.upsert('versions', { name: 'test', version: 'on', updatedAt: NOW });
  state.publish(draft.seal({ ...state.revision(), sequence: 2n }));
  expect(wsPublisher.recent()).toHaveLength(1);
  expect(wsPublisher.recent()[0]).toMatchObject({
    type: 'control_state.changed',
    payload: { tables: ['versions'] },
  });
  stop();
  const later = state.begin();
  later.remove('versions', 'test');
  state.publish(later.seal({ ...state.revision(), sequence: 3n }));
  expect(wsPublisher.recent()).toHaveLength(1);
});

it('keeps volatile observations and owner bookkeeping off the dashboard stream', async () => {
  const { OwnerStateSnapshot, OwnerStateStore } = await import('../../../src/control-plane/state/store.js');
  const { publishOwnerStateChanges } = await import('../../../src/ws/publisher.js');
  const state = new OwnerStateStore(
    new OwnerStateSnapshot({ epoch: '11111111-1111-4111-8111-111111111111', sequence: 0n }, {}),
  );
  const stop = publishOwnerStateChanges({
    state,
  } as import('../../../src/control-plane/state/runtime.js').OwnerRuntime);
  try {
    const observation = state.begin();
    observation.upsert('versions', { name: 'observation', version: 'seen', updatedAt: NOW });
    state.publish(observation.seal({ ...state.revision(), sequence: 1n }), 'volatile');
    const internal = state.begin();
    internal.upsert('versions', { name: 'owner_retention_cursor', version: 'next', updatedAt: NOW });
    state.publish(internal.seal({ ...state.revision(), sequence: 2n }));
    expect(wsPublisher.recent()).toEqual([]);
  } finally {
    stop();
  }
});
