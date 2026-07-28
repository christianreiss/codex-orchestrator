import { describe, expect, it } from 'vitest';
import { createDbFake } from '../../helpers/db-fake.js';
import {
  hosts,
  insecureAuthRequests,
  insecureDomainAllows,
  type Host,
} from '../../../src/db/schema.js';
import { InsecureWindowAdminService } from '../../../src/services/insecure-window-admin.js';
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
  hostId: number | null;
}

function recordingEvents(recorded: RecordedEvent[]): AdminEventsWriter {
  const push = (
    type: string,
    payload: Record<string, unknown>,
    hostId: number | null,
  ): AdminEventRecord => {
    recorded.push({ type, payload, hostId });
    return { id: recorded.length, type, hostId, payload, createdAt: nowIso() };
  };
  return {
    append: async (type, payload, hostId = null) => push(type, payload, hostId),
    appendAndPublish: async (type, payload, options = {}) =>
      push(type, payload, options.hostId ?? null),
  };
}

function env(): Env {
  return { INSECURE_GRACE_MINUTES: 60 } as Env;
}

function insecureHost(overrides: Partial<Host> = {}): Host {
  return {
    id: 7,
    fqdn: 'node.example.com',
    secure: 0,
    insecureEnabledUntil: null,
    insecureGraceUntil: null,
    insecureWindowMinutes: 10,
    ...overrides,
  } as Host;
}

function pendingRequest(overrides: Row = {}): Row {
  const requestedAt = nowIso();
  return {
    id: 1,
    hostId: 7,
    status: 'pending',
    requestIp: '10.0.0.9',
    requestedAt,
    resolvedAt: null,
    updatedAt: requestedAt,
    ...overrides,
  };
}

function stalePendingRequest(): Row {
  const requestedAt = new Date(Date.now() - 6 * 60_000).toISOString();
  return pendingRequest({ requestedAt, updatedAt: requestedAt });
}

function setup(opts: { host?: Host; requests?: Row[]; allows?: Row[] } = {}) {
  const tables = new Map<unknown, Row[]>();
  tables.set(hosts, [(opts.host ?? insecureHost()) as unknown as Row]);
  tables.set(insecureAuthRequests, opts.requests ?? [pendingRequest()]);
  tables.set(insecureDomainAllows, opts.allows ?? []);
  const db = createDbFake(tables);
  const recorded: RecordedEvent[] = [];
  const svc = new InsecureWindowAdminService({
    db: db as never,
    env: env(),
    events: recordingEvents(recorded),
  });
  return { db, svc, recorded };
}

describe('InsecureWindowAdminService.allowDomain domain guard', () => {
  it.each([
    // Unrelated domain entirely.
    { fqdn: 'node.example.com', domain: 'other.com' },
    // Shares the trailing characters but not a label boundary.
    { fqdn: 'node.evil-example.com', domain: 'example.com' },
    // The host FQDN itself is not a *parent* of the host FQDN.
    { fqdn: 'node.example.com', domain: 'node.example.com' },
  ])('rejects $domain for host $fqdn', async ({ fqdn, domain }) => {
    const { db, svc } = setup({ host: insecureHost({ fqdn }) });

    const call = svc.allowDomain(1, domain, null);
    await expect(call).rejects.toMatchObject({
      status: 422,
      code: 'validation_failed',
      param: 'domain',
    });
    await expect(call).rejects.toThrow('Domain must be a parent of the host FQDN');
    expect(db.tables.get(insecureDomainAllows)).toHaveLength(0);
  });

  it.each(['', '   ', 'localhost', 'ex ample.com', '..', 'a..example.com'])(
    'rejects %j because it normalizes away and the host has no parent domain',
    async (domain) => {
      // A two-label host FQDN has no parent domain either, so the fallback
      // cannot rescue a candidate that normalizes to nothing.
      const { db, svc } = setup({ host: insecureHost({ fqdn: 'example.com' }) });

      const call = svc.allowDomain(1, domain, null);
      await expect(call).rejects.toMatchObject({
        status: 422,
        code: 'validation_failed',
        param: 'domain',
      });
      await expect(call).rejects.toThrow('Domain must be a subdomain like cluster.example.com');
      expect(db.tables.get(insecureDomainAllows)).toHaveLength(0);
    },
  );
});

describe('InsecureWindowAdminService.allowDomain', () => {
  it('normalizes a wildcard domain and inserts the allow row', async () => {
    const { db, svc, recorded } = setup();

    const out = await svc.allowDomain(1, '*.example.com', 30);

    expect(out.domain).toMatchObject({ id: 1, domain: 'example.com', window_minutes: 30 });
    const inserted = db.inserts.find((i) => i.table === insecureDomainAllows);
    expect(inserted?.values).toMatchObject({ domain: 'example.com', windowMinutes: 30 });
    expect(db.tables.get(insecureDomainAllows)?.[0]).toMatchObject({ domain: 'example.com' });

    // Host window is bumped alongside the domain allow.
    expect(out.windowMinutes).toBe(30);
    expect(new Date(out.enabledUntil).getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(new Date(out.graceUntil!).getTime() - new Date(out.enabledUntil).getTime()).toBe(
      60 * 60_000,
    );
    expect(db.tables.get(hosts)?.[0]).toMatchObject({ insecureWindowMinutes: 30 });
    expect(out.host.insecureEnabledUntil).toBeInstanceOf(Date);

    expect(db.tables.get(insecureAuthRequests)?.[0]).toMatchObject({ status: 'approved' });
    expect(recorded).toContainEqual(
      expect.objectContaining({
        type: 'insecure.domain.allowed',
        payload: expect.objectContaining({ domain: 'example.com', domain_id: 1 }),
      }),
    );
  });

  it('normalizes a trailing dot and revives the existing allow row', async () => {
    const allow: Row = {
      id: 9,
      domain: 'example.com',
      windowMinutes: 10,
      enabledUntil: '2020-01-01T00:00:00Z',
      revokedAt: '2020-01-02T00:00:00Z',
      createdAt: '2019-12-31T00:00:00Z',
      updatedAt: '2020-01-02T00:00:00Z',
    };
    const { db, svc } = setup({ allows: [allow] });

    const out = await svc.allowDomain(1, 'example.com.', 45);

    expect(out.domain).toMatchObject({
      id: 9,
      domain: 'example.com',
      window_minutes: 45,
      revoked_at: null,
      created_at: '2019-12-31T00:00:00Z',
    });
    expect(db.inserts.some((i) => i.table === insecureDomainAllows)).toBe(false);
    expect(db.tables.get(insecureDomainAllows)).toHaveLength(1);
    expect(allow).toMatchObject({
      windowMinutes: 45,
      revokedAt: null,
      enabledUntil: out.domain.enabled_until,
    });
  });

  it('falls back to the parent domain of the host FQDN when no domain is supplied', async () => {
    const { db, svc } = setup({ host: insecureHost({ fqdn: 'node.eu.example.com' }) });

    const out = await svc.allowDomain(1, null, null);

    expect(out.domain.domain).toBe('eu.example.com');
    // No explicit duration -> the host's stored window is reused.
    expect(out.windowMinutes).toBe(10);
    expect(db.tables.get(insecureDomainAllows)?.[0]).toMatchObject({
      domain: 'eu.example.com',
      windowMinutes: 10,
    });
  });
});

describe('InsecureWindowAdminService secure hosts and stale requests', () => {
  it('rejects allowDomain and approve on a secure host', async () => {
    const secure = insecureHost({ secure: 1 });
    const allowCall = setup({ host: secure });
    await expect(allowCall.svc.allowDomain(1, 'example.com', null)).rejects.toMatchObject({
      status: 422,
      code: 'validation_failed',
      message: 'Host is secure; insecure window not applicable',
    });

    const approveCall = setup({ host: insecureHost({ secure: 1 }) });
    await expect(approveCall.svc.approve(1, null)).rejects.toMatchObject({
      status: 422,
      code: 'validation_failed',
      message: 'Host is secure; insecure window not applicable',
    });
  });

  it('auto-denies and conflicts when allowDomain hits a request older than five minutes', async () => {
    const { db, svc, recorded } = setup({ requests: [stalePendingRequest()] });

    await expect(svc.allowDomain(1, 'example.com', null)).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      message: 'Request already resolved',
    });
    expect(db.tables.get(insecureAuthRequests)?.[0]).toMatchObject({ status: 'denied' });
    expect(db.tables.get(insecureDomainAllows)).toHaveLength(0);
    expect(recorded).toContainEqual(
      expect.objectContaining({
        type: 'insecure.denied',
        payload: expect.objectContaining({ request_id: 1, reason: 'timeout' }),
      }),
    );
  });

  it('auto-denies and conflicts when approve hits a request older than five minutes', async () => {
    const { db, svc } = setup({ requests: [stalePendingRequest()] });

    await expect(svc.approve(1, null)).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      message: 'Request already resolved',
    });
    expect(db.tables.get(insecureAuthRequests)?.[0]).toMatchObject({ status: 'denied' });
    // The host window must not have been opened by the expiring approve.
    expect(db.tables.get(hosts)?.[0]).toMatchObject({ insecureEnabledUntil: null });
  });
});

describe('InsecureWindowAdminService.revokeDomain', () => {
  it('stamps revokedAt on the allow row', async () => {
    const allow: Row = {
      id: 9,
      domain: 'example.com',
      windowMinutes: 10,
      enabledUntil: '2999-01-01T00:00:00Z',
      revokedAt: null,
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-01T00:00:00Z',
    };
    const { svc, recorded } = setup({ allows: [allow] });

    const out = await svc.revokeDomain(9);

    expect(out).toMatchObject({ id: 9, domain: 'example.com', created_at: '2020-01-01T00:00:00Z' });
    expect(typeof out.revoked_at).toBe('string');
    expect(allow.revokedAt).toBe(out.revoked_at);
    expect(recorded).toContainEqual(
      expect.objectContaining({
        type: 'insecure.domain.revoked',
        payload: expect.objectContaining({ domain: 'example.com', domain_id: 9 }),
      }),
    );
  });

  it('throws NotFoundError for an unknown allow id', async () => {
    const { db, svc } = setup();

    await expect(svc.revokeDomain(404)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
      message: 'Domain allow not found',
    });
    expect(db.updates.some((u) => u.table === insecureDomainAllows)).toBe(false);
  });
});
