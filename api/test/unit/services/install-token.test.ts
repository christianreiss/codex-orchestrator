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
    expect(out).toContain('/wrapper/v2/config?engine=$ENGINE');
    expect(out).toContain('-H "X-API-Key: $HOST_API_KEY"');
    expect(out).toContain('CONFIG_FILE=\'cdx.json\'');
    expect(out).toContain('INSTALL_CONTEXT=installer');
    expect(out).toContain('Install Codex CLI manually');
    // strip trailing slashes on baseUrl
    expect(out).not.toContain("baseUrl '''https://orchestrator.example.com/");
  });

  it('builds a claude installer with the npm hint', () => {
    const out = buildInstallerScript({
      fqdn: 'h.example.com',
      apiKey: 'sk-claude-foo',
      baseUrl: 'https://o.example/',
      engine: 'claude',
    });
    expect(out).toContain('claude not found');
    expect(out).toContain('@anthropic-ai/claude-code');
    expect(out).toContain('CONFIG_FILE=\'clx.json\'');
    expect(out).toContain('ENGINE=\'claude\'');
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

  it('rejects an invalid seed base URL', () => {
    expect(() =>
      buildSeedAuthScript({ baseUrl: 'https:', token: 'x', engine: 'codex' }),
    ).toThrow();
  });
});

describe('install-token: shellErrorScript', () => {
  it('emits an echo+exit shell snippet that escapes double quotes', () => {
    const s = shellErrorScript('boom "danger"');
    expect(s).toContain('echo "boom \\"danger\\"" >&2');
    expect(s).toContain('exit 1');
  });
});
