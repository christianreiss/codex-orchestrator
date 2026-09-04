import { describe, expect, it } from 'vitest';
import { createDbFake } from '../../helpers/db-fake.js';
import {
  hosts,
  insecureAuthRequests,
  insecureDomainAllows,
  logs,
  versions,
  type Host,
} from '../../../src/db/schema.js';
import { InsecureWindowAdminService } from '../../../src/services/insecure-window-admin.js';
import {
  clampFleetWindowMinutes,
  DEFAULT_FLEET_WINDOW_MINUTES,
  INSECURE_FLEET_WINDOW_KEY,
  MAX_FLEET_WINDOW_MINUTES,
  MIN_FLEET_WINDOW_MINUTES,
} from '../../../src/services/insecure-fleet-window.js';
import type {
  AdminEventRecord,
  AdminEventsWriter,
} from '../../../src/services/admin-events-writer.js';
import { nowIso } from '../../../src/util/timestamp.js';
import type { Env } from '../../../src/env.js';

type Row = Record<string, unknown>;

interface RecordedEvent {
  type: string;
  payload: Record<string, unknown>;
}

function recordingEvents(recorded: RecordedEvent[]): AdminEventsWriter {
  const push = (type: string, payload: Record<string, unknown>): AdminEventRecord => {
    recorded.push({ type, payload });
    return { id: recorded.length, type, hostId: null, payload, createdAt: nowIso() };
  };
  return {
    append: async (type, payload) => push(type, payload),
    appendAndPublish: async (type, payload) => push(type, payload),
  };
}

function env(): Env {
  return { INSECURE_GRACE_MINUTES: 60 } as Env;
}

function host(overrides: Partial<Host> = {}): Row {
  return {
    id: 1,
    fqdn: 'a.example.com',
    secure: 0,
    insecureEnabledUntil: null,
    insecureGraceUntil: null,
    insecureWindowMinutes: 10,
    ...overrides,
  } as unknown as Row;
}

function build(tables: Map<unknown, Row[]>) {
  tables.set(logs, tables.get(logs) ?? []);
  tables.set(versions, tables.get(versions) ?? []);
  tables.set(insecureAuthRequests, tables.get(insecureAuthRequests) ?? []);
  tables.set(insecureDomainAllows, tables.get(insecureDomainAllows) ?? []);
  const db = createDbFake(tables);
  const recorded: RecordedEvent[] = [];
  const svc = new InsecureWindowAdminService({
    db: db as never,
    env: env(),
    events: recordingEvents(recorded),
  });
  return { db, svc, recorded };
}

function storedDeadline(db: ReturnType<typeof createDbFake>): string | null {
  const row = db.tables
    .get(versions)
    ?.find((r) => r.name === INSECURE_FLEET_WINDOW_KEY);
  return (row?.version as string | undefined) ?? null;
}

describe('clampFleetWindowMinutes', () => {
  it('defaults to a working day and holds the documented bounds', () => {
    expect(clampFleetWindowMinutes(undefined)).toBe(DEFAULT_FLEET_WINDOW_MINUTES);
    expect(clampFleetWindowMinutes(Number.NaN)).toBe(DEFAULT_FLEET_WINDOW_MINUTES);
    expect(clampFleetWindowMinutes(1)).toBe(MIN_FLEET_WINDOW_MINUTES);
    expect(clampFleetWindowMinutes(99_999)).toBe(MAX_FLEET_WINDOW_MINUTES);
    // The point of storing an absolute deadline: the per-host 480-minute cap
    // must not reach a window meant to span a working day and then some.
    expect(clampFleetWindowMinutes(720)).toBe(720);
  });
});

describe('openFleetWindow', () => {
  it('stamps every insecure host and leaves secure hosts alone', async () => {
    const tables = new Map<unknown, Row[]>();
    tables.set(hosts, [
      host({ id: 1, fqdn: 'a.example.com' }),
      host({ id: 2, fqdn: 'b.example.com' }),
      host({ id: 3, fqdn: 'secure.example.com', secure: 1 } as Partial<Host>),
    ]);
    const { db, svc } = build(tables);

    const result = await svc.openFleetWindow(480);

    expect(result.hostsOpened).toBe(2);
    const rows = db.tables.get(hosts) ?? [];
    expect(rows[0]?.insecureEnabledUntil).toBeInstanceOf(Date);
    expect(rows[1]?.insecureEnabledUntil).toBeInstanceOf(Date);
    expect(rows[2]?.insecureEnabledUntil).toBeNull();
    expect(storedDeadline(db)).toBe(result.until.toISOString().replace(/\.\d{3}Z$/, 'Z'));
  });

  it('leaves the per-host stored duration untouched', async () => {
    // It is clamped to 480 and belongs to the host; a fleet window has no
    // business rewriting it permanently.
    const tables = new Map<unknown, Row[]>();
    tables.set(hosts, [host({ insecureWindowMinutes: 10 })]);
    const { db, svc } = build(tables);

    await svc.openFleetWindow(720);

    expect(db.tables.get(hosts)?.[0]?.insecureWindowMinutes).toBe(10);
  });

  it('resolves the pending approval queue instead of letting it auto-deny', async () => {
    const requestedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    const tables = new Map<unknown, Row[]>();
    tables.set(hosts, [host()]);
    tables.set(insecureAuthRequests, [
      { id: 1, hostId: 1, status: 'pending', requestedAt, resolvedAt: null, updatedAt: requestedAt },
    ]);
    const { db, svc } = build(tables);

    const result = await svc.openFleetWindow(60);

    expect(result.approvalsResolved).toBe(1);
    // Six minutes old: `approve()` would have expired it into a denial.
    expect(db.tables.get(insecureAuthRequests)?.[0]?.status).toBe('approved');
  });

  it('replaces the deadline rather than extending it', async () => {
    const tables = new Map<unknown, Row[]>();
    tables.set(hosts, [host()]);
    const { svc } = build(tables);

    const first = await svc.openFleetWindow(480);
    const second = await svc.openFleetWindow(60);

    expect(second.until.getTime()).toBeLessThan(first.until.getTime());
  });
});

describe('closeFleetWindow', () => {
  it('clears every window and grace, expires domain allows, and drops the key', async () => {
    const soon = new Date(Date.now() + 60 * 60_000);
    const tables = new Map<unknown, Row[]>();
    tables.set(hosts, [
      host({ id: 1, insecureEnabledUntil: soon, insecureGraceUntil: soon }),
      host({ id: 2, fqdn: 'b.example.com', insecureEnabledUntil: soon }),
    ]);
    tables.set(insecureDomainAllows, [
      {
        id: 1,
        domain: 'lab.example.com',
        windowMinutes: 10,
        enabledUntil: null,
        revokedAt: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
    ]);
    const { db, svc } = build(tables);
    await svc.openFleetWindow(480);

    const result = await svc.closeFleetWindow('manual');

    expect(result.closed).toBe(true);
    expect(result.hosts).toBe(2);
    expect(result.domains).toBe(1);
    for (const row of db.tables.get(hosts) ?? []) {
      expect(row.insecureEnabledUntil).toBeNull();
      expect(row.insecureGraceUntil).toBeNull();
    }
    // An expired allow, not a revoked one: the operator can re-arm it.
    const allow = db.tables.get(insecureDomainAllows)?.[0];
    expect(allow?.revokedAt).toBeNull();
    expect(new Date(allow?.enabledUntil as string).getTime()).toBeLessThanOrEqual(Date.now());
    expect(storedDeadline(db)).toBeNull();
  });

  it('is idempotent', async () => {
    const tables = new Map<unknown, Row[]>();
    tables.set(hosts, [host()]);
    const { db, svc } = build(tables);
    await svc.openFleetWindow(60);

    await svc.closeFleetWindow('manual');
    const second = await svc.closeFleetWindow('manual');

    expect(second.closed).toBe(false);
    expect(second.hosts).toBe(0);
    expect(storedDeadline(db)).toBeNull();
  });

  it('records why it closed', async () => {
    const tables = new Map<unknown, Row[]>();
    tables.set(hosts, [host()]);
    const { db, svc } = build(tables);
    await svc.openFleetWindow(60);

    await svc.closeFleetWindow('expired');

    const closeLog = (db.tables.get(logs) ?? []).find(
      (row) => row.action === 'admin.insecure.fleet_window_close',
    );
    expect(closeLog).toBeTruthy();
    expect(JSON.parse(closeLog?.details as string)).toMatchObject({ reason: 'expired' });
  });
});

describe('sweepIfLapsed', () => {
  it('closes a window whose deadline has passed', async () => {
    const past = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const tables = new Map<unknown, Row[]>();
    tables.set(hosts, [host({ insecureEnabledUntil: new Date(Date.now() + 60_000) })]);
    tables.set(versions, [
      { name: INSECURE_FLEET_WINDOW_KEY, version: past, updatedAt: past },
    ]);
    const { db, svc } = build(tables);

    expect(await svc.sweepIfLapsed()).toBe(true);
    expect(db.tables.get(hosts)?.[0]?.insecureEnabledUntil).toBeNull();
    expect(storedDeadline(db)).toBeNull();
    // Nothing owed the second time round.
    expect(await svc.sweepIfLapsed()).toBe(false);
  });

  it('leaves an open window alone', async () => {
    const tables = new Map<unknown, Row[]>();
    tables.set(hosts, [host()]);
    const { db, svc } = build(tables);
    await svc.openFleetWindow(60);

    expect(await svc.sweepIfLapsed()).toBe(false);
    expect(db.tables.get(hosts)?.[0]?.insecureEnabledUntil).toBeInstanceOf(Date);
  });
});

describe('per-host disable while the fleet window is open', () => {
  it('refuses rather than reporting a close that enforce() would undo', async () => {
    const tables = new Map<unknown, Row[]>();
    tables.set(hosts, [host()]);
    const { svc } = build(tables);
    await svc.openFleetWindow(60);

    await expect(svc.disable(1)).rejects.toMatchObject({
      code: 'insecure_fleet_window_open',
      status: 409,
    });
  });
});
