import { describe, expect, it } from 'vitest';
import { hostPresence } from '../../../src/services/host-presence.js';

const now = Date.parse('2026-10-19T12:00:00Z');
const host = { status: 'active', expiresAt: null, lastContactAt: '2026-10-18T12:00:00Z' };
describe('host connection evidence', () => {
  it('uses the 45 second boundary independently of last authenticated contact', () => {
    expect(hostPresence(host, ['2026-10-19T11:59:16Z'], now).presence).toBe('online');
    expect(hostPresence(host, ['2026-10-19T11:59:15Z'], now).presence).toBe('offline');
    expect(hostPresence({ ...host, lastContactAt: new Date(now).toISOString() }, [], now).presence).toBe('offline');
  });
  it('rejects future and invalid evidence, disabled and expired hosts', () => {
    for (const value of ['invalid', '2026-10-19T12:00:01Z', null]) expect(hostPresence(host, [value], now).presence).toBe('offline');
    expect(hostPresence({ ...host, status: 'disabled' }, [new Date(now).toISOString()], now).presence).toBe('offline');
    expect(hostPresence({ ...host, expiresAt: new Date(now).toISOString() }, [new Date(now).toISOString()], now).presence).toBe('offline');
  });
  it('compares RFC3339 instants rather than textual timestamps', () => {
    expect(hostPresence(host, ['2026-10-19T14:00:00+02:00'], now).presence).toBe('online');
  });
});
