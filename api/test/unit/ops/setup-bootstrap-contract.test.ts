import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const setup = readFileSync(resolve(root, 'bin/setup.sh'), 'utf8');
const makefile = readFileSync(resolve(root, 'wrappers/Makefile'), 'utf8');

describe('fresh-install setup contract', () => {
  it('uses one generated runner secret on both sides and the supported cookie mode', () => {
    expect(setup).toContain('set_env_value "AUTH_RUNNER_SHARED_SECRET" "$shared"');
    expect(setup).toContain('set_env_value "RUNNER_SHARED_SECRET" "$shared"');
    expect(setup).toContain('set_env_value "ADMIN_ACCESS_MODE" "cookie"');
    expect(setup).toContain('set_env_value "CADDY_ADMIN_FRAGMENT" "/etc/caddy/admin-cookie.caddy"');
    expect(setup).not.toContain('set_env_value "ADMIN_ACCESS_MODE" "none"');
  });

  it('fails partial preparation and deletes plaintext only after encrypted import', () => {
    expect(setup).toContain("printf '\\nINCOMPLETE\\n'");
    expect(setup).toContain('exit 2');
    expect(setup.indexOf('node setup-signing-key.js')).toBeLessThan(setup.indexOf('rm -f -- "$WRAPPER_PRIVATE_KEY"'));
  });

  it('injects an installation public key without copying over tracked pubkey.pem', () => {
    expect(makefile).toContain('PUBLIC_KEY_FILE');
    expect(makefile).toContain('signing.buildPublicKeyB64');
    expect(setup).not.toContain('make pubkey');
  });

  it('requires local and public readiness before printing READY', () => {
    expect(setup).toContain('http://127.0.0.1:8488/readyz');
    expect(setup).toContain('${codex_url%/}/readyz');
    expect(setup.indexOf('verify_stack "$codex_url"')).toBeLessThan(setup.lastIndexOf("printf 'Next steps"));
  });
});
