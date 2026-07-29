import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adminEvents,
  hosts as hostsTable,
  logs as logsTable,
} from '../../../src/db/schema.js';
import {
  createHostRegistrationService,
  type HostRegistrationService,
} from '../../../src/services/host-registration.js';
import type { InsecureWindowService } from '../../../src/services/insecure-window.js';
import { Keyring } from '../../../src/security/keyring.js';
import { decrypt } from '../../../src/security/secret-box.js';
import { sha256 } from '../../../src/security/hash.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

/**
 * The CLI approve path mints hosts here, so the column contract is the point:
 * `api_key` holds the *hash* for the legacy unique index, `api_key_hash` the
 * same digest, and only `api_key_enc` can be decrypted back to the key handed
 * to the caller.
 */

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const STALE_KEY = 'sk-codex-stale';
const ROTATE_FQDN = 'rotate.example.com';
const OLD_ISO = '2020-01-01T00:00:00Z';
const WINDOW_OPENED_AT = new Date('2026-07-29T12:00:00Z');

type Row = Record<string, unknown>;

interface Harness {
  db: DbFake;
  keyring: Keyring;
  service: HostRegistrationService;
  openCalls: Array<{ hostId: number; windowMinutes: number | undefined }>;
}

function setup(rows: Row[] = []): Harness {
  const db = createDbFake();
  db.tables.set(hostsTable, rows);
  db.tables.set(adminEvents, []);
  db.tables.set(logsTable, []);
  const keyring = Keyring.fromEnv({ ENCRYPTION_ACTIVE_KEY: KEY } as unknown as Parameters<
    typeof Keyring.fromEnv
  >[0]);

  const openCalls: Harness['openCalls'] = [];
  const insecure: InsecureWindowService = {
    async enforce(host) {
      return host;
    },
    async openInitial(hostId, windowMinutes) {
      openCalls.push({ hostId, windowMinutes });
      // Replaces the row rather than mutating it in place, so the opened
      // window is only visible to a caller that actually re-reads.
      const stored = db.tables.get(hostsTable) ?? [];
      const idx = stored.findIndex((r) => r.id === hostId);
      if (idx >= 0) stored[idx] = { ...stored[idx], insecureEnabledUntil: WINDOW_OPENED_AT };
    },
  };

  const service = createHostRegistrationService({ db: db as never, keyring, insecure });
  return { db, keyring, service, openCalls };
}

function existingRow(over: Row = {}): Row {
  return {
    id: 7,
    fqdn: ROTATE_FQDN,
    apiKey: sha256(STALE_KEY),
    apiKeyHash: sha256(STALE_KEY),
    apiKeyEnc: 'sbox:v1:kid=legacy:stale',
    status: 'active',
    secure: 1,
    engines: 'codex',
    insecureEnabledUntil: null,
    createdAt: OLD_ISO,
    updatedAt: OLD_ISO,
    ...over,
  };
}

let events: Array<{ type: string; payload: unknown }> = [];
let unsubscribe: () => void = () => {};

beforeEach(() => {
  events = [];
  unsubscribe = wsPublisher.subscribe((e) => events.push({ type: e.type, payload: e.payload }));
});

afterEach(() => {
  unsubscribe();
});

describe('registerOrRotate: new host', () => {
  it('inserts one active row carrying the hash in both key columns and the encrypted key', async () => {
    const h = setup();

    const { host, apiKey } = await h.service.registerOrRotate({ fqdn: 'new.example.com' });

    expect(h.db.tables.get(hostsTable)).toHaveLength(1);
    expect(host.status).toBe('active');
    expect(host.engines).toBe('codex');
    expect(host.secure).toBe(1);
    expect(apiKey.startsWith('sk-codex-')).toBe(true);
    expect(host.apiKeyHash).toBe(sha256(apiKey));
    expect(host.apiKey).toBe(host.apiKeyHash);
    expect(decrypt(host.apiKeyEnc!, h.keyring)).toBe(apiKey);
  });

  it('trims the fqdn before inserting', async () => {
    const h = setup();

    const { host } = await h.service.registerOrRotate({ fqdn: '  fresh.example.com \n' });

    expect(host.fqdn).toBe('fresh.example.com');
  });

  it('writes a host.created admin event and log row', async () => {
    const h = setup();

    const { host } = await h.service.registerOrRotate({
      fqdn: 'audit.example.com',
      createdBy: 'admin@example.com',
      engines: 'codex,claude',
    });

    const payload = { fqdn: 'audit.example.com', createdBy: 'admin@example.com', engines: 'codex,claude' };
    const auditRows = h.db.tables.get(adminEvents)!;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ type: 'host.created', hostId: host.id, payload });
    const logRows = h.db.tables.get(logsTable)!;
    expect(logRows).toHaveLength(1);
    expect(logRows[0]).toMatchObject({ hostId: host.id, action: 'host.created' });
    expect(JSON.parse(logRows[0]!.details as string)).toEqual(payload);
  });

  it('publishes host.created', async () => {
    const h = setup();

    const { host } = await h.service.registerOrRotate({ fqdn: 'ws.example.com' });

    expect(events).toEqual([{ type: 'host.created', payload: { id: host.id, fqdn: 'ws.example.com' } }]);
  });
});

describe('registerOrRotate: existing host', () => {
  it('rotates the row in place with a fresh key and a refreshed updatedAt', async () => {
    const h = setup([existingRow()]);

    const { host, apiKey } = await h.service.registerOrRotate({
      fqdn: ROTATE_FQDN,
      engines: 'codex,claude',
    });

    expect(h.db.tables.get(hostsTable)).toHaveLength(1);
    expect(h.db.inserts.filter((i) => i.table === hostsTable)).toHaveLength(0);
    expect(host.id).toBe(7);
    expect(apiKey).not.toBe(STALE_KEY);
    expect(host.apiKeyHash).toBe(sha256(apiKey));
    expect(host.apiKeyHash).not.toBe(sha256(STALE_KEY));
    expect(host.apiKey).toBe(host.apiKeyHash);
    expect(decrypt(host.apiKeyEnc!, h.keyring)).toBe(apiKey);
    expect(host.engines).toBe('codex,claude');
    expect(host.createdAt).toBe(OLD_ISO);
    expect(host.updatedAt).not.toBe(OLD_ISO);
  });

  it('trims the fqdn before the lookup', async () => {
    const h = setup([existingRow()]);

    const { host } = await h.service.registerOrRotate({ fqdn: `  ${ROTATE_FQDN} \n` });

    expect(host.id).toBe(7);
    expect(h.db.tables.get(hostsTable)).toHaveLength(1);
  });

  it('keeps the stored engines when the caller omits the field', async () => {
    const h = setup([existingRow({ engines: 'codex,claude' })]);

    const { host } = await h.service.registerOrRotate({ fqdn: ROTATE_FQDN });

    expect(host.engines).toBe('codex,claude');
    expect(h.db.tables.get(hostsTable)![0]!.engines).toBe('codex,claude');
    expect(h.db.tables.get(adminEvents)![0]).toMatchObject({
      type: 'host.rotated',
      payload: { fqdn: ROTATE_FQDN, createdBy: null, engines: 'codex,claude' },
    });
  });

  it('overwrites the stored engines when the caller passes the field', async () => {
    const h = setup([existingRow({ engines: 'codex,claude' })]);

    const { host } = await h.service.registerOrRotate({ fqdn: ROTATE_FQDN, engines: 'codex' });

    expect(host.engines).toBe('codex');
    expect(h.db.tables.get(hostsTable)![0]!.engines).toBe('codex');
    expect(h.db.tables.get(adminEvents)![0]).toMatchObject({
      type: 'host.rotated',
      payload: { fqdn: ROTATE_FQDN, createdBy: null, engines: 'codex' },
    });
  });

  it('writes a host.rotated admin event and log row with a null createdBy when omitted', async () => {
    const h = setup([existingRow()]);

    await h.service.registerOrRotate({ fqdn: ROTATE_FQDN });

    const payload = { fqdn: ROTATE_FQDN, createdBy: null, engines: 'codex' };
    const auditRows = h.db.tables.get(adminEvents)!;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ type: 'host.rotated', hostId: 7, payload });
    const logRows = h.db.tables.get(logsTable)!;
    expect(logRows).toHaveLength(1);
    expect(logRows[0]).toMatchObject({ hostId: 7, action: 'host.rotated' });
    expect(JSON.parse(logRows[0]!.details as string)).toEqual(payload);
  });

  it('publishes host.updated', async () => {
    const h = setup([existingRow()]);

    await h.service.registerOrRotate({ fqdn: ROTATE_FQDN });

    expect(events).toEqual([{ type: 'host.updated', payload: { id: 7, fqdn: ROTATE_FQDN } }]);
  });
});

describe('registerOrRotate: insecure window', () => {
  it('opens the initial window and re-reads the inserted row when secure is false', async () => {
    const h = setup();

    const { host } = await h.service.registerOrRotate({
      fqdn: 'insecure.example.com',
      secure: false,
      insecureWindowMinutes: 45,
    });

    expect(h.openCalls).toEqual([{ hostId: host.id, windowMinutes: 45 }]);
    expect(host.secure).toBe(0);
    expect(host.insecureEnabledUntil).toEqual(WINDOW_OPENED_AT);
  });

  it('opens the initial window and re-reads the rotated row when secure is false', async () => {
    const h = setup([existingRow()]);

    const { host } = await h.service.registerOrRotate({ fqdn: ROTATE_FQDN, secure: false });

    expect(h.openCalls).toEqual([{ hostId: 7, windowMinutes: undefined }]);
    expect(host.secure).toBe(0);
    expect(host.insecureEnabledUntil).toEqual(WINDOW_OPENED_AT);
  });

  it('leaves the window closed when secure defaults to true', async () => {
    const h = setup();

    const { host } = await h.service.registerOrRotate({ fqdn: 'secure.example.com' });

    expect(h.openCalls).toEqual([]);
    expect(host.insecureEnabledUntil).toBeUndefined();
  });
});
