import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildInstallerLauncherScript, buildLegacyWrapperTransitionScript, buildWrapperV2InstallerScript } from '../../../src/services/wrapper-transition.js';
import { buildSeedAuthScript } from '../../../src/services/install-token.js';
import { hostSpawnSetupScript } from '../../../src/services/host-spawn.js';
const root = resolve(import.meta.dirname, '../../../../');
const opts = { fqdn: 'fixture.test', apiKey: 'fixture-only', baseUrl: 'https://fixture.invalid', engine: 'codex' as const };
function scratch(run: (dir: string) => void) { const dir = mkdtempSync(join(tmpdir(), 'slop-cli-safety-')); try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); } }
function executable(path: string, body: string) { writeFileSync(path, body); chmodSync(path, 0o755); }
describe('safe CLI discovery and truthful readiness', () => {
  for (const [name, source] of [['launcher', buildInstallerLauncherScript({ ...opts, installUrl: 'https://fixture.invalid/install/test' })], ['installer', buildWrapperV2InstallerScript(opts)], ['transition', buildLegacyWrapperTransitionScript(opts)]] as const) {
    it(`${name} help bypasses dependencies and all filesystem effects`, () => scratch(dir => {
      const script = join(dir, 'script'); writeFileSync(script, source);
      const r = spawnSync('/bin/sh', [script, '--help'], { encoding: 'utf8', env: { PATH: '/missing', HOME: join(dir, 'missing') } });
      expect(r.status, r.stderr).toBe(0); expect(r.stdout).toContain('Usage:'); expect(existsSync(join(dir, 'missing'))).toBe(false);
    }));
  }
  for (const [name, source] of [
    ...(['codex', 'claude', 'grok'] as const).map(engine => [`seed-${engine}`, buildSeedAuthScript({ baseUrl: 'https://fixture.invalid', token: 'fixture', engine })] as const),
    ['host-none', hostSpawnSetupScript('https://fixture.invalid/install', { mode: 'none' })],
    ['host-permanent', hostSpawnSetupScript('https://fixture.invalid/install', { mode: 'permanent', username: 'fixture', default_cwd: '/fixture' })],
    ['host-timed', hostSpawnSetupScript('https://fixture.invalid/install', { mode: 'timed', username: 'fixture', default_cwd: '/fixture', duration_minutes: 10 })],
  ] as const) {
    it(`${name} validates help and unsupported flags before operational commands`, () => scratch(dir => {
      const script = join(dir, 'script'); writeFileSync(script, source);
      for (const [flag, status] of [['--help', 0], ['-h', 0], ['--dry-run', 2], ['--unknown', 2]] as const) {
        const r = spawnSync('/bin/sh', [script, flag], { encoding: 'utf8', env: { PATH: '/missing', HOME: join(dir, 'missing'), TMPDIR: join(dir, 'missing') } });
        expect(r.status, r.stderr).toBe(status);
        if (status === 0) { expect(r.stdout).toContain('Usage:'); expect(r.stderr).toBe(''); }
        else expect(r.stderr).toContain('Unsupported');
        expect(readdirSync(dir)).toEqual(['script']);
      }
    }));
  }
  it.each(['FreeBSD:x86_64', 'Linux:mips'])('unsupported platform %s stops before claim or mkdir', pair => scratch(dir => {
    const [os, arch] = pair.split(':'); const bin = join(dir, 'bin'); mkdirSync(bin);
    executable(join(bin, 'uname'), `#!/bin/sh\ncase "$1" in -s) echo ${os};; -m) echo ${arch};; esac\n`);
    const script = join(dir, 'launcher'); writeFileSync(script, buildInstallerLauncherScript({ ...opts, installUrl: 'https://fixture.invalid/install/test' }));
    const r = spawnSync('/bin/sh', [script], { encoding: 'utf8', env: { PATH: bin, HOME: dir, BIN_DIR: join(dir, 'new-bin') } });
    expect(r.status).toBe(1); expect(r.stderr).toContain('Unsupported'); expect(r.stderr).toContain('NOT consumed'); expect(existsSync(join(dir, 'new-bin'))).toBe(false);
  }));
  it('setup preserves all caller arguments for installer validation', () => scratch(dir => {
    writeFileSync(join(dir, 'setup.sh'), readFileSync(join(root, 'bin/setup.sh'))); executable(join(dir, 'install.sh'), '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    for (const flag of ['--help', '--dry-run', '--non-interactive', '--obsolete']) { const r = spawnSync('bash', [join(dir, 'setup.sh'), flag], { encoding: 'utf8' }); expect(r.status).toBe(0); expect(r.stdout.trim()).toBe(flag); }
  }));
  it.each(['wrapper-v2-init-keys.sh', 'update-base-images.sh'])('%s validates arguments before any dependencies', script => {
    for (const [flag, status] of [['--help', 0], ['--dry-run', 2], ['--unknown', 2]] as const) { const r = spawnSync('/bin/bash', [join(root, 'scripts', script), flag], { encoding: 'utf8', env: { PATH: '/missing' } }); expect(r.status, r.stderr).toBe(status); }
  });
  it('missing scan input is incomplete rather than clean', () => scratch(dir => { const r = spawnSync('bash', [join(root, 'scripts/slop-grep.sh'), join(dir, 'missing')], { encoding: 'utf8' }); expect(r.status).toBe(3); expect(r.stderr).toContain('cannot inspect'); expect(r.stdout).not.toContain('no findings'); }));
  const installer = readFileSync(join(root, 'bin/install.sh'), 'utf8');
  const functions = installer.slice(installer.indexOf('readyz_failures() {'), installer.indexOf('# report_readyz_failures BODY'));
  function readiness(body: string, fn: string) { return spawnSync('bash', ['-c', `compose() { while [ "$1" != node ]; do shift; done; "$@"; }\n${functions}\n${fn} "$BODY"`], { encoding: 'utf8', env: { ...process.env, BODY: body } }); }
  it.each(['{"ok":false,"checks":[{"id":"db","ok":true}]}', '{}', 'garbled', '{"ok":true,"checks":null}'])('rejects malformed or not-ready response %s', body => { expect(readiness(body, 'readyz_overall_ok').status).not.toBe(0); expect(readiness(body, 'readyz_failures').stdout).not.toBe(''); });
  it('accepts valid healthy readiness', () => { const body = '{"ok":true,"checks":[{"id":"db","ok":true}]}'; expect(readiness(body, 'readyz_overall_ok').status).toBe(0); expect(readiness(body, 'readyz_failures').stdout).toBe(''); });
  it.each(['codex', 'claude', 'grok'] as const)('reports current sanitized rejection and cleans response for %s', engine => scratch(dir => {
    const bin = join(dir, 'bin'); mkdirSync(bin); for (const p of ['.codex', '.claude']) mkdirSync(join(dir, p));
    writeFileSync(join(dir, '.codex/auth.json'), '{}'); writeFileSync(join(dir, '.claude/.credentials.json'), '{}'); const auth = join(dir, 'grok.json'); writeFileSync(auth, '{}');
    executable(join(bin, 'curl'), '#!/bin/sh\nout=\nprev=\nfor a in "$@"; do [ "$prev" != -o ] || out=$a; prev=$a; done\nprintf \'{"error":{"code":"seed_token_expired"},"private":"never-print-me"}\' > "$out"\nprintf 404\n');
    const script = join(dir, 'seed'); writeFileSync(script, buildSeedAuthScript({ baseUrl: 'https://fixture.invalid', token: 'fixture', engine }));
    const r = spawnSync('/bin/sh', [script], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HOME: dir, TMPDIR: dir, GROK_SEED_AUTH_PATH: auth } });
    expect(r.status, r.stderr).toBe(1); expect(r.stderr).toContain('seed token missing or expired'); expect(r.stderr).toContain('seed_token_expired'); expect(r.stderr + r.stdout).not.toContain('never-print-me'); expect(readdirSync(dir).filter(n => n.includes('seed-response'))).toEqual([]);
  }));
});
