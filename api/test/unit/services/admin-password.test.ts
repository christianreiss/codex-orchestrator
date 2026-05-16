/**
 * Unit coverage for AdminPasswordService input validation. The DB-bound
 * happy paths are exercised in the integration suite.
 */
import { describe, it, expect } from 'vitest';
import { AdminPasswordService } from '../../../src/services/admin-password.js';
import { AdminAuthService } from '../../../src/services/admin-auth.js';
import { AdminEventsService } from '../../../src/services/admin-events.js';
import type { Database } from '../../../src/db/client.js';
import type { Env } from '../../../src/env.js';

function makeService(): AdminPasswordService {
  const env = { ADMIN_SESSION_TTL_MINUTES: 60 } as unknown as Env;
  const auth = new AdminAuthService({} as Database, env);
  const events = new AdminEventsService({} as Database);
  return new AdminPasswordService({} as Database, env, auth, events, {
    async send() {
      return { delivered: false };
    },
  });
}

describe('AdminPasswordService.changePassword (synchronous validation)', () => {
  it('rejects mismatched confirmation', async () => {
    const svc = makeService();
    await expect(svc.changePassword(1, 'current', 'newpassword-long', 'different-pw', null)).rejects.toThrow(
      /confirmation does not match/,
    );
  });
});

describe('AdminPasswordService.applyReset (synchronous validation)', () => {
  it('rejects an empty token', async () => {
    const svc = makeService();
    await expect(svc.applyReset('', 'newpassword-long', 'newpassword-long')).rejects.toThrow(
      /token is required/i,
    );
  });

  it('rejects mismatched confirmation before any DB query', async () => {
    const svc = makeService();
    await expect(svc.applyReset('token-abc', 'newpassword-long', 'different-pw')).rejects.toThrow(
      /confirmation does not match/,
    );
  });

  it('rejects too-short passwords before any DB query', async () => {
    const svc = makeService();
    await expect(svc.applyReset('token-abc', 'short', 'short')).rejects.toThrow(/at least 12/);
  });
});
