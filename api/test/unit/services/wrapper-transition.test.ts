import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildLegacyWrapperShimScript,
  isLegacyShellWrapperVersion,
  withLegacyShellWrapperTransition,
} from '../../../src/services/wrapper-transition.js';
import type { VersionSnapshot } from '../../../src/services/version-snapshot.js';

function snapshot(): VersionSnapshot {
  return {
    client_version: '0.130.0',
    client_version_override: null,
    client_version_enforce_exact: false,
    wrapper_version: '0.6.0',
    wrapper_sha256: 'a'.repeat(64),
    wrapper_url: 'https://o.example/wrapper/v2/bin/codex/linux-amd64/v0.6.0/cdx',
    runner_state: 'ok',
    api_disabled: false,
    auto_update_enabled: true,
    cdx_silent: false,
    clx_silent: false,
    installation_id: 'inst',
    engine: 'codex',
  };
}

describe('wrapper transition helpers', () => {
  it('detects date-style shell wrapper versions only', () => {
    expect(isLegacyShellWrapperVersion('2026.05.11-01')).toBe(true);
    expect(isLegacyShellWrapperVersion('2026.05.11-01+local')).toBe(true);
    expect(isLegacyShellWrapperVersion('0.6.0')).toBe(false);
    expect(isLegacyShellWrapperVersion(null)).toBe(false);
  });

  it('points legacy wrappers at the transition shim without a static checksum', () => {
    const out = withLegacyShellWrapperTransition(snapshot(), '2026.05.11-01', 'codex');
    expect(out.wrapper_url).toBe('/wrapper/download?engine=codex');
    expect(out.wrapper_sha256).toBeNull();
  });

  it('leaves Go wrapper summaries on the static binary URL', () => {
    const base = snapshot();
    const out = withLegacyShellWrapperTransition(base, '0.6.0', 'codex');
    expect(out).toBe(base);
  });

  it('builds a transition shim that fetches signed config before exec', () => {
    const out = buildLegacyWrapperShimScript({
      fqdn: 'h.example',
      apiKey: 'sk-codex-test',
      baseUrl: 'https://o.example/',
      engine: 'codex',
    });
    expect(out).toContain('legacy transition shim');
    expect(out).toContain('BASE_URL=\'https://o.example\'');
    expect(out).toContain('/wrapper/v2/config?engine=$ENGINE');
    expect(out).toContain('CONFIG_FILE=\'cdx.json\'');
    expect(out).toContain('INSTALL_MODE=shim');
    expect(out).toContain('exec "$TARGET_BIN" "$@"');
  });

  it('emits POSIX shell syntax that sh can parse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrapper-transition-'));
    try {
      const file = join(dir, 'cdx');
      writeFileSync(
        file,
        buildLegacyWrapperShimScript({
          fqdn: 'h.example',
          apiKey: 'sk-codex-test',
          baseUrl: 'https://o.example/',
          engine: 'codex',
        }),
        'utf8',
      );
      execFileSync('sh', ['-n', file]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
