import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { attachHostDaemonSocket } from '../../../src/routes/host-daemon.js';
import { HostDaemonService } from '../../../src/services/host-daemon/service.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { hostDaemonOperations } from '../../../src/db/schema.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { createDbFake } from '../../helpers/db-fake.js';

const auth = vi.hoisted(() => vi.fn());
vi.mock('../../../src/services/host-auth.js', () => ({ createHostAuthService: () => ({ authenticate: auth }) }));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); auth.mockReset(); });

describe('daemon idle transport ticks', () => {
  it('uses one queue read, no authentication or transaction while empty, then offers new work', async () => {
    vi.useFakeTimers();
    const db = createDbFake(new Map([[hostDaemonOperations, [] as Record<string, unknown>[]]]));
    const socket = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn() });
    auth.mockResolvedValue({ id: 1 });
    vi.spyOn(HostDaemonService.prototype, 'connect').mockResolvedValue({ generation: 'current' } as never);
    vi.spyOn(HostDaemonService.prototype, 'disconnect').mockResolvedValue(undefined as never);
    const settings = vi.spyOn(HostDaemonService.prototype, 'settings').mockResolvedValue({ settings: { enabled: true } } as never);
    const offer = vi.spyOn(HostDaemonService.prototype, 'offer').mockResolvedValue({ operation_id: 'work' } as never);
    attachHostDaemonSocket(socket, {} as FastifyRequest, { db } as unknown as RouteContext);
    socket.emit('message', { toString: () => JSON.stringify({ id: randomUUID(), type: 'hello', payload: { instance_id: randomUUID(), username: 'root', version: 'test', engines: ['codex'] } }) });
    await vi.advanceTimersByTimeAsync(0);
    auth.mockClear();
    const select = vi.spyOn(db, 'select');
    const transaction = vi.spyOn(db, 'transaction');
    // Three 60 s reconciliation ticks.
    await vi.advanceTimersByTimeAsync(180000);
    expect(select).toHaveBeenCalledTimes(3);
    expect(transaction).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
    expect(offer).not.toHaveBeenCalled();
    db.tables.set(hostDaemonOperations, [{ id: 'work', hostId: 1, status: 'queued' }]);
    wsPublisher.publish('host.daemon.operation.queued', { host_id: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(auth).toHaveBeenCalledTimes(1);
    expect(offer).toHaveBeenCalledWith(1, 'current');
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'operation', operation: { operation_id: 'work' } }));
    socket.emit('close');
    const reads = select.mock.calls.length;
    wsPublisher.publish('host.daemon.operation.queued', { host_id: 1 });
    await vi.advanceTimersByTimeAsync(120000);
    expect(select).toHaveBeenCalledTimes(reads);
  });

  it('rechecks an event received while an empty peek is in flight', async () => {
    vi.useFakeTimers();
    const db = createDbFake(new Map());
    const socket = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn() });
    auth.mockResolvedValue({ id: 1 });
    vi.spyOn(HostDaemonService.prototype, 'connect').mockResolvedValue({ generation: 'current' } as never);
    vi.spyOn(HostDaemonService.prototype, 'disconnect').mockResolvedValue(undefined as never);
    vi.spyOn(HostDaemonService.prototype, 'settings').mockResolvedValue({ settings: { enabled: true } } as never);
    let release!: (empty: boolean) => void;
    const peek = vi.spyOn(HostDaemonService.prototype, 'hasPendingOffer')
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; }))
      .mockResolvedValue(true);
    const offer = vi.spyOn(HostDaemonService.prototype, 'offer').mockResolvedValue({ operation_id: 'work' } as never);
    attachHostDaemonSocket(socket, {} as FastifyRequest, { db } as unknown as RouteContext);
    socket.emit('message', { toString: () => JSON.stringify({ id: randomUUID(), type: 'hello', payload: { instance_id: randomUUID(), username: 'root', version: 'test', engines: ['codex'] } }) });
    await vi.advanceTimersByTimeAsync(0);
    wsPublisher.publish('host.daemon.operation.queued', { host_id: 2 });
    wsPublisher.publish('host.daemon.operation.queued', { host_id: 1 });
    release(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(peek).toHaveBeenCalledTimes(2);
    expect(offer).toHaveBeenCalledTimes(1);
    socket.emit('close');
  });

  it('never offers pending work after authentication is revoked', async () => {
    vi.useFakeTimers();
    const db = createDbFake(new Map([[hostDaemonOperations, [{ id: 'work', hostId: 1, status: 'queued' }]]]));
    const socket = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn() });
    auth.mockResolvedValueOnce({ id: 1 }).mockRejectedValue(new Error('revoked'));
    vi.spyOn(HostDaemonService.prototype, 'connect').mockResolvedValue({ generation: 'current' } as never);
    vi.spyOn(HostDaemonService.prototype, 'disconnect').mockResolvedValue(undefined as never);
    const offer = vi.spyOn(HostDaemonService.prototype, 'offer');
    attachHostDaemonSocket(socket, {} as FastifyRequest, { db } as unknown as RouteContext);
    socket.emit('message', { toString: () => JSON.stringify({ id: randomUUID(), type: 'hello', payload: { instance_id: randomUUID(), username: 'root', version: 'test', engines: ['codex'] } }) });
    await vi.advanceTimersByTimeAsync(2000);
    expect(offer).not.toHaveBeenCalled();
    socket.emit('close');
  });
});
