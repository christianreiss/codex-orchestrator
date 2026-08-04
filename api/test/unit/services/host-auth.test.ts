import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dnsMock = vi.hoisted(() => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
  reverse: vi.fn(),
}));

vi.mock('node:dns', () => ({ promises: dnsMock }));

import type { FastifyRequest } from 'fastify';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';
import { hosts, type Host } from '../../../src/db/schema.js';
import { createHostAuthService, type HostAuthService } from '../../../src/services/host-auth.js';
import type { InsecureWindowService } from '../../../src/services/insecure-window.js';
import type { SettingsService } from '../../../src/services/settings.js';
import { ForbiddenError, UnauthorizedError } from '../../../src/http/errors.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import type { Env } from '../../../src/env.js';

const KEY = 'sk-codex-test';
const CLIENT_IP = '203.0.113.5';
const CLIENT_IP6 = '2001:db8::5';

const warnSpy = vi.fn();

function hostRow(overrides: Partial<Host> = {}): Host {
  return {
    id: 1,
    fqdn: 'host.example.com',
    apiKey: 'legacy-plaintext',
    apiKeyHash: hashApiKey(KEY),
    status: 'active',
    secure: 1,
    allowRoamingIps: 0,
    // 0 = never enforce reverse DNS; the cases that care set their own mode.
    reverseDnsMode: 0,
    ip4: null,
    ip6: null,
    insecureEnabledUntil: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Host;
}

/** Only `getFlag`/`getInt` are reachable from the service. */
function stubSettings(values: Record<string, string> = {}): SettingsService {
  return {
    async getFlag(key: string, defaultValue = false): Promise<boolean> {
      const raw = values[key];
      if (raw === undefined || raw === '') return defaultValue;
      return raw === '1' || raw.toLowerCase() === 'true';
    },
    async getInt(key: string, defaultValue: number): Promise<number> {
      const raw = values[key];
      if (raw === undefined || raw === '') return defaultValue;
      return Math.trunc(Number(raw));
    },
  } as unknown as SettingsService;
}

interface Harness {
  db: DbFake;
  svc: HostAuthService;
}

function harness(
  opts: {
    rows?: Host[];
    env?: Partial<Env>;
    settings?: Record<string, string>;
    insecure?: InsecureWindowService;
  } = {},
): Harness {
  const tables = new Map<unknown, Record<string, unknown>[]>();
  tables.set(
    hosts,
    (opts.rows ?? []).map((row) => ({ ...row }) as unknown as Record<string, unknown>),
  );
  const db = createDbFake(tables);
  const svc = createHostAuthService({
    db: db as never,
    env: {
      AUTH_RUNNER_IP_BYPASS: false,
      AUTH_RUNNER_BYPASS_SUBNETS: '',
      ...opts.env,
    } as Env,
    settings: stubSettings(opts.settings),
    insecure: opts.insecure,
  });
  return { db, svc };
}

function makeReq(
  opts: { key?: string; ip?: string | null; method?: string; force?: boolean } = {},
): FastifyRequest {
  return {
    headers: opts.key ? { 'x-api-key': opts.key } : {},
    clientIp: opts.ip === undefined ? CLIENT_IP : opts.ip,
    method: opts.method ?? 'GET',
    query: opts.force ? { force: '1' } : {},
    log: { warn: warnSpy },
  } as unknown as FastifyRequest;
}

function insecureStub(outcome: 'grant' | 'deny'): InsecureWindowService {
  return {
    async enforce(host: Host) {
      if (outcome === 'deny') throw new ForbiddenError('closed', 'insecure_denied');
      return host;
    },
    async openInitial() {},
  };
}

let events: Array<{ type: string; payload: unknown }> = [];
let unsubscribe: () => void = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  // Nothing resolves unless a case says otherwise, so a required reverse-DNS
  // check fails closed by default.
  dnsMock.resolve4.mockRejectedValue(new Error('ENOTFOUND'));
  dnsMock.resolve6.mockRejectedValue(new Error('ENOTFOUND'));
  dnsMock.reverse.mockRejectedValue(new Error('ENOTFOUND'));
  events = [];
  unsubscribe = wsPublisher.subscribe((e) => events.push({ type: e.type, payload: e.payload }));
});

afterEach(() => {
  unsubscribe();
});

describe('authenticate key lookup', () => {
  it('rejects when no API key is present', async () => {
    const h = harness({ rows: [hostRow()] });

    const err = await h.svc.authenticate(makeReq()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err).toMatchObject({ code: 'missing_api_key', status: 401 });
  });

  it('rejects when the key matches no host', async () => {
    const h = harness({ rows: [hostRow()] });

    const err = await h.svc.authenticate(makeReq({ key: 'sk-codex-other' })).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err).toMatchObject({ code: 'invalid_api_key', status: 401 });
  });

  it('falls back to the legacy plaintext apiKey column', async () => {
    const h = harness({
      rows: [hostRow({ apiKeyHash: null, apiKey: 'legacy-plaintext', ip4: CLIENT_IP })],
    });

    const host = await h.svc.authenticate(makeReq({ key: 'legacy-plaintext' }));

    expect(host).toMatchObject({ id: 1, fqdn: 'host.example.com' });
  });

  it('rejects a host whose status is not active', async () => {
    const h = harness({ rows: [hostRow({ status: 'disabled' })] });

    const err = await h.svc.authenticate(makeReq({ key: KEY })).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).toMatchObject({ code: 'host_disabled', status: 403 });
  });
});

describe('IP binding', () => {
  it('binds ip4 for a v4 client when neither address is bound', async () => {
    const h = harness({ rows: [hostRow()] });

    const host = await h.svc.authenticate(makeReq({ key: KEY }));

    expect(host.ip4).toBe(CLIENT_IP);
    expect(h.db.updates).toHaveLength(1);
    expect(h.db.updates[0]?.set).toMatchObject({ ip4: CLIENT_IP });
  });

  it('binds ip6 for a v6 client when neither address is bound', async () => {
    const h = harness({ rows: [hostRow()] });

    const host = await h.svc.authenticate(makeReq({ key: KEY, ip: CLIENT_IP6 }));

    expect(host.ip6).toBe(CLIENT_IP6);
    expect(host.ip4).toBeNull();
    expect(h.db.updates[0]?.set).toMatchObject({ ip6: CLIENT_IP6 });
  });

  it('accepts a request from the bound address without rebinding', async () => {
    const h = harness({ rows: [hostRow({ ip4: CLIENT_IP })] });

    const host = await h.svc.authenticate(makeReq({ key: KEY }));

    expect(host.ip4).toBe(CLIENT_IP);
    expect(h.db.updates).toHaveLength(0);
  });

  it('rejects a same-family mismatch when no insecure window service is wired', async () => {
    const h = harness({ rows: [hostRow({ ip4: '198.51.100.9', allowRoamingIps: 0 })] });

    const err = await h.svc.authenticate(makeReq({ key: KEY })).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err).toMatchObject({ code: 'ip_mismatch', status: 401 });
    expect(h.db.updates).toHaveLength(0);
  });

  it('rejects a same-family mismatch when the insecure window refuses', async () => {
    const h = harness({
      rows: [hostRow({ ip4: '198.51.100.9', allowRoamingIps: 0, secure: 0 })],
      insecure: insecureStub('deny'),
    });

    const err = await h.svc.authenticate(makeReq({ key: KEY })).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'ip_mismatch', status: 401 });
  });

  it('rebinds a roaming host on a same-family mismatch', async () => {
    const h = harness({ rows: [hostRow({ ip4: '198.51.100.9', allowRoamingIps: 1 })] });

    const host = await h.svc.authenticate(makeReq({ key: KEY }));

    expect(host.ip4).toBe(CLIENT_IP);
    expect(h.db.updates[0]?.set).toMatchObject({ ip4: CLIENT_IP });
  });

  it('rebinds when the insecure window grants the extension', async () => {
    const h = harness({
      rows: [hostRow({ ip4: '198.51.100.9', allowRoamingIps: 0, secure: 0 })],
      insecure: insecureStub('grant'),
    });

    const host = await h.svc.authenticate(makeReq({ key: KEY }));

    expect(host.ip4).toBe(CLIENT_IP);
  });

  it('rejects a v4 client on a v6-only host when roaming is off', async () => {
    const h = harness({ rows: [hostRow({ ip6: CLIENT_IP6, allowRoamingIps: 0 })] });

    const err = await h.svc.authenticate(makeReq({ key: KEY })).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'ip_mismatch', status: 401 });
  });

  it('binds the missing family on a v6-only host when roaming is on', async () => {
    const h = harness({ rows: [hostRow({ ip6: CLIENT_IP6, allowRoamingIps: 1 })] });

    const host = await h.svc.authenticate(makeReq({ key: KEY }));

    expect(host).toMatchObject({ ip4: CLIENT_IP, ip6: CLIENT_IP6 });
  });

  it('skips binding when the client IP is absent or not an IP address', async () => {
    const absent = harness({ rows: [hostRow({ ip4: '198.51.100.9' })] });
    await expect(absent.svc.authenticate(makeReq({ key: KEY, ip: null }))).resolves.toMatchObject({
      ip4: '198.51.100.9',
    });
    expect(absent.db.updates).toHaveLength(0);

    const junk = harness({ rows: [hostRow({ ip4: '198.51.100.9' })] });
    await expect(
      junk.svc.authenticate(makeReq({ key: KEY, ip: 'not-an-ip' })),
    ).resolves.toMatchObject({ ip4: '198.51.100.9' });
    expect(junk.db.updates).toHaveLength(0);
  });
});

describe('AUTH_RUNNER_IP_BYPASS', () => {
  it('skips binding for an address inside a bypass subnet', async () => {
    const h = harness({
      rows: [hostRow({ ip4: '198.51.100.9' })],
      env: { AUTH_RUNNER_IP_BYPASS: true, AUTH_RUNNER_BYPASS_SUBNETS: '10.0.0.0/8' },
    });

    const host = await h.svc.authenticate(makeReq({ key: KEY, ip: '10.1.2.3' }));

    expect(host.ip4).toBe('198.51.100.9');
    expect(h.db.updates).toHaveLength(0);
  });

  it('ignores malformed CIDR entries', async () => {
    const mixed = harness({
      rows: [hostRow({ ip4: '198.51.100.9' })],
      env: { AUTH_RUNNER_IP_BYPASS: true, AUTH_RUNNER_BYPASS_SUBNETS: 'nonsense, ,10.0.0.0/8' },
    });
    await expect(
      mixed.svc.authenticate(makeReq({ key: KEY, ip: '10.1.2.3' })),
    ).resolves.toMatchObject({ ip4: '198.51.100.9' });
    expect(mixed.db.updates).toHaveLength(0);

    // A list that parses to nothing leaves the binding machinery in charge.
    const onlyJunk = harness({
      rows: [hostRow()],
      env: { AUTH_RUNNER_IP_BYPASS: true, AUTH_RUNNER_BYPASS_SUBNETS: 'nonsense' },
    });
    await expect(
      onlyJunk.svc.authenticate(makeReq({ key: KEY, ip: '10.1.2.3' })),
    ).resolves.toMatchObject({ ip4: '10.1.2.3' });
  });

  it('still binds an address outside every bypass subnet', async () => {
    const h = harness({
      rows: [hostRow()],
      env: { AUTH_RUNNER_IP_BYPASS: true, AUTH_RUNNER_BYPASS_SUBNETS: '10.0.0.0/8' },
    });

    const host = await h.svc.authenticate(makeReq({ key: KEY }));

    expect(host.ip4).toBe(CLIENT_IP);
    expect(h.db.updates[0]?.set).toMatchObject({ ip4: CLIENT_IP });
  });
});

describe('force delete', () => {
  it('skips IP binding and reverse DNS and publishes the mismatch audit event', async () => {
    const h = harness({
      rows: [hostRow({ ip4: '198.51.100.9', reverseDnsMode: 1, allowRoamingIps: 0 })],
    });

    const host = await h.svc.authenticate(
      makeReq({ key: KEY, method: 'DELETE', force: true }),
    );

    expect(host.ip4).toBe('198.51.100.9');
    expect(h.db.updates).toHaveLength(0);
    expect(dnsMock.reverse).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      type: 'host.force_delete_ip_mismatch',
      payload: { id: 1, fqdn: 'host.example.com', ip: CLIENT_IP },
    });
  });

  it('stays silent when the force-delete IP matches a bound address or nothing is bound', async () => {
    const bound = harness({ rows: [hostRow({ ip4: CLIENT_IP })] });
    await bound.svc.authenticate(makeReq({ key: KEY, method: 'DELETE', force: true }));

    const unbound = harness({ rows: [hostRow()] });
    await unbound.svc.authenticate(makeReq({ key: KEY, method: 'DELETE', force: true }));

    expect(warnSpy).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'host.force_delete_ip_mismatch')).toEqual([]);
  });
});

describe('reverse DNS', () => {
  it('enforces the check when the host mode is 1', async () => {
    dnsMock.resolve4.mockResolvedValue([CLIENT_IP]);
    dnsMock.reverse.mockResolvedValue(['host.example.com']);
    const h = harness({ rows: [hostRow({ reverseDnsMode: 1, ip4: CLIENT_IP })] });

    await expect(h.svc.authenticate(makeReq({ key: KEY }))).resolves.toMatchObject({ id: 1 });
    expect(dnsMock.reverse).toHaveBeenCalledWith(CLIENT_IP);
  });

  it('enforces the fleet flag when the host defers, mapping a failure to reverse_dns_failed', async () => {
    const h = harness({
      rows: [hostRow({ reverseDnsMode: null, ip4: CLIENT_IP })],
      settings: { reverse_dns_enabled: '1' },
    });

    const err = await h.svc.authenticate(makeReq({ key: KEY })).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err).toMatchObject({ code: 'reverse_dns_failed', status: 401 });
    expect(dnsMock.reverse).toHaveBeenCalledWith(CLIENT_IP);
  });

  it('skips the check when the host defers and the fleet flag is off', async () => {
    const h = harness({
      rows: [hostRow({ reverseDnsMode: null, ip4: CLIENT_IP })],
      settings: { reverse_dns_enabled: '0' },
    });

    await expect(h.svc.authenticate(makeReq({ key: KEY }))).resolves.toMatchObject({ id: 1 });
    expect(dnsMock.reverse).not.toHaveBeenCalled();
  });

  it('skips the check for an insecure host inside an open window', async () => {
    const h = harness({
      rows: [
        hostRow({
          reverseDnsMode: 1,
          ip4: CLIENT_IP,
          secure: 0,
          insecureEnabledUntil: new Date(Date.now() + 60_000),
        }),
      ],
    });

    await expect(h.svc.authenticate(makeReq({ key: KEY }))).resolves.toMatchObject({ id: 1 });
    expect(dnsMock.reverse).not.toHaveBeenCalled();
  });
});

describe('pruneInactiveHosts', () => {
  const now = new Date('2026-07-28T12:00:00.000Z');
  // createDbFake has no comparison operators: for a `lt` filter it falls back to
  // matching rows that carry the bound parameter's value, so a row seeded at
  // exactly the cutoff is what the fake reports as stale. That makes the seeded
  // cutoff itself the assertion about which window the service used.
  const cutoff = (days: number) =>
    new Date(now.getTime() - days * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  it('returns 0 for a zero or negative window', async () => {
    const zero = harness({
      rows: [hostRow({ updatedAt: cutoff(30) })],
      settings: { inactivity_window_days: '0' },
    });
    await expect(zero.svc.pruneInactiveHosts(now)).resolves.toBe(0);

    const negative = harness({
      rows: [hostRow({ updatedAt: cutoff(30) })],
      settings: { inactivity_window_days: '-5' },
    });
    await expect(negative.svc.pruneInactiveHosts(now)).resolves.toBe(0);

    expect(zero.db.deletes).toHaveLength(0);
    expect(negative.db.deletes).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it('clamps a window above 60 days down to 60', async () => {
    const h = harness({
      rows: [hostRow({ updatedAt: cutoff(60), createdAt: '2020-01-01T00:00:00Z' })],
      settings: { inactivity_window_days: '365' },
    });

    await expect(h.svc.pruneInactiveHosts(now)).resolves.toBe(1);
  });

  it('deletes and publishes host.pruned for each stale row', async () => {
    const h = harness({
      rows: [
        hostRow({ id: 7, fqdn: 'stale-a.example.com', updatedAt: cutoff(30) }),
        hostRow({ id: 8, fqdn: 'stale-b.example.com', updatedAt: cutoff(30) }),
        hostRow({ id: 9, fqdn: 'fresh.example.com', updatedAt: '2026-07-28T11:00:00Z' }),
      ],
    });

    await expect(h.svc.pruneInactiveHosts(now)).resolves.toBe(2);
    expect(h.db.deletes).toHaveLength(2);
    expect(h.db.tables.get(hosts)).toEqual([expect.objectContaining({ id: 9 })]);
    expect(events).toEqual([
      { type: 'host.pruned', payload: { id: 7, fqdn: 'stale-a.example.com', reason: 'inactive' } },
      { type: 'host.pruned', payload: { id: 8, fqdn: 'stale-b.example.com', reason: 'inactive' } },
    ]);
  });
});
