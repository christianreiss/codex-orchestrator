/**
 * Unit coverage for AdminPasskeyService — focused on its env-validation
 * surface (the WebAuthn-bound flows are exercised via the integration suite).
 */
import { describe, it, expect } from 'vitest';
import { AdminPasskeyService } from '../../../src/services/admin-passkey.js';
import { AdminEventsService } from '../../../src/services/admin-events.js';
import type { Database } from '../../../src/db/client.js';
import type { Env } from '../../../src/env.js';

function makeService(envPatch: Partial<Env> = {}): AdminPasskeyService {
  const env = {
    ADMIN_WEBAUTHN_RP_NAME: 'Codex Orchestrator',
    ...envPatch,
  } as unknown as Env;
  return new AdminPasskeyService({} as Database, env, new AdminEventsService({} as Database));
}

describe('AdminPasskeyService env accessors', () => {
  it('throws when rpId is unset and no request host is available', () => {
    expect(() => makeService().rpId()).toThrow(/ADMIN_WEBAUTHN_RP_ID/);
  });

  it('throws when origin is unset and no request host is available', () => {
    expect(() => makeService().origin()).toThrow(/ADMIN_WEBAUTHN_ORIGIN/);
  });

  it('returns the RP name with a sensible default', () => {
    expect(makeService().rpName()).toBe('Codex Orchestrator');
    expect(
      makeService({ ADMIN_WEBAUTHN_RP_NAME: 'Custom' as Env['ADMIN_WEBAUTHN_RP_NAME'] }).rpName(),
    ).toBe('Custom');
  });

  it('returns configured rpId / origin when present', () => {
    const svc = makeService({
      ADMIN_WEBAUTHN_RP_ID: 'example.test' as Env['ADMIN_WEBAUTHN_RP_ID'],
      ADMIN_WEBAUTHN_ORIGIN: 'https://example.test' as Env['ADMIN_WEBAUTHN_ORIGIN'],
    });
    expect(svc.rpId()).toBe('example.test');
    expect(svc.origin()).toBe('https://example.test');
  });

  it('derives rpId / origin from PUBLIC_BASE_URL when env overrides are absent', () => {
    const svc = makeService({
      PUBLIC_BASE_URL: 'https://admin.example.test/base' as Env['PUBLIC_BASE_URL'],
    });
    expect(svc.rpId()).toBe('admin.example.test');
    expect(svc.origin()).toBe('https://admin.example.test');
  });

  it('derives rpId / origin from trusted forwarded request headers', () => {
    const svc = makeService({
      TRUST_X_FORWARDED: true as Env['TRUST_X_FORWARDED'],
    });
    const req = {
      headers: {
        host: 'internal:8080',
        'x-forwarded-host': 'codex-auth.uggs.io',
        'x-forwarded-proto': 'https',
      },
      protocol: 'http',
    };
    expect(svc.rpId(req)).toBe('codex-auth.uggs.io');
    expect(svc.origin(req)).toBe('https://codex-auth.uggs.io');
  });

  it('falls back to the direct request host when forwarded headers are not trusted', () => {
    const svc = makeService({
      TRUST_X_FORWARDED: false as Env['TRUST_X_FORWARDED'],
    });
    const req = {
      headers: {
        host: 'local.example.test:8080',
        'x-forwarded-host': 'codex-auth.uggs.io',
        'x-forwarded-proto': 'https',
      },
      protocol: 'http',
    };
    expect(svc.rpId(req)).toBe('local.example.test');
    expect(svc.origin(req)).toBe('http://local.example.test');
  });
});

describe('AdminPasskeyService.rename validation', () => {
  it('rejects an empty name', async () => {
    const svc = makeService({
      ADMIN_WEBAUTHN_RP_ID: 'example.test' as Env['ADMIN_WEBAUTHN_RP_ID'],
      ADMIN_WEBAUTHN_ORIGIN: 'https://example.test' as Env['ADMIN_WEBAUTHN_ORIGIN'],
    });
    await expect(svc.rename(1, 1, '   ')).rejects.toThrow(/Name is required/);
  });
});
