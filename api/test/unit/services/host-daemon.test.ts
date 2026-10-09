import { describe, it, expect } from 'vitest';
import {
  daemonSettingsSchema,
  daemonHealth,
  type DaemonRuntime,
} from '../../../src/services/host-daemon/policy.js';
const now = Date.parse('2026-10-09T12:00:00Z');
const settings = daemonSettingsSchema.parse({ enabled: true });
const runtime: DaemonRuntime = {
  instance_id: 'one',
  generation: 'one',
  username: 'root',
  version: 'test',
  heartbeat_at: new Date(now).toISOString(),
  connected: true,
  engines: ['codex', 'claude', 'grok'],
  error: null,
};
const health = (delta = 0, patch: Partial<DaemonRuntime> = {}, used = 0) =>
  daemonHealth(settings, { ...runtime, ...patch }, null, used, ['codex', 'claude', 'grok'], now + delta);
describe('optional host daemon policy', () => {
  it('defaults to disabled, root, eight slots, 60m idle and 24h questions', () =>
    expect(daemonSettingsSchema.parse({})).toEqual({
      enabled: false,
      username: 'root',
      default_cwd: '',
      max_parallel: 8,
      idle_minutes: 60,
      question_minutes: 1440,
    }));
  it('does not display enabled health for disabled hosts', () =>
    expect(daemonHealth(daemonSettingsSchema.parse({}), runtime, null, 0, [], now).state).toBe('disabled'));
  it('changes green to yellow at 45 seconds and red at 90', () => {
    expect(health(44_999).state).toBe('green');
    expect(health(45_000).state).toBe('yellow');
    expect(health(89_999).state).toBe('yellow');
    expect(health(90_000).state).toBe('red');
  });
  it('distinguishes busy and partially ready from unavailable', () => {
    expect(health(0, {}, 8).state).toBe('yellow');
    expect(health(0, { engines: ['claude'] }).state).toBe('yellow');
    expect(health(0, { engines: [] }).state).toBe('red');
    expect(health(0, { error: 'auth_failed' }, 8).state).toBe('red');
  });
  it('shows a disconnected transport immediately', () =>
    expect(health(0, { connected: false }).state).toBe('yellow'));
  it('allows five minutes for installation', () => {
    const enabled = new Date(now).toISOString();
    expect(daemonHealth(settings, null, enabled, 0, [], now + 299_999).state).toBe('yellow');
    expect(daemonHealth(settings, null, enabled, 0, [], now + 300_000).state).toBe('red');
  });
  it('rejects unsafe account syntax, nonabsolute cwd and unbounded capacity', () => {
    for (const patch of [
      { username: 'root\nExecStart=/bin/sh' },
      { default_cwd: 'relative' },
      { max_parallel: 0 },
      { max_parallel: 65 },
    ])
      expect(daemonSettingsSchema.safeParse(patch).success).toBe(false);
  });
});
