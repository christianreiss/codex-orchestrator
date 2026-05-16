import { describe, it, expect } from 'vitest';
import { buildWsInfo } from '../../../src/routes/admin/overview/index.js';

describe('buildWsInfo', () => {
  it('returns disabled+null url when ADMIN_WS_ENABLED is false', () => {
    const info = buildWsInfo({ ADMIN_WS_ENABLED: false });
    expect(info.enabled).toBe(false);
    expect(info.url).toBeNull();
  });

  it('uses ADMIN_WS_PUBLIC_URL when it looks like a ws:// or wss:// URL', () => {
    const info = buildWsInfo({
      ADMIN_WS_ENABLED: true,
      ADMIN_WS_PUBLIC_URL: 'wss://orch.example.com/admin/ws',
    });
    expect(info.enabled).toBe(true);
    expect(info.url).toBe('wss://orch.example.com/admin/ws');
  });

  it('derives wss:// from PUBLIC_BASE_URL https://', () => {
    const info = buildWsInfo({
      ADMIN_WS_ENABLED: true,
      PUBLIC_BASE_URL: 'https://orch.example.com',
    });
    expect(info.url).toBe('wss://orch.example.com/admin/ws');
  });

  it('falls back to relative /admin/ws when no public url is set', () => {
    const info = buildWsInfo({ ADMIN_WS_ENABLED: true });
    expect(info.url).toBe('/admin/ws');
  });

  it('clamps heartbeat to minimum 5 and backlog to 1..500', () => {
    expect(buildWsInfo({ ADMIN_WS_ENABLED: false, ADMIN_WS_HEARTBEAT_SECONDS: 1 }).heartbeat_seconds).toBe(5);
    expect(buildWsInfo({ ADMIN_WS_ENABLED: false, ADMIN_WS_BACKLOG_LIMIT: 0 }).backlog_limit).toBe(1);
    expect(buildWsInfo({ ADMIN_WS_ENABLED: false, ADMIN_WS_BACKLOG_LIMIT: 9999 }).backlog_limit).toBe(500);
    expect(buildWsInfo({ ADMIN_WS_ENABLED: false, ADMIN_WS_HEARTBEAT_SECONDS: 60 }).heartbeat_seconds).toBe(60);
  });
});
