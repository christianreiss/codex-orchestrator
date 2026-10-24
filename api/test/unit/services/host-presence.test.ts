import { randomUUID } from 'node:crypto';
import type { Database } from '../../../src/db/client.js';
import type { Host } from '../../../src/db/schema.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { OwnerStateStore, OwnerStateSnapshot } from '../../../src/control-plane/state/store.js';
import { ConnectionPresence, bindOwnerPresence } from '../../../src/control-plane/presence.js';
import { stopHostActivity } from '../../../src/control-plane/state/host-activity.js';
import { describe, expect, it, vi } from 'vitest';
import { hostPresence, hostPresenceViews } from '../../../src/services/host-presence.js';

const now = Date.parse('2026-10-19T12:00:00Z');
const host = { status: 'active', expiresAt: null, lastContactAt: '2026-10-18T12:00:00Z' };
describe('host connection evidence', () => {
  it('uses the 45 second boundary independently of last authenticated contact', () => {
    expect(hostPresence(host, ['2026-10-19T11:59:16Z'], now).presence).toBe('online');
    expect(hostPresence(host, ['2026-10-19T11:59:15Z'], now).presence).toBe('offline');
    expect(hostPresence({ ...host, lastContactAt: new Date(now).toISOString() }, [], now).presence).toBe(
      'offline',
    );
  });
  it('rejects future and invalid evidence, disabled and expired hosts', () => {
    for (const value of ['invalid', '2026-10-19T12:00:01Z', null])
      expect(hostPresence(host, [value], now).presence).toBe('offline');
    expect(hostPresence({ ...host, status: 'disabled' }, [new Date(now).toISOString()], now).presence).toBe(
      'offline',
    );
    expect(
      hostPresence({ ...host, expiresAt: new Date(now).toISOString() }, [new Date(now).toISOString()], now)
        .presence,
    ).toBe('offline');
  });
  it('compares RFC3339 instants rather than textual timestamps', () => {
    expect(hostPresence(host, ['2026-10-19T14:00:00+02:00'], now).presence).toBe('online');
  });
});

it('owner presence reads actual attachment changes without SQL or persisted freshness', async () => {
  const db = {
    select: vi.fn(() => {
      throw new Error('presence SQL');
    }),
  } as unknown as Database;
  const h = { id: 1, ...host } as Host,
    state = new OwnerStateStore(
      new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, { hosts: [h] }),
    );
  const runtime = { state, assertOwner() {} } as OwnerRuntime,
    presence = new ConnectionPresence((error) => {
      throw error;
    });
  bindOwnerRuntime(db, runtime);
  bindOwnerPresence(runtime, presence);
  try {
    expect((await hostPresenceViews(db, [h])).get(1)).toMatchObject({
      presence: 'offline',
      presence_source: 'connection',
    });
    const attached = presence.attach({
      connectionId: 'connection',
      hostId: 1,
      username: 'root',
      scope: { topic: 'sync' },
    });
    expect((await hostPresenceViews(db, [h])).get(1)).toMatchObject({
      presence: 'online',
      presence_source: 'connection',
      presence_heartbeat_at: null,
    });
    expect(
      (await hostPresenceViews(db, [{ ...h, expiresAt: '2000-01-01T00:00:00Z' }])).get(1)?.presence,
    ).toBe('offline');
    attached.detach();
    expect((await hostPresenceViews(db, [h])).get(1)?.presence).toBe('offline');
    expect(db.select).not.toHaveBeenCalled();
  } finally {
    stopHostActivity(runtime);
    presence.close();
  }
});
