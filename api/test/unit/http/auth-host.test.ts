import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeAuthHostPlugin } from '../../../src/http/plugins/auth-host.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { hosts as hostsTable, type Host } from '../../../src/db/schema.js';
import type { Database } from '../../../src/db/client.js';
import { ApiError, UnauthorizedError } from '../../../src/http/errors.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';

/**
 * `requireHost` is the trust boundary in front of every wrapper-facing route:
 * which row a presented key resolves to, and whether a resolved host is allowed
 * through, decides who can read and write another machine's auth material. Both
 * halves are pinned here -- including the legacy plaintext `api_key` fallback,
 * whose column host-registration now fills with the *hash*, so the digest itself
 * is a working credential today.
 */

function hostRow(overrides: Partial<Host> = {}): Host {
  return {
    id: 7,
    fqdn: 'worker.example.com',
    apiKey: 'sk-codex-some-other-host',
    apiKeyHash: null,
    apiKeyEnc: null,
    status: 'active',
    secure: 1,
    ...overrides,
  } as Host;
}

interface Probe {
  app: FastifyInstance;
  /** Errors escaping `requireHost`, captured so `instanceof` stays assertable. */
  errors: unknown[];
}

async function buildProbe(rows: Host[]): Promise<Probe> {
  const tables = new Map<unknown, Record<string, unknown>[]>();
  tables.set(hostsTable, rows as unknown as Record<string, unknown>[]);
  const db = createDbFake(tables);
  const errors: unknown[] = [];

  const app = Fastify({ logger: false });
  await app.register(makeAuthHostPlugin(db as unknown as Database));
  // resolveHostFromKey has no gate of its own -- it only answers "which row?".
  app.get('/resolve', async (req) => ({ id: (await app.resolveHostFromKey(req))?.id ?? null }));
  app.get('/probe', { preHandler: app.requireHost }, async (req) => ({
    id: req.authHost?.id ?? null,
  }));
  app.setErrorHandler(async (err, _req, reply) => {
    errors.push(err);
    const status = err instanceof ApiError ? err.status : 500;
    const code = err instanceof ApiError ? err.code : 'unhandled';
    return reply.code(status).send({ code });
  });
  await app.ready();
  return { app, errors };
}

async function resolvedId(
  app: FastifyInstance,
  headers: Record<string, string> = {},
): Promise<number | null> {
  const res = await app.inject({ method: 'GET', url: '/resolve', headers });
  expect(res.statusCode).toBe(200);
  return (res.json() as { id: number | null }).id;
}

async function probe(
  app: FastifyInstance,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: { id?: number | null; code?: string } }> {
  const res = await app.inject({ method: 'GET', url: '/probe', headers });
  return { statusCode: res.statusCode, body: res.json() as { id?: number | null; code?: string } };
}

const KEY = 'sk-codex-live-key';

describe('auth-host key resolution', () => {
  it('resolves a host by api_key_hash and populates req.authHost', async () => {
    const { app } = await buildProbe([hostRow({ apiKeyHash: hashApiKey(KEY) })]);

    expect(await resolvedId(app, { 'x-api-key': KEY })).toBe(7);
    expect(await probe(app, { 'x-api-key': KEY })).toEqual({ statusCode: 200, body: { id: 7 } });
    await app.close();
  });

  it('accepts the same key as a bearer token or an x-api-key header', async () => {
    const { app } = await buildProbe([hostRow({ apiKeyHash: hashApiKey(KEY) })]);

    expect((await probe(app, { authorization: `Bearer ${KEY}` })).body).toEqual({ id: 7 });
    expect((await probe(app, { 'x-api-key': KEY })).body).toEqual({ id: 7 });
    // Authorization wins over x-api-key when both are present.
    expect(
      (await probe(app, { authorization: `Bearer ${KEY}`, 'x-api-key': 'sk-codex-wrong' })).body,
    ).toEqual({ id: 7 });
    await app.close();
  });

  it('rejects a request with no credential at all as invalid_api_key', async () => {
    const { app, errors } = await buildProbe([hostRow({ apiKeyHash: hashApiKey(KEY) })]);

    expect(await resolvedId(app)).toBeNull();
    expect(await probe(app)).toEqual({ statusCode: 401, body: { code: 'invalid_api_key' } });
    expect(errors[0]).toBeInstanceOf(UnauthorizedError);
    expect(errors[0]).toMatchObject({ code: 'invalid_api_key', message: 'Invalid API key' });
    await app.close();
  });

  it('rejects a key that matches neither the hash nor the legacy column', async () => {
    const { app } = await buildProbe([hostRow({ apiKeyHash: hashApiKey(KEY) })]);

    expect(await resolvedId(app, { 'x-api-key': 'sk-codex-not-a-host' })).toBeNull();
    expect(await probe(app, { 'x-api-key': 'sk-codex-not-a-host' })).toEqual({
      statusCode: 401,
      body: { code: 'invalid_api_key' },
    });
    await app.close();
  });
});

describe('auth-host legacy plaintext fallback', () => {
  it('falls back to the plaintext api_key column for a host with no hash yet', async () => {
    const { app } = await buildProbe([hostRow({ apiKey: KEY, apiKeyHash: null })]);

    expect((await probe(app, { 'x-api-key': KEY })).body).toEqual({ id: 7 });
    await app.close();
  });

  it('authenticates a hash presented as the key, because api_key now stores the hash', async () => {
    // host-registration writes `apiKey: apiKeyHash` alongside `apiKeyHash`, so the
    // fallback compares the presented key against a digest. Anyone holding the
    // digest -- which is not a secret in the way the key is -- passes as the host.
    const hash = hashApiKey(KEY);
    const { app } = await buildProbe([hostRow({ apiKey: hash, apiKeyHash: hash })]);

    expect((await probe(app, { 'x-api-key': KEY })).body).toEqual({ id: 7 });
    expect((await probe(app, { 'x-api-key': hash })).body).toEqual({ id: 7 });
    await app.close();
  });
});

describe('auth-host status gate', () => {
  it('rejects a disabled host with host_disabled instead of admitting it', async () => {
    const { app, errors } = await buildProbe([
      hostRow({ apiKeyHash: hashApiKey(KEY), status: 'disabled' }),
    ]);

    // The row still resolves -- only requireHost applies the gate.
    expect(await resolvedId(app, { 'x-api-key': KEY })).toBe(7);
    expect(await probe(app, { 'x-api-key': KEY })).toEqual({
      statusCode: 401,
      body: { code: 'host_disabled' },
    });
    expect(errors[0]).toBeInstanceOf(UnauthorizedError);
    expect(errors[0]).toMatchObject({ message: 'Host disabled' });
    await app.close();
  });

  it('derives the error code from whatever non-active status the row carries', async () => {
    const { app } = await buildProbe([
      hostRow({ apiKeyHash: hashApiKey(KEY), status: 'retired' }),
    ]);

    expect(await probe(app, { 'x-api-key': KEY })).toEqual({
      statusCode: 401,
      body: { code: 'host_retired' },
    });
    await app.close();
  });

  it('admits an active host and one whose status is empty', async () => {
    const { app } = await buildProbe([
      hostRow({ apiKeyHash: hashApiKey(KEY), status: 'active' }),
      hostRow({ id: 8, apiKeyHash: hashApiKey('sk-codex-blank'), status: '' }),
    ]);

    expect((await probe(app, { 'x-api-key': KEY })).body).toEqual({ id: 7 });
    expect((await probe(app, { 'x-api-key': 'sk-codex-blank' })).body).toEqual({ id: 8 });
    await app.close();
  });
});
