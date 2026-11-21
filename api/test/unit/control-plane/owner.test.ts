import { EventEmitter } from 'node:events';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { ControlPlaneOwnership } from '../../../src/control-plane/owner.js';

function fixture(acquired = 1) {
  const connection = Object.assign(new EventEmitter(), {
    query: vi.fn(async () => [[{ acquired }], []]),
    execute: vi.fn(async () => [{ affectedRows: 1 }, []]),
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    destroy: vi.fn(),
  });
  const pool = { getConnection: vi.fn(async () => connection) };
  const owner = new ControlPlaneOwnership(pool as unknown as Pool, 'isolated_test');
  return { owner, pool, connection };
}
describe('exclusive owner lifetime', () => {
  it('holds one connection through boot, hydration and ready serving with no lease polling', async () => {
    const f = fixture();
    expect(() => f.owner.assertReady()).toThrow();
    const connection = await f.owner.acquire();
    const load = vi.fn(async (received: PoolConnection, epoch: string) => ({
      same: received === connection,
      epoch,
    }));
    const snapshot = await f.owner.hydrate(load);
    expect(snapshot.same).toBe(true);
    expect(snapshot.epoch).toBe(f.owner.epoch);
    expect(() => f.owner.assertReady()).toThrow();
    f.owner.ready();
    f.owner.assertReady();
    expect(f.owner.heldConnection()).toBe(connection);
    expect(f.pool.getConnection).toHaveBeenCalledOnce();
    expect(f.connection.query).toHaveBeenCalledTimes(3);
    expect(f.connection.query).toHaveBeenCalledWith('SET SESSION wait_timeout = 31536000');
  });
  it('refuses a second owner and never reuses the rejected connection', async () => {
    const f = fixture(0);
    await expect(f.owner.acquire()).rejects.toThrow('Another');
    expect(f.connection.destroy).toHaveBeenCalledOnce();
    await expect(f.owner.acquire()).rejects.toThrow('reused');
  });
  it('invalidates reads and control streams immediately on connection loss', async () => {
    const f = fixture();
    await f.owner.acquire();
    await f.owner.hydrate(async () => ({}));
    f.owner.ready();
    const closeStreams = vi.fn();
    f.owner.onLost(closeStreams);
    f.connection.emit('error', new Error('database unreachable'));
    expect(() => f.owner.assertReady()).toThrow('lost');
    expect(() => f.owner.heldConnection()).toThrow('lost');
    expect(closeStreams).toHaveBeenCalledOnce();
    expect(f.connection.destroy).toHaveBeenCalledOnce();
    f.connection.emit('end');
    expect(closeStreams).toHaveBeenCalledOnce();
    await f.owner.close();
    expect(closeStreams).toHaveBeenCalledOnce();
  });
  it('reports a loss during server setup to the process listener attached before listen', async () => {
    const f = fixture();
    await f.owner.acquire();
    await f.owner.hydrate(async () => ({}));
    f.owner.ready();
    const loss = new Error('connection lost during route registration');
    f.connection.emit('error', loss);
    const restart = vi.fn();
    f.owner.onLost(restart);
    expect(restart).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledWith(loss);
  });
  it('withdraws readiness during a slow planned unlock without requesting a restart', async () => {
    const f = fixture();
    await f.owner.acquire();
    await f.owner.hydrate(async () => ({}));
    f.owner.ready();
    const restart = vi.fn();
    f.owner.onLost(restart);
    let acknowledge!: () => void;
    f.connection.query.mockImplementationOnce(() => new Promise(resolve => {
      acknowledge = () => resolve([[{ acquired: 1 }], []]);
    }));
    const closing = f.owner.close();
    expect(() => f.owner.assertReady()).toThrow('closed');
    expect(f.connection.destroy).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    acknowledge();
    await closing;
    expect(f.connection.destroy).toHaveBeenCalledOnce();
    expect(restart).not.toHaveBeenCalled();
  });
  it('cannot become ready after failed hydration or unknown bootstrap commit', async () => {
    const f = fixture();
    await f.owner.acquire();
    f.connection.commit.mockRejectedValueOnce(new Error('commit connection lost'));
    await expect(f.owner.hydrate(async () => ({}))).rejects.toThrow('commit');
    expect(() => f.owner.ready()).toThrow();
    expect(f.owner.status()).toBe('lost');
  });
});
