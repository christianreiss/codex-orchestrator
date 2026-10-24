import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ControlStateStreams,
  type StateFrame,
  type StateProjection,
  type StateProvider,
} from '../../../src/control-plane/protocol.js';

afterEach(() => vi.useRealTimers());
function fixture() {
  const epoch = randomUUID(),
    frames: StateFrame[] = [],
    listeners = new Set<() => void>();
  let allowed = true,
    deadline: number | null = null,
    value = 0,
    buffer = 0;
  const projection: StateProjection = {
    snapshot: vi.fn(() => ({
      ownership_mode: 'connection',
      authorization_deadline: deadline === null ? null : new Date(deadline).toISOString(),
      value,
    })),
    authorize: vi.fn(() => {
      if (!allowed || (deadline !== null && deadline <= Date.now())) throw new Error('revoked');
      return { deadline };
    }),
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    update: vi.fn(),
    detach: vi.fn(),
  };
  const provider: StateProvider = { epoch, assertOwner: vi.fn(), open: vi.fn(async () => projection) };
  const errors = vi.fn();
  const streams = new ControlStateStreams(provider, {
    send: (frame) => {
      frames.push(frame);
    },
    bufferedBytes: () => buffer,
    error: errors,
  });
  const open = (id = randomUUID()) =>
    streams
      .receive({
        type: 'state_open',
        protocol: 1,
        stream_id: id,
        scope: { topic: 'session', session_id: randomUUID() },
        auth: { bridge_token: 'private' },
      })
      .then(() => id);
  return {
    epoch,
    frames,
    listeners,
    projection,
    provider,
    streams,
    open,
    errors,
    change() {
      value++;
      for (const listener of listeners) listener();
    },
    revoke() {
      allowed = false;
      for (const listener of listeners) listener();
    },
    deadline(at: number) {
      deadline = at;
    },
    overflow() {
      buffer = 2 * 1024 * 1024;
    },
  };
}
describe('communicator authoritative state subscriptions', () => {
  it('installs subscription before snapshot and orders changes after it', async () => {
    const f = fixture();
    vi.mocked(f.projection.snapshot).mockImplementationOnce(() => {
      expect(f.listeners.size).toBe(1);
      f.change();
      return { ownership_mode: 'connection', value: 1 };
    });
    await f.open();
    await Promise.resolve();
    expect(f.frames.map((frame) => frame.type)).toEqual(['state_snapshot', 'state_delta']);
    expect(f.frames.map((frame) => frame.revision)).toEqual(['1', '2']);
    expect(JSON.stringify(f.frames)).not.toContain('private');
    f.streams.close();
  });
  it('uses transport pings for ten minutes without refreshing snapshots', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      id = await f.open();
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
      await f.streams.receive({ type: 'state_pong', protocol: 1, stream_id: id, owner_epoch: f.epoch });
    }
    expect(f.frames.filter((frame) => frame.type === 'state_ping')).toHaveLength(40);
    expect(f.projection.snapshot).toHaveBeenCalledOnce();
    expect(f.provider.open).toHaveBeenCalledOnce();
    expect(f.streams.size()).toBe(1);
    f.streams.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('closes a silently lost attachment while other transport can stay connected', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.open();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(f.frames.at(-1)?.code).toBe('transport_timeout');
    expect(f.projection.detach).toHaveBeenCalledOnce();
    expect(f.streams.size()).toBe(0);
    expect(f.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('revokes at the real security deadline; pongs cannot extend it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = fixture();
    f.deadline(20_000);
    const id = await f.open();
    await vi.advanceTimersByTimeAsync(15_000);
    await f.streams.receive({ type: 'state_pong', protocol: 1, stream_id: id, owner_epoch: f.epoch });
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.frames.at(-1)?.code).toBe('authorization_expired');
    expect(f.streams.size()).toBe(0);
  });
  it('publishes revocation without waiting for a heartbeat', async () => {
    const f = fixture();
    await f.open();
    f.revoke();
    await Promise.resolve();
    expect(f.frames.at(-1)?.type).toBe('state_close');
    expect(f.streams.size()).toBe(0);
  });
  it('ignores stale epochs and rejects impossible applied acknowledgments', async () => {
    const f = fixture(),
      id = await f.open();
    await f.streams.receive({
      type: 'state_update',
      protocol: 1,
      stream_id: id,
      owner_epoch: randomUUID(),
      payload: { capacity: 1 },
    });
    expect(f.projection.update).not.toHaveBeenCalled();
    await f.streams.receive({
      type: 'state_ack',
      protocol: 1,
      stream_id: id,
      owner_epoch: f.epoch,
      revision: '2',
    });
    expect(f.frames.at(-1)?.code).toBe('state_rejected');
  });
  it('cleans up pending opens without detaching replacement streams', async () => {
    const f = fixture();
    let resolve!: (p: StateProjection) => void;
    vi.mocked(f.provider.open).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const id = randomUUID(),
      pending = f.open(id);
    await f.streams.receive({ type: 'state_close', protocol: 1, stream_id: id, owner_epoch: f.epoch });
    const replacement = { ...f.projection, detach: vi.fn() };
    vi.mocked(f.provider.open).mockResolvedValueOnce(replacement);
    await f.open(id);
    resolve(f.projection);
    await pending;
    expect(f.projection.detach).toHaveBeenCalledOnce();
    expect(replacement.detach).not.toHaveBeenCalled();
    expect(f.streams.size()).toBe(1);
    f.streams.close();
  });
  it('requires resnapshot when a subscriber exceeds its buffer', async () => {
    const f = fixture();
    await f.open();
    f.overflow();
    f.change();
    await Promise.resolve();
    expect(f.frames.at(-1)?.code).toBe('resync_required');
    expect(f.streams.size()).toBe(0);
  });
  it('delegates 200 streams to one parent watchdog without duplicate wire pings', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = fixture();
    await f.open();
    expect(vi.getTimerCount()).toBe(1);
    f.streams.delegateTransportLiveness();
    for (let i = 1; i < 200; i++) await f.open();
    expect(vi.getTimerCount()).toBe(0);
    const parent = setInterval(() => {
      if (Date.now() >= 45_000) f.streams.close('transport_lost');
    }, 15_000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.streams.size()).toBe(200);
    expect(f.frames.filter((frame) => frame.type === 'state_ping')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.streams.size()).toBe(0);
    expect(f.projection.detach).toHaveBeenCalledTimes(200);
    clearInterval(parent);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps independent authorization deadlines after liveness delegation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = fixture();
    f.streams.delegateTransportLiveness();
    f.deadline(20_000);
    await f.open();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.frames.at(-1)?.code).toBe('authorization_expired');
    expect(f.streams.size()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
