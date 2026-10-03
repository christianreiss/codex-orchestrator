import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildInstallerScript,
  buildSeedAuthScript,
  shellErrorScript,
  tokenExpired,
} from '../../../src/services/install-token.js';

describe('install-token: tokenExpired', () => {
  it('treats unset as expired', () => {
    expect(tokenExpired(null)).toBe(true);
    expect(tokenExpired(undefined)).toBe(true);
  });
  it('treats parsable past timestamps as expired', () => {
    expect(tokenExpired('1999-01-01T00:00:00Z')).toBe(true);
  });
  it('treats future timestamps as fresh', () => {
    const fut = new Date(Date.now() + 60_000).toISOString();
    expect(tokenExpired(fut)).toBe(false);
  });
  it('treats unparseable input as expired', () => {
    expect(tokenExpired('not a date')).toBe(true);
  });
});

describe('install-token: shell builders', () => {
  it('builds a codex installer that writes config before installing the wrapper binary', () => {
    const out = buildInstallerScript({
      fqdn: 'host.example.com',
      apiKey: 'sk-codex-deadbeef',
      baseUrl: 'https://orchestrator.example.com',
      engine: 'codex',
    });
    expect(out).toContain('#!/bin/sh');
    expect(out).toContain('host.example.com');
    expect(out).toContain('sk-codex-deadbeef');
    expect(out).toContain('/wrapper/v2/config?engine=codex');
    expect(out).toContain('-H "X-API-Key: $HOST_API_KEY"');
    expect(out).toContain('CODEX_INSTALL_CURL_INSECURE=${CODEX_INSTALL_CURL_INSECURE:-0}');
    expect(out).toContain('curl $CURL_INSECURE_FLAG -fsSL');
    expect(out).toContain('CODEX_CONFIG_PATH=${CDX_CONFIG_PATH:-$CONFIG_HOME/codex-orchestrator/cdx.json}');
    expect(out).toContain('INSTALL_CONTEXT=installer');
    expect(out).toContain("INSTALL_LABEL='Codex'");
    expect(out).toContain('ui_result_ok "READY"');
    // One common host schedule and tick bootstrap every enabled persona.
    expect(out).toContain('"$TARGET_BIN" cron install --minimal');
    expect(out).toContain('"$TARGET_BIN" cron run --minimal');
    // strip trailing slashes on baseUrl
    expect(out).not.toContain("baseUrl '''https://orchestrator.example.com/");
  });

  it('defaults installer-internal curls to -k for curl-insecure hosts', () => {
    const out = buildInstallerScript({
      fqdn: 'host.example.com',
      apiKey: 'sk-codex-deadbeef',
      baseUrl: 'https://orchestrator.example.com',
      engine: 'codex',
      allowInsecure: true,
    });
    expect(out).toContain('CODEX_INSTALL_CURL_INSECURE=${CODEX_INSTALL_CURL_INSECURE:-1}');
    expect(out).toContain('CURL_INSECURE_FLAG=-k');
    expect(out).toContain('curl $CURL_INSECURE_FLAG -fsSL');
  });

  it('builds a Claude installer with managed Node/npm preflight', () => {
    const out = buildInstallerScript({
      fqdn: 'h.example.com',
      apiKey: 'sk-claude-foo',
      baseUrl: 'https://o.example/',
      engine: 'claude',
    });
    expect(out).toContain('NEEDS_CLAUDE=1');
    expect(out).toContain('ensure_claude_prerequisites');
    expect(out).toContain('npm@10.9.2');
    expect(out).toContain('CLAUDE_CONFIG_PATH=${CLX_CONFIG_PATH:-$CONFIG_HOME/codex-orchestrator/clx.json}');
    expect(out).toContain("ENGINE='claude'");
  });

  it('builds a complete dual-engine installer from the host engine list', () => {
    const out = buildInstallerScript({
      fqdn: 'both.example.com',
      apiKey: 'sk-both-foo',
      baseUrl: 'https://o.example/',
      engine: 'codex',
      enginesList: ['codex', 'claude'],
    });
    expect(out).toContain("INSTALL_LABEL='Codex + Claude'");
    expect(out).toContain('HAS_CODEX=1');
    expect(out).toContain('HAS_CLAUDE=1');
    expect(out).toContain('/wrapper/v2/config?engine=codex');
    expect(out).toContain('/wrapper/v2/config?engine=claude');
    expect(out).toContain('identities = {(entry["version"], entry["sha256"]) for entry in entries}');
    expect(out).toContain('ui_hint_cmd cdx run "Start Codex"');
    expect(out).toContain('ui_hint_cmd clx run "Start Claude Code"');
    expect(out).not.toContain('Done. Try:');
  });

  it('rejects missing fqdn or api key', () => {
    expect(() =>
      buildInstallerScript({ fqdn: '', apiKey: 'sk', baseUrl: 'https://x', engine: 'codex' }),
    ).toThrow();
    expect(() =>
      buildInstallerScript({ fqdn: 'a', apiKey: '', baseUrl: 'https://x', engine: 'codex' }),
    ).toThrow();
  });

  it('builds the seed script with the right POST URL', () => {
    const out = buildSeedAuthScript({
      baseUrl: 'https://o.example.com/',
      token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      engine: 'codex',
    });
    expect(out).toContain('/seed/v2/auth/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(out).toContain('$HOME/.codex/auth.json');
  });

  it('builds a claude seed script targeting credentials.json', () => {
    const out = buildSeedAuthScript({
      baseUrl: 'https://o.example.com',
      token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      engine: 'claude',
    });
    expect(out).toContain('$HOME/.claude/.credentials.json');
  });

  it('builds a Grok seed script that logs in to an isolated home instead of copying ~/.grok', () => {
    const out = buildSeedAuthScript({ baseUrl: 'https://o.example.com', token: 'test-token', engine: 'grok' });
    expect(out).toContain('seed-auth uploader (grok)');
    expect(out).toContain('/seed/v2/auth/test-token');
    // A copied live login would leave two refreshers on one rotating token chain.
    expect(out).not.toContain('$HOME/.grok/auth.json');
    expect(out).toContain('SEED_HOME=$(mktemp -d)');
    expect(out).toContain('GROK_HOME="$SEED_HOME" GROK_AUTH_PATH="$SEED_HOME/auth.json"');
    expect(out).toContain('login --device-auth');
    expect(out).toContain('trap cleanup EXIT INT TERM');
    expect(out).toContain('GROK_SEED_AUTH_PATH');
  });

  it('runs the Grok seed login in a throwaway home, uploads it, and erases it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grok-seed-'));
    try {
      const bin = join(dir, 'bin');
      const home = join(dir, 'home');
      mkdirSync(bin);
      mkdirSync(home);
      const log = join(dir, 'log');
      // Stub native login: writes the scope map where GROK_AUTH_PATH points.
      writeFileSync(join(bin, 'grok'), `#!/bin/sh
echo "grok $* home=$GROK_HOME auth=$GROK_AUTH_PATH apikey=\${GROK_API_KEY:-unset}" >> ${log}
printf '{"scope":{"auth_mode":"oidc"}}' > "$GROK_AUTH_PATH"
`);
      // Stub curl: records the uploaded file and its body, then answers.
      writeFileSync(join(bin, 'curl'), `#!/bin/sh
out=
for a in "$@"; do case "$prev" in -o) out=$a;; --data-binary) echo "upload $a $(cat "\${a#@}")" >> ${log};; esac; prev=$a; done
echo "url $a" >> ${log}
printf '{"status":"ok"}' > "$out"
`);
      chmodSync(join(bin, 'grok'), 0o755);
      chmodSync(join(bin, 'curl'), 0o755);
      const script = join(dir, 'seed.sh');
      writeFileSync(script, buildSeedAuthScript({ baseUrl: 'https://o.example.com', token: 'tok', engine: 'grok' }));
      const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: dir, GROK_API_KEY: 'must-not-leak' };
      const out = execFileSync('sh', [script], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
      expect(out).toContain('Done. Server response:');
      const lines = readFileSync(log, 'utf8');
      const seedHome = /home=(\S+) /.exec(lines)?.[1] ?? '';
      expect(lines).toContain('grok login --device-auth');
      expect(lines).toContain('apikey=unset');
      expect(lines).toContain(`auth=${seedHome}/auth.json`);
      expect(lines).toContain(`upload @${seedHome}/auth.json {"scope":{"auth_mode":"oidc"}}`);
      expect(lines).toContain('url https://o.example.com/seed/v2/auth/tok');
      expect(seedHome.startsWith(dir)).toBe(true);
      expect(existsSync(seedHome)).toBe(false); // erased after upload

      // Explicit opt-in uploads an existing file and never runs a login.
      rmSync(log);
      const existing = join(dir, 'existing.json');
      writeFileSync(existing, '{"existing":true}');
      const optIn = execFileSync('sh', [script], { encoding: 'utf8', env: { ...env, GROK_SEED_AUTH_PATH: existing }, stdio: ['ignore', 'pipe', 'pipe'] });
      expect(optIn).toContain('Done.');
      const second = readFileSync(log, 'utf8');
      expect(second).not.toContain('grok login');
      expect(second).toContain(`upload @${existing} {"existing":true}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid seed base URL', () => {
    expect(() => buildSeedAuthScript({ baseUrl: 'https:', token: 'x', engine: 'codex' })).toThrow();
  });
});

describe('install-token: shellErrorScript', () => {
  it('emits an echo+exit shell snippet that escapes double quotes', () => {
    const s = shellErrorScript('boom "danger"');
    expect(s).toContain('echo "boom \\"danger\\"" >&2');
    expect(s).toContain('exit 1');
  });
});
