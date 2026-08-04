import { describe, expect, it } from 'vitest';
import { cliAuthRequests, type Host } from '../../../src/db/schema.js';
import { createCliAuthService, type CliAuthService } from '../../../src/services/cli-auth.js';
import type { HostRegistrationService } from '../../../src/services/host-registration.js';
import { ApiError, ConflictError, NotFoundError } from '../../../src/http/errors.js';
import { Keyring } from '../../../src/security/keyring.js';
import { decrypt, encrypt } from '../../../src/security/secret-box.js';
import { sha256 } from '../../../src/security/hash.js';
import { isoOffsetSeconds, nowIso } from '../../../src/util/timestamp.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

/**
 * Drives the device-code state machine directly, without the /cli/auth routes:
 * the security-relevant branches (single-use key consumption, expiry, the
 * approve/deny gates) all live in the service.
 */

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const REQUEST_ID = 'a'.repeat(64);
const USER_CODE = 'ABCD-2345';
const HOST_API_KEY = 'sk-codex-clilogin';

type Row = Record<string, unknown>;
type RegisterInput = Parameters<HostRegistrationService['registerOrRotate']>[0];

interface Harness {
  db: DbFake;
  keyring: Keyring;
  service: CliAuthService;
  registrations: RegisterInput[];
}

function makeKeyring(): Keyring {
  return Keyring.fromEnv({ ENCRYPTION_ACTIVE_KEY: KEY } as unknown as Parameters<typeof Keyring.fromEnv>[0]);
}

function setup(opts: { rows?: Row[] } = {}): Harness {
  const db = createDbFake();
  db.tables.set(cliAuthRequests, opts.rows ?? []);
  const keyring = makeKeyring();

  const registrations: RegisterInput[] = [];
  const registration: HostRegistrationService = {
    async registerOrRotate(input) {
      registrations.push(input);
      return { host: { id: 42, fqdn: input.fqdn } as unknown as Host, apiKey: HOST_API_KEY };
    },
  };

  const service = createCliAuthService({ db: db as never, keyring, registration });
  return { db, keyring, service, registrations };
}

function row(over: Row = {}): Row {
  return {
    id: 1,
    requestId: REQUEST_ID,
    requestIdEnc: null,
    userCode: USER_CODE,
    userCodeHash: sha256(USER_CODE),
    fqdn: 'wrapper.example',
    secure: 1,
    status: 'pending',
    approvedByUserId: null,
    hostId: null,
    apiKeyEnc: null,
    ip: '203.0.113.9',
    userAgent: 'cdx/0.6.55',
    expiresAt: isoOffsetSeconds(600),
    createdAt: nowIso(),
    approvedAt: null,
    consumedAt: null,
    ...over,
  };
}

async function captureError(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('expected the call to reject');
}

describe('cli-auth: start', () => {
  it('rejects a blank fqdn with a 422', async () => {
    const { service, db } = setup();
    const err = await captureError(() =>
      service.start({ fqdn: '   ', secure: true, ip: '203.0.113.9', userAgent: null }),
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.code).toBe('validation_failed');
    expect(err.param).toBe('fqdn');
    expect(db.inserts).toHaveLength(0);
  });

  it('inserts a pending row keyed by sha256(user_code)', async () => {
    const { service, db, keyring } = setup();
    const out = await service.start({
      fqdn: '  wrapper.example  ',
      secure: false,
      ip: '203.0.113.9',
      userAgent: 'cdx/0.6.55',
    });

    expect(out.request_id).toMatch(/^[a-f0-9]{64}$/);
    expect(out.user_code).toMatch(/^[A-Z]{4}-[2-9]{4}$/);
    expect(out.expires_in).toBe(600);
    expect(out.poll_interval).toBe(5);

    const stored = db.tables.get(cliAuthRequests)![0]!;
    expect(stored.userCodeHash).toBe(sha256(out.user_code));
    expect(stored.userCode).toBe(out.user_code);
    expect(stored.requestId).toBe(out.request_id);
    expect(decrypt(stored.requestIdEnc as string, keyring)).toBe(out.request_id);
    expect(stored.status).toBe('pending');
    expect(stored.fqdn).toBe('wrapper.example');
    expect(stored.secure).toBe(0);
    expect(stored.ip).toBe('203.0.113.9');
    expect(stored.userAgent).toBe('cdx/0.6.55');
    const ttl = Date.parse(stored.expiresAt as string) - Date.parse(stored.createdAt as string);
    expect(ttl).toBe(600_000);
  });

});

describe('cli-auth: poll', () => {
  it('returns not_found for an unknown request id', async () => {
    const { service } = setup({ rows: [row()] });
    expect(await service.poll('b'.repeat(64))).toEqual({ status: 'not_found' });
  });

  it('returns expired once expires_at has passed', async () => {
    const { service } = setup({ rows: [row({ status: 'approved', expiresAt: isoOffsetSeconds(-1) })] });
    expect(await service.poll(REQUEST_ID)).toEqual({ status: 'expired' });
  });

  it('returns pending while nobody has answered', async () => {
    const { service } = setup({ rows: [row()] });
    expect(await service.poll(REQUEST_ID)).toEqual({ status: 'pending' });
  });

  it('returns denied after the admin rejected the request', async () => {
    const { service } = setup({ rows: [row({ status: 'denied' })] });
    expect(await service.poll(REQUEST_ID)).toEqual({ status: 'denied' });
  });

  it('hands back the decrypted api key exactly once', async () => {
    const keyring = makeKeyring();
    const { service, db } = setup({
      rows: [row({ status: 'approved', secure: 0, hostId: 42, apiKeyEnc: encrypt(HOST_API_KEY, keyring) })],
    });

    expect(await service.poll(REQUEST_ID)).toEqual({
      status: 'approved',
      api_key: HOST_API_KEY,
      fqdn: 'wrapper.example',
      secure: false,
    });
    expect(db.tables.get(cliAuthRequests)![0]!.consumedAt).toEqual(expect.any(String));

    expect(await service.poll(REQUEST_ID)).toEqual({ status: 'consumed' });
  });

  it('returns consumed when the row was already consumed', async () => {
    const keyring = makeKeyring();
    const { service, db } = setup({
      rows: [
        row({
          status: 'approved',
          apiKeyEnc: encrypt(HOST_API_KEY, keyring),
          consumedAt: '2026-07-28T20:00:00Z',
        }),
      ],
    });
    expect(await service.poll(REQUEST_ID)).toEqual({ status: 'consumed' });
    expect(db.updates).toHaveLength(0);
  });

  it('returns consumed when a racing poll won the single-use update', async () => {
    const keyring = makeKeyring();
    const consumed = row({
      status: 'approved',
      apiKeyEnc: encrypt(HOST_API_KEY, keyring),
      consumedAt: '2026-07-28T20:00:00Z',
    });
    const db = createDbFake();
    db.tables.set(cliAuthRequests, [consumed]);
    // Stale read: this poll loaded the row before the racing one consumed it,
    // so only the `WHERE consumed_at IS NULL` guard can stop the replay.
    const staleDb = {
      ...db,
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [{ ...consumed, consumedAt: null }] }) }),
      }),
    };
    const service = createCliAuthService({
      db: staleDb as never,
      keyring,
      registration: { async registerOrRotate() { throw new Error('unused'); } },
    });

    expect(await service.poll(REQUEST_ID)).toEqual({ status: 'consumed' });
    expect(db.updates).toHaveLength(1);
  });
});

describe('cli-auth: lookup', () => {
  it('matches a lowercase, whitespace-padded user code against a live row', async () => {
    const { service } = setup({ rows: [row({ expiresAt: '2027-01-01T00:00:00Z' })] });
    expect(await service.lookup(`  ${USER_CODE.toLowerCase()} `)).toEqual({
      id: 1,
      fqdn: 'wrapper.example',
      secure: true,
      ip: '203.0.113.9',
      created_at: expect.any(String),
      expires_at: '2027-01-01T00:00:00Z',
    });
  });

  it('returns null for a blank or unknown code', async () => {
    const { service } = setup({ rows: [row()] });
    expect(await service.lookup('   ')).toBeNull();
    expect(await service.lookup('ZZZZ-9999')).toBeNull();
  });
});

describe('cli-auth: approve', () => {
  it('rejects a blank user code with a 422', async () => {
    const { service } = setup({ rows: [row()] });
    const err = await captureError(() => service.approve('  ', 7, 'admin'));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.code).toBe('validation_failed');
  });

  it('throws NotFoundError for an unknown code', async () => {
    const { service } = setup({ rows: [row()] });
    await expect(service.approve('ZZZZ-9999', 7, 'admin')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws a 410 once the request expired', async () => {
    const { service, registrations } = setup({ rows: [row({ expiresAt: isoOffsetSeconds(-1) })] });
    const err = await captureError(() => service.approve(USER_CODE, 7, 'admin'));
    expect(err.status).toBe(410);
    expect(err.code).toBe('expired');
    expect(registrations).toHaveLength(0);
  });

  it('throws ConflictError when the request is already resolved', async () => {
    const { service, registrations } = setup({ rows: [row({ status: 'denied' })] });
    await expect(service.approve(USER_CODE, 7, 'admin')).rejects.toBeInstanceOf(ConflictError);
    expect(registrations).toHaveLength(0);
  });

  it('registers the host and caches the encrypted api key for the poller', async () => {
    const { service, db, keyring, registrations } = setup({ rows: [row({ secure: 0 })] });
    const out = await service.approve(` ${USER_CODE.toLowerCase()} `, 7, 'admin');

    expect(out).toEqual({ fqdn: 'wrapper.example', host_id: 42 });
    expect(registrations).toEqual([{ fqdn: 'wrapper.example', secure: false, createdBy: 'admin' }]);

    const stored = db.tables.get(cliAuthRequests)![0]!;
    expect(stored.status).toBe('approved');
    expect(stored.hostId).toBe(42);
    expect(stored.approvedByUserId).toBe(7);
    expect(stored.approvedAt).toEqual(expect.any(String));
    expect(decrypt(stored.apiKeyEnc as string, keyring)).toBe(HOST_API_KEY);
  });
});

describe('cli-auth: deny', () => {
  it('flips the row to denied and returns the fqdn', async () => {
    const { service, db } = setup({ rows: [row()] });
    expect(await service.deny(USER_CODE)).toEqual({ fqdn: 'wrapper.example' });
    const stored = db.tables.get(cliAuthRequests)![0]!;
    expect(stored.status).toBe('denied');
    expect(stored.approvedAt).toEqual(expect.any(String));
    expect(stored.apiKeyEnc).toBeNull();
  });

  it('throws NotFoundError for an unknown code', async () => {
    const { service } = setup({ rows: [row()] });
    await expect(service.deny('ZZZZ-9999')).rejects.toBeInstanceOf(NotFoundError);
  });
});
