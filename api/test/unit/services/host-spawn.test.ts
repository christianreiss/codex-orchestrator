import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { hostSpawnSchema, hostSpawnStatusSchema, hostSpawnSetupScript, hostSpawnCompletionScript } from '../../../src/services/host-spawn.js';
import { daemonAccepting, daemonExpired } from '../../../src/services/host-daemon/policy.js';
const base = () => ({ fqdn: 'new.example.test', engines: ['codex'], client_message_id: randomUUID() });
describe('system spawn contracts', () => {
  it('defaults to secure without a daemon and normalizes identity', () => {
    expect(hostSpawnSchema.parse({ ...base(), fqdn: 'NEW.Example.Test', engines: ['grok', 'codex', 'codex'] }))
      .toMatchObject({ fqdn: 'new.example.test', secure: true, daemon: { mode: 'none' }, engines: ['codex', 'grok'] });
  });
  it.each([
    { engines: [] }, { engines: ['other'] }, { secure: 'false' }, { vip: true }, { source_host_id: 1 },
    { fqdn: 'new.test; echo x' }, { daemon: { mode: 'timed', duration_minutes: 0 } },
    { daemon: { mode: 'permanent', default_cwd: '/tmp' } },
    { daemon: { mode: 'timed', username: 'root', default_cwd: 'relative', duration_minutes: 1 } },
  ])('rejects invalid or privilege-granting inputs %j', patch => {
    expect(hostSpawnSchema.safeParse({ ...base(), ...patch }).success).toBe(false);
  });
  it('requires an idempotency UUID for installer renewal', () => {
    expect(hostSpawnStatusSchema.safeParse({ operation_id: randomUUID(), renew_installer: true }).success).toBe(false);
  });
  it('does not expire before first connection and stops acceptance exactly at deadline', () => {
    const settings = { enabled: true, lifetime_minutes: 1, username: 'root', default_cwd: '/tmp', max_parallel: 8, idle_minutes: 60, question_minutes: 1440 };
    expect(daemonAccepting(settings)).toBe(true);
    const deadline = { expires_at: '2026-10-11T12:00:00Z' };
    expect(daemonExpired(deadline, Date.parse(deadline.expires_at) - 1)).toBe(false);
    expect(daemonExpired(deadline, Date.parse(deadline.expires_at))).toBe(true);
    expect(daemonAccepting({ ...settings, expires_at: new Date(Date.now() - 1).toISOString() })).toBe(false);
  });
  it.each(['none', 'permanent', 'timed'] as const)('generates valid shell for %s setup', mode => {
    const daemon = mode === 'none' ? { mode } : { mode, username: 'root', default_cwd: '/tmp/a b', duration_minutes: 1 };
    const script = hostSpawnSetupScript("https://example.test/install/a'b", daemon);
    expect(spawnSync('/bin/sh', ['-n'], { input: script }).status).toBe(0);
  });
  it('a failed installer download never executes an empty or partial installer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-setup-'));
    try {
      writeFileSync(join(dir, 'curl'), '#!/bin/sh\nexit 23\n', { mode: 0o755 });
      writeFileSync(join(dir, 'sh'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
      const script = hostSpawnSetupScript('https://example.test/install/token', { mode: 'none' });
      expect(spawnSync('/bin/sh', ['-c', script], { env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` } }).status).toBe(23);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([
    { ipv4: 0, fallback: 99, expected: 0, calls: 'ipv4\n' },
    { ipv4: 7, fallback: 0, expected: 0, calls: 'ipv4\ndefault\n' },
    { ipv4: 22, fallback: 22, expected: 22, calls: 'ipv4\ndefault\n' },
  ])('completion uses the bound IPv4 route, falls back and preserves failure: %j', test => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-callback-'));
    try {
      const calls = join(dir, 'calls');
      writeFileSync(join(dir, 'curl'), `#!/bin/sh\nfor arg; do\n if [ "$arg" = '-4' ]; then echo ipv4 >> "$CALLS"; exit ${test.ipv4}; fi\ndone\necho default >> "$CALLS"\nexit ${test.fallback}\n`, { mode: 0o755 });
      const script = '#!/bin/sh\nset -eu\n' + hostSpawnCompletionScript() + '\necho success\n';
      const result = spawnSync('/bin/sh', ['-c', script], { env: { ...process.env, PATH: `${dir}:/usr/bin:/bin`,
        CURL_INSECURE_FLAG: '', HOST_API_KEY: 'test-key', BASE_URL: 'https://example.test', STEP_LOG: join(dir, 'step.log'), CALLS: calls } });
      expect(result.status).toBe(test.expected);
      expect(readFileSync(calls, 'utf8')).toBe(test.calls);
      expect(result.stdout.toString().includes('success')).toBe(test.expected === 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
