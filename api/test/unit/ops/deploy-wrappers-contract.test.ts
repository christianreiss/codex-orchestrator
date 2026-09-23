import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * scripts/deploy.sh publishes the cxx wrapper matrix so a VERSION bump reaches
 * the fleet without a manual release. Shell again, so the contract is asserted
 * by reading it. Every property here fails silently in production: a wrong key
 * takes every self-updating host offline, a skipped api restart leaves hosts on
 * the old target, and a rebuilt version conflicts with its immutable release.
 */

const root = resolve(import.meta.dirname, '../../../..');
const deploy = readFileSync(resolve(root, 'scripts/deploy.sh'), 'utf8');

const indexOf = (needle: string) => {
  const at = deploy.indexOf(needle);
  expect(at, needle).toBeGreaterThanOrEqual(0);
  return at;
};

describe('deploy.sh wrapper publishing contract', () => {
  it('documents the opt-out and honours --service', () => {
    expect(deploy).toContain('--skip-wrappers      Do not build/publish the cxx wrapper matrix.');
    expect(deploy).toContain('skipping wrappers (api not in --service list)');
  });

  it('publishes before the stack is built and recreates the api afterwards', () => {
    expect(indexOf('publish_wrappers "${wrapper_version}" "${wrapper_root}"')).toBeLessThan(indexOf('build_args=(build)'));
    expect(indexOf('recreate_args=(up -d --force-recreate)')).toBeGreaterThan(indexOf('"${compose[@]}" "${up_args[@]}"'));
  });

  it('never rebuilds a version that is already published', () => {
    expect(deploy).toContain('log "wrappers current (cxx ${version})"');
    expect(deploy).toContain('leaving wrappers untouched');
  });

  it('embeds exactly one active database signing key and proves it before publishing', () => {
    expect(deploy).toContain('FROM wrapper_signing_keys WHERE active = 1');
    expect(deploy).toContain('active wrapper signing keys (rotation in progress)');
    expect(deploy).toContain('PUBLIC_KEY_FILE=/keys/signing.pub');
    expect(deploy).toContain('-v "${stage}/keys:/keys:ro"');
    // The tracked development key is compiled into every binary, so only the
    // ldflags-injected base64 proves the build read PUBLIC_KEY_FILE.
    expect(indexOf('grep -aFq "${key_b64}"')).toBeLessThan(indexOf('wrappers/scripts/publish-release.py'));
  });

  it('pulls the toolchain image because it pins GOTOOLCHAIN=local', () => {
    expect(deploy).toContain('docker build --pull -q -f "${repo_root}/wrappers/Dockerfile.build"');
  });

  it('re-runs itself after a pull that changed the script', () => {
    // Otherwise the first deploy after an update runs the previous logic, and
    // a new wrapper step silently does nothing until the next deploy.
    expect(deploy).toContain('exec bash "${script_dir}/deploy.sh" "${original_args[@]}" --skip-git');
  });

  it('fails the deploy when the api did not project the new version', () => {
    expect(deploy).toContain('api did not project cxx ${wrapper_version}');
  });
});
