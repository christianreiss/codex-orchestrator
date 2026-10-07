import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CompanionLive,
  type CompanionLiveSources,
  type CompanionSocket,
} from '../../../src/services/companion/live.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { UnauthorizedError } from '../../../src/http/errors.js';

class Socket implements CompanionSocket {
  readyState = 1;
  bufferedAmount = 0;
  code?: number;
  frames: Array<{ type: string; scopes?: string[] }> = [];
  listeners = new Map<string, () => void>();
  send(raw: string) {
    this.frames.push(JSON.parse(raw));
  }
  close(code?: number) {
    this.code = code;
    this.readyState = 3;
    this.listeners.get('close')?.();
  }
  on(event: 'close' | 'error', listener: () => void) {
    this.listeners.set(event, listener);
  }
}

describe('companion live invalidations', () => {
  let hub: CompanionLive;
  let sources: CompanionLiveSources;
  beforeEach(() => {
    vi.useFakeTimers();
    sources = {
      authorize: vi.fn().mockResolvedValue(['agent_portal.read', 'hosts.activate_insecure']),
      revisions: vi.fn().mockResolvedValue({ agents: 'initial', approvals: 'initial' }),
    };
    hub = new CompanionLive(sources);
  });
  afterEach(async () => {
    await hub.stop();
    vi.useRealTimers();
  });
  async function connect(token = 'device') {
    const socket = new Socket();
    hub.attach(socket, token);
    await vi.advanceTimersByTimeAsync(60);
    return socket;
  }
  it('shares reconciliation, coalesces changes and never forwards publisher payloads', async () => {
    const first = new Socket();
    const second = new Socket();
    hub.attach(first, 'one');
    hub.attach(second, 'two');
    await vi.advanceTimersByTimeAsync(60);
    expect(sources.revisions).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++)
      wsPublisher.publish('agent_portal.sessions.changed', { session_id: 'private-session', text: 'secret' });
    await vi.advanceTimersByTimeAsync(60);
    expect(sources.revisions).toHaveBeenCalledTimes(2);
    expect(first.frames.at(-1)).toMatchObject({ type: 'changed', scopes: ['agents'] });
    expect(JSON.stringify(first.frames)).not.toMatch(/private-session|secret/);
    expect(first.frames).toEqual(second.frames);
  });
  it('reconciles expiry and missed events without client polling', async () => {
    const socket = await connect();
    vi.mocked(sources.revisions).mockResolvedValue({ agents: 'offline', approvals: 'expired' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(socket.frames.at(-1)).toMatchObject({ type: 'changed', scopes: ['agents', 'approvals'] });
  });
  it('filters scopes, notices role changes and closes a revoked device', async () => {
    vi.mocked(sources.authorize).mockResolvedValue(['hosts.activate_insecure']);
    const socket = await connect();
    expect(socket.frames.at(-1)?.scopes).toEqual(['me', 'approvals']);
    vi.mocked(sources.authorize).mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(socket.frames.at(-1)?.scopes).toEqual(['me']);
    vi.mocked(sources.authorize).mockRejectedValue(new UnauthorizedError());
    await vi.advanceTimersByTimeAsync(5000);
    expect(socket.code).toBe(4001);
  });
  it('keeps an unchanged connection alive without reloading data', async () => {
    const socket = await connect();
    const changes = socket.frames.filter((f) => f.type === 'changed').length;
    await vi.advanceTimersByTimeAsync(15_100);
    expect(socket.frames.at(-1)?.type).toBe('ping');
    expect(socket.frames.filter((f) => f.type === 'changed')).toHaveLength(changes);
  });
  it('fails closed on an unavailable or hung authority', async () => {
    const socket = await connect();
    vi.mocked(sources.authorize).mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(15_100);
    expect(socket.code).toBe(1013);
  });
  it('disconnects a slow reader and detaches all callbacks at shutdown', async () => {
    const socket = await connect();
    socket.bufferedAmount = 100_000;
    wsPublisher.publish('insecure.requested', {});
    await vi.advanceTimersByTimeAsync(60);
    expect(socket.code).toBe(1013);
    await hub.stop();
    const count = socket.frames.length;
    wsPublisher.publish('settings.changed', {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.frames).toHaveLength(count);
  });
});
