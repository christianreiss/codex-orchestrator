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
  it('throws when rpId is unset', () => {
    expect(() => makeService().rpId()).toThrow(/ADMIN_WEBAUTHN_RP_ID/);
  });

  it('throws when origin is unset', () => {
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
