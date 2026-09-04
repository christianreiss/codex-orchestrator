import { describe, expect, it } from 'vitest';
import { createDbFake } from '../../helpers/db-fake.js';
import {
  hosts,
  insecureAuthRequests,
  insecureDomainAllows,
  versions,
  type Host,
} from '../../../src/db/schema.js';
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

/** A `versions` row holding the fleet-window deadline, `offsetMs` from now. */
function fleetWindowRow(offsetMs: number): Record<string, unknown> {
  const at = new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { name: 'insecure_fleet_window_until', version: at, updatedAt: at };
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
  describe('the fleet window', () => {
    it('admits a host whose own window is shut, without queueing an approval', async () => {
      const host = insecureHost();
      const tables = new Map<unknown, Record<string, unknown>[]>();
      tables.set(hosts, [host as unknown as Record<string, unknown>]);
      tables.set(insecureAuthRequests, []);
      tables.set(versions, [fleetWindowRow(8 * 60 * 60_000)]);
      const db = createDbFake(tables);
      const svc = createInsecureWindowService({ db: db as never, env: env() });

      const result = await svc.enforce(host, 'retrieve');

      expect(result.insecureEnabledUntil).toBeInstanceOf(Date);
      // The pending-approval branch is the one this must not reach.
      expect(db.inserts).toHaveLength(0);
      expect(db.tables.get(insecureAuthRequests)).toHaveLength(0);
    });

    it('does not let the ordinary slide shorten the fleet deadline', async () => {
      // The regression this whole feature turns on: the slide writes
      // `now + insecureWindowMinutes` with no ceiling, so a ten-minute stored
      // window would replace an eight-hour fleet grant on the next request.
      const fleetUntilMs = Date.now() + 8 * 60 * 60_000;
      const host = insecureHost({
        insecureEnabledUntil: new Date(Date.now() + 60_000),
        insecureWindowMinutes: 10,
      });
      const tables = new Map<unknown, Record<string, unknown>[]>();
      tables.set(hosts, [host as unknown as Record<string, unknown>]);
      tables.set(insecureAuthRequests, []);
      tables.set(versions, [fleetWindowRow(8 * 60 * 60_000)]);
      const db = createDbFake(tables);
      const svc = createInsecureWindowService({ db: db as never, env: env() });

      const result = await svc.enforce(host, 'retrieve');

      const until = result.insecureEnabledUntil as Date;
      expect(until.getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);
      expect(Math.abs(until.getTime() - fleetUntilMs)).toBeLessThan(5_000);
    });

    it('holds the deadline for a host whose stored window is zero minutes', async () => {
      // `clampWindow`'s floor is 0, so without the fleet branch such a host
      // would be handed `newUntil = now` and drop straight back out.
      const host = insecureHost({
        insecureEnabledUntil: new Date(Date.now() + 60_000),
        insecureWindowMinutes: 0,
      });
      const tables = new Map<unknown, Record<string, unknown>[]>();
      tables.set(hosts, [host as unknown as Record<string, unknown>]);
      tables.set(insecureAuthRequests, []);
      tables.set(versions, [fleetWindowRow(4 * 60 * 60_000)]);
      const db = createDbFake(tables);
      const svc = createInsecureWindowService({ db: db as never, env: env() });

      const result = await svc.enforce(host, 'retrieve');

      expect((result.insecureEnabledUntil as Date).getTime()).toBeGreaterThan(
        Date.now() + 3 * 60 * 60_000,
      );
    });

    it('keeps the deadline off the domain-allow path, which truncates through the other door', async () => {
      const fleetUntilMs = Date.now() + 8 * 60 * 60_000;
      const host = insecureHost({ fqdn: 'box.lab.example.com', insecureWindowMinutes: 10 });
      const tables = new Map<unknown, Record<string, unknown>[]>();
      tables.set(hosts, [host as unknown as Record<string, unknown>]);
      tables.set(insecureAuthRequests, []);
      tables.set(insecureDomainAllows, [
        {
          id: 1,
          domain: 'lab.example.com',
          windowMinutes: 10,
          enabledUntil: null,
          revokedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);
      tables.set(versions, [fleetWindowRow(8 * 60 * 60_000)]);
      const db = createDbFake(tables);
      const svc = createInsecureWindowService({ db: db as never, env: env() });

      const result = await svc.enforce(host, 'retrieve');

      const until = result.insecureEnabledUntil as Date;
      expect(Math.abs(until.getTime() - fleetUntilMs)).toBeLessThan(5_000);
      // The domain branch also slides its own row forward; it must not have run.
      expect(db.updates.some((u) => u.table === insecureDomainAllows)).toBe(false);
    });

    it('grants nothing once the deadline has passed', async () => {
      const host = insecureHost();
      const tables = new Map<unknown, Record<string, unknown>[]>();
      tables.set(hosts, [host as unknown as Record<string, unknown>]);
      tables.set(insecureAuthRequests, []);
      tables.set(versions, [fleetWindowRow(-60_000)]);
      const db = createDbFake(tables);
      const svc = createInsecureWindowService({ db: db as never, env: env() });

      await expect(svc.enforce(host, 'retrieve')).rejects.toMatchObject({
        code: 'insecure_pending',
      });
    });
  });
});
