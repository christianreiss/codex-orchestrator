import { describe, expect, it } from 'vitest';
import { createDbFake } from '../../helpers/db-fake.js';
import { hosts, insecureAuthRequests, type Host } from '../../../src/db/schema.js';
import { createInsecureWindowService } from '../../../src/services/insecure-window.js';
import type { Env } from '../../../src/env.js';

function env(): Env {
  return { INSECURE_GRACE_MINUTES: 60 } as Env;
}

function insecureHost(overrides: Partial<Host> = {}): Host {
  return {
    id: 42,
    fqdn: 'stale.example.com',
    secure: 0,
    insecureEnabledUntil: null,
    insecureGraceUntil: null,
    insecureWindowMinutes: 10,
    ...overrides,
  } as Host;
}

describe('createInsecureWindowService', () => {
  it('admits store candidates on a fully closed insecure host without opening the retrieve window', async () => {
    const host = insecureHost({
      insecureEnabledUntil: new Date(Date.now() - 120_000),
      insecureGraceUntil: new Date(Date.now() - 60_000),
    });
    const tables = new Map<unknown, Record<string, unknown>[]>();
    tables.set(hosts, [host as unknown as Record<string, unknown>]);
    tables.set(insecureAuthRequests, []);
    const db = createDbFake(tables);
    const svc = createInsecureWindowService({ db: db as never, env: env() });

    await expect(svc.enforce(host, 'store')).resolves.toBe(host);
    expect(db.updates).toHaveLength(0);
  });

  it('auto-denies stale pending approvals after five minutes', async () => {
    const requestedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    const tables = new Map<unknown, Record<string, unknown>[]>();
    tables.set(hosts, [insecureHost() as unknown as Record<string, unknown>]);
    tables.set(insecureAuthRequests, [
      {
        id: 1,
        hostId: 42,
        status: 'pending',
        requestedAt,
        resolvedAt: null,
        updatedAt: requestedAt,
      },
    ]);
    const db = createDbFake(tables);
    const svc = createInsecureWindowService({ db: db as never, env: env() });

    await expect(svc.enforce(insecureHost(), 'retrieve')).rejects.toMatchObject({
      code: 'insecure_denied',
      status: 403,
    });
    expect(db.tables.get(insecureAuthRequests)?.[0]).toMatchObject({
      status: 'denied',
    });
    expect(db.updates[0]?.set).toMatchObject({
      status: 'denied',
    });
  });
});
