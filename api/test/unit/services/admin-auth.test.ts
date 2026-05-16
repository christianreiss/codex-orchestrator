/**
 * Unit coverage for AdminAuthService: cookie/session config knobs +
 * sanitizeUser (the pure transformations that don't need the DB). The DB-
 * bound paths (login, createSession, etc.) are exercised in the integration
 * suite via a stubbed Drizzle client.
 */
import { describe, it, expect } from 'vitest';
import { AdminAuthService, VALID_ACCESS_LEVELS } from '../../../src/services/admin-auth.js';
import type { Env } from '../../../src/env.js';
import type { AdminUser } from '../../../src/db/schema.js';

const envBase = {
  ADMIN_SESSION_COOKIE: 'codex_admin_session',
  ADMIN_SESSION_TTL_MINUTES: 60 * 12,
  ADMIN_WEBAUTHN_RP_NAME: 'Codex Orchestrator',
} as unknown as Env;

function makeService(env: Partial<Env> = {}): AdminAuthService {
  return new AdminAuthService(
    {} as unknown as import('../../../src/db/client.js').Database,
    { ...envBase, ...env } as Env,
  );
}

describe('AdminAuthService.sessionCookieName', () => {
  it('reads ADMIN_SESSION_COOKIE from env', () => {
    expect(makeService({ ADMIN_SESSION_COOKIE: 'my_cookie' as Env['ADMIN_SESSION_COOKIE'] }).sessionCookieName()).toBe('my_cookie');
  });

  it('falls back to codex_admin_session', () => {
    const svc = makeService({ ADMIN_SESSION_COOKIE: undefined as unknown as Env['ADMIN_SESSION_COOKIE'] });
    expect(svc.sessionCookieName()).toBe('codex_admin_session');
  });
});

describe('AdminAuthService.sessionTtlSeconds', () => {
  it('clamps below 5 minutes', () => {
    const svc = makeService({ ADMIN_SESSION_TTL_MINUTES: 0 });
    expect(svc.sessionTtlSeconds()).toBe(300);
  });

  it('clamps above 7 days', () => {
    const svc = makeService({ ADMIN_SESSION_TTL_MINUTES: 60 * 24 * 100 });
    expect(svc.sessionTtlSeconds()).toBe(7 * 24 * 60 * 60);
  });

  it('converts minutes to seconds inside bounds', () => {
    const svc = makeService({ ADMIN_SESSION_TTL_MINUTES: 30 });
    expect(svc.sessionTtlSeconds()).toBe(30 * 60);
  });
});

describe('AdminAuthService.validRole', () => {
  it('accepts every value listed in VALID_ACCESS_LEVELS', () => {
    const svc = makeService();
    for (const role of VALID_ACCESS_LEVELS) {
      expect(svc.validRole(role)).toBe(true);
    }
  });

  it('rejects unknown roles', () => {
    const svc = makeService();
    expect(svc.validRole('superuser')).toBe(false);
    expect(svc.validRole('')).toBe(false);
  });
});

describe('AdminAuthService.sanitizeUser', () => {
  it('flattens the AdminUser row into the API-shaped record', () => {
    const svc = makeService();
    const row: AdminUser = {
      id: 7,
      name: 'Owner',
      username: 'owner',
      email: 'owner@example.test',
      passwordHash: '$argon2id$secret',
      accessLevel: 'owner',
      active: 1,
      lastLoginAt: '2026-05-17T00:00:00Z',
      createdAt: '2026-05-16T00:00:00Z',
      updatedAt: '2026-05-17T00:00:00Z',
    };
    expect(svc.sanitizeUser(row)).toEqual({
      id: 7,
      name: 'Owner',
      username: 'owner',
      email: 'owner@example.test',
      access_level: 'owner',
      active: true,
      last_login_at: '2026-05-17T00:00:00Z',
      created_at: '2026-05-16T00:00:00Z',
      updated_at: '2026-05-17T00:00:00Z',
    });
  });

  it('flips active=0 to false and missing last_login_at to null', () => {
    const svc = makeService();
    const row = {
      id: 1,
      name: 'Viewer',
      username: 'viewer',
      email: 'viewer@example.test',
      passwordHash: 'h',
      accessLevel: 'viewer',
      active: 0,
      lastLoginAt: null,
      createdAt: '2026-05-16T00:00:00Z',
      updatedAt: '2026-05-16T00:00:00Z',
    } satisfies AdminUser;
    expect(svc.sanitizeUser(row).active).toBe(false);
    expect(svc.sanitizeUser(row).last_login_at).toBeNull();
  });
});

describe('AdminAuthService.validatePasswordOrThrow', () => {
  it('rejects passwords shorter than 12 chars', () => {
    const svc = makeService();
    expect(() => svc.validatePasswordOrThrow('short')).toThrow(/at least 12/);
  });

  it('accepts a long password', () => {
    const svc = makeService();
    expect(() => svc.validatePasswordOrThrow('correct horse battery staple')).not.toThrow();
  });
});
