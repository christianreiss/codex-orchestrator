import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildInstallerLauncherScript,
  buildWrapperV2InstallerScript,
} from '../../../src/services/wrapper-transition.js';

// The TrueNAS preflight is shell. These tests cut the shared preflight
// functions out of the generated launcher and run them in a sandboxed `sh`:
// uname, cat (for /etc/version), sudo and chmod are shimmed through PATH, the
// manifest location is the TRUENAS_MANIFEST hook and HOME/BIN_DIR are temp
// directories. Real read-only and noexec mounts come from an unprivileged
// user+mount namespace (`unshare -Urm`) and are skipped where that is denied.

const launcher = buildInstallerLauncherScript({
  fqdn: 'h.example',
  engine: 'codex',
  installUrl: 'https://o.example/install/v2/tok',
});
const preflightSource = launcher.slice(
  launcher.indexOf('ensure_bin_root() {'),
  launcher.indexOf('# Invoked indirectly by the EXIT trap'),
);

let root: string;
let shims: string;
let unshareWorks = false;
const isRoot = process.getuid?.() === 0;

function shim(name: string, body: string): void {
  const path = join(shims, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
}

interface Options {
  os?: 'Linux' | 'FreeBSD';
  manifest?: string | null; // file content, null = no manifest
  etcVersion?: string; // /etc/version for the FreeBSD shim
  productName?: string; // /etc/product_name for the FreeBSD shim
  binDir: string;
  home: string;
  /** Wrap the run in `unshare -Urm` with these mount commands first. */
  mounts?: string;
  /** Simulate a noexec mount by leaving probe scripts non-executable. */
  simulateNoexec?: boolean;
  /** Define a ui_warn like the full installer does. */
  withWarn?: boolean;
}

function run(options: Options): { status: number | null; out: string; failed: string } {
  const dir = mkdtempSync(join(root, 'case-'));
  const manifestPath = join(dir, 'manifest.json');
  if (options.manifest != null) writeFileSync(manifestPath, options.manifest, 'utf8');
  shim('uname', `case "$1" in -s) echo ${options.os ?? 'Linux'} ;; -m) echo x86_64 ;; *) echo ${options.os ?? 'Linux'} ;; esac`);
  shim('sudo', 'exit 1');
  shim(
    'cat',
    [
      'case "$1" in',
      `/etc/version) ${options.etcVersion != null ? `printf '%s\\n' '${options.etcVersion}'` : 'exit 1'} ;;`,
      `/etc/product_name) ${options.productName != null ? `printf '%s\\n' '${options.productName}'` : 'exit 1'} ;;`,
      '*) exec /bin/cat "$@" ;;',
      'esac',
    ].join('\n'),
  );
  shim('chmod', options.simulateNoexec ? 'case "$2" in *.cxx-probe.*) exit 0 ;; esac\nexec /bin/chmod "$@"' : 'exec /bin/chmod "$@"');
  shim('sysctl', 'echo 1');
  for (const tool of ['python3', 'curl']) shim(tool, 'exit 0');
  const script = join(dir, 'harness.sh');
  writeFileSync(
    script,
    [
      'set -eu',
      "NAME=cdx; PFSENSE_CODEX_ONLY=1; INSTALL_WITH_SUDO=0; BIN_ROOT=$BIN_DIR",
      'ui_fail() { printf "FAIL %s %s | %s | %s\\n" "$1" "$2" "$3" "$4"; }',
      options.withWarn ? 'ui_warn() { printf "WARN %s %s | %s | %s\\n" "$1" "$2" "$3" "$4"; }' : ':',
      'TRUENAS_MANIFEST=${TRUENAS_MANIFEST:-}',
      preflightSource,
      'preflight_checks',
      'echo "PREFLIGHT_FAILED=$PREFLIGHT_FAILED"',
    ].join('\n'),
    'utf8',
  );
  const env = {
    PATH: `${shims}:/usr/bin:/bin`,
    HOME: options.home,
    BIN_DIR: options.binDir,
    TRUENAS_MANIFEST: manifestPath,
    TERM: 'dumb',
  };
  const result = options.mounts
    ? spawnSync('unshare', ['-Urm', 'sh', '-c', `${options.mounts}\nexec sh "$0"`, script], { encoding: 'utf8', env })
    : spawnSync('sh', [script], { encoding: 'utf8', env });
  const out = (result.stdout ?? '') + (result.stderr ?? '');
  return { status: result.status, out, failed: /PREFLIGHT_FAILED=(\d)/.exec(out)?.[1] ?? '?' };
}

function freshDirs(): { bin: string; home: string } {
  const dir = mkdtempSync(join(root, 'dirs-'));
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  return { bin, home };
}

const SCALE_MANIFEST = '{"version": "25.04.2", "buildtime": 1}';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'truenas-preflight-'));
  shims = join(root, 'shims');
  mkdirSync(shims);
  const probe = spawnSync('unshare', ['-Urm', 'sh', '-c', `mount -t tmpfs -o noexec tmpfs "${root}/shims/.." 2>/dev/null`], {
    encoding: 'utf8',
  });
  unshareWorks = probe.status === 0;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('TrueNAS installer preflight', () => {
  it('is emitted by both the launcher and the installer and stays valid POSIX shell', () => {
    const installer = buildWrapperV2InstallerScript({
      fqdn: 'h.example',
      apiKey: 'sk-codex-test',
      baseUrl: 'https://o.example/',
      engine: 'codex',
    });
    for (const script of [launcher, installer]) {
      expect(script).toContain('detect_truenas()');
      expect(script).toContain('truenas_preflight()');
      expect(script).toContain('/data/manifest.json');
      expect(script).toContain('TrueNAS CORE is not supported');
    }
    const check = spawnSync('sh', ['-n'], { input: installer, encoding: 'utf8' });
    expect(check.status).toBe(0);
    const checkLauncher = spawnSync('sh', ['-n'], { input: launcher, encoding: 'utf8' });
    expect(checkLauncher.status).toBe(0);
  });

  it('passes on SCALE with a writable, executable bin dir and home, and warns about upgrades', () => {
    const { bin, home } = freshDirs();
    const result = run({ manifest: SCALE_MANIFEST, binDir: join(bin, 'nested'), home, withWarn: true });
    expect(result.out).not.toMatch(/^FAIL /m);
    expect(result.failed).toBe('0');
    expect(result.out).toContain('WARN cxx TrueNAS upgrade | after an upgrade run: cxx cron install |');
  });

  it('leaves no probe residue behind', () => {
    const { bin, home } = freshDirs();
    run({ manifest: SCALE_MANIFEST, binDir: bin, home });
    const listing = spawnSync('ls', ['-A', bin, home], { encoding: 'utf8' }).stdout;
    expect(listing).not.toContain('.cxx-probe');
  });

  it('does not treat a manifest without a version key, or no manifest, as TrueNAS', () => {
    for (const manifest of ['{"buildtime": 1}', null]) {
      const { bin, home } = freshDirs();
      const result = run({ manifest, binDir: bin, home, withWarn: true });
      expect(result.out).not.toContain('TrueNAS');
      expect(result.failed).toBe('0');
    }
  });

  it.skipIf(isRoot)('fails on SCALE when the bin dir is not writable (write test, not mkdir -p)', () => {
    const { bin, home } = freshDirs();
    chmodSync(bin, 0o555);
    try {
      // The directory exists, so mkdir -p succeeds; only the write test catches it.
      const result = run({ manifest: SCALE_MANIFEST, binDir: bin, home, withWarn: true });
      expect(result.failed).toBe('1');
      expect(result.out).toContain('is read-only or not writable on TrueNAS SCALE');
      expect(result.out).toContain('BIN_DIR=/root/.local/bin');
      expect(result.out).not.toContain('WARN');
    } finally {
      chmodSync(bin, 0o755);
    }
  });

  it('reports a noexec bin dir and a noexec home as separate lines (simulated noexec)', () => {
    const { bin, home } = freshDirs();
    const result = run({ manifest: SCALE_MANIFEST, binDir: bin, home, simulateNoexec: true, withWarn: true });
    expect(result.failed).toBe('1');
    expect(result.out).toContain(`${bin} is mounted noexec on TrueNAS SCALE`);
    expect(result.out).toContain('engine binaries under');
    expect(result.out).toContain('/home is mounted noexec on SCALE');
    expect(result.out.match(/^FAIL /gm)).toHaveLength(2);
    expect(result.out).not.toContain('WARN');
  });

  it.skipIf(isRoot)('keeps the legacy preflight path on a non-TrueNAS host', () => {
    const { bin, home } = freshDirs();
    chmodSync(bin, 0o555);
    try {
      const result = run({ manifest: null, binDir: bin, home, withWarn: true });
      expect(result.failed).toBe('1');
      expect(result.out).toContain('is not writable and sudo -n is unavailable');
      expect(result.out).not.toContain('TrueNAS');
    } finally {
      chmodSync(bin, 0o755);
    }
  });

  describe('with real mounts (user+mount namespace)', () => {
    it('rejects a read-only bin dir on SCALE', (ctx) => {
      if (!unshareWorks) return ctx.skip();
      const { bin, home } = freshDirs();
      const result = run({
        manifest: SCALE_MANIFEST,
        binDir: bin,
        home,
        mounts: `mount -t tmpfs tmpfs "${bin}" && mount -o remount,ro,bind "${bin}" "${bin}"`,
      });
      expect(result.failed).toBe('1');
      expect(result.out).toContain('is read-only or not writable on TrueNAS SCALE');
    });

    it('rejects a noexec bin dir and a noexec home on SCALE', (ctx) => {
      if (!unshareWorks) return ctx.skip();
      const { bin, home } = freshDirs();
      const result = run({
        manifest: SCALE_MANIFEST,
        binDir: bin,
        home,
        mounts: `mount -t tmpfs -o noexec tmpfs "${bin}" && mount -t tmpfs -o noexec tmpfs "${home}"`,
      });
      expect(result.failed).toBe('1');
      expect(result.out).toContain('is mounted noexec on TrueNAS SCALE');
      expect(result.out).toContain('/home is mounted noexec on SCALE');
    });

    it('accepts an executable bin dir when only an unrelated mount is noexec', (ctx) => {
      if (!unshareWorks) return ctx.skip();
      const { bin, home } = freshDirs();
      const other = mkdtempSync(join(root, 'other-'));
      const result = run({
        manifest: SCALE_MANIFEST,
        binDir: bin,
        home,
        mounts: `mount -t tmpfs -o noexec tmpfs "${other}"`,
      });
      expect(result.failed).toBe('0');
    });
  });

  describe('TrueNAS CORE (FreeBSD)', () => {
    it('stops with a CORE-specific message instead of the generic FreeBSD one', () => {
      const { bin, home } = freshDirs();
      for (const etcVersion of ['TrueNAS-13.0-U6.1 (abcdef)', 'FreeNAS-11.3-U5 (abcdef)']) {
        const result = run({ os: 'FreeBSD', etcVersion, binDir: bin, home });
        expect(result.failed).toBe('1');
        expect(result.out).toContain('TrueNAS CORE is not supported');
        expect(result.out).toContain('docs/truenas-scale.md');
        expect(result.out).not.toContain('Unsupported FreeBSD appliance');
      }
    });

    it('leaves the pfSense and generic FreeBSD messages alone', () => {
      const { bin, home } = freshDirs();
      const pfsenseOther = run({ os: 'FreeBSD', productName: 'pfSense', etcVersion: '2.8.0-RELEASE', binDir: bin, home });
      expect(pfsenseOther.failed).toBe('1');
      expect(pfsenseOther.out).toContain('Unsupported FreeBSD appliance or ABI');
      const generic = run({ os: 'FreeBSD', etcVersion: '14.1-RELEASE', binDir: bin, home });
      expect(generic.failed).toBe('1');
      expect(generic.out).toContain('Unsupported FreeBSD appliance or ABI');
      expect(generic.out).not.toContain('TrueNAS');
    });

    it('does not classify a pfSense box as CORE even if its version string looked like one', () => {
      const { bin, home } = freshDirs();
      const result = run({ os: 'FreeBSD', productName: 'pfSense', etcVersion: 'TrueNAS-13.0', binDir: bin, home });
      expect(result.out).not.toContain('TrueNAS CORE');
    });
  });
});
