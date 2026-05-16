import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { expect } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';

/**
 * Fixture format produced by `tests/contract/record.sh`:
 *
 *   {
 *     "name": "label-for-readability",
 *     "expectShape": "standard" | "openai" | "anthropic" | "raw",
 *     "request":  { "method": "GET", "url": "/admin/...", "headers": {...}, "body": ... },
 *     "response": { "status": 200, "headers": {...}, "body": ... }
 *   }
 *
 * `expectShape` is optional — when omitted we infer from the URL prefix
 * (matching the production envelope formatter selector).
 */
export interface ContractFixture {
  name?: string;
  expectShape?: 'standard' | 'openai' | 'anthropic' | 'raw';
  request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
  response: {
    status: number;
    headers?: Record<string, string>;
    body: unknown;
  };
}

export function loadFixture(path: string): ContractFixture {
  const raw = readFileSync(path, 'utf8');
  let parsed: ContractFixture;
  try {
    parsed = JSON.parse(raw) as ContractFixture;
  } catch (e) {
    throw new Error(`contract fixture ${path}: invalid JSON: ${(e as Error).message}`);
  }
  if (!parsed.request || typeof parsed.request.method !== 'string' || typeof parsed.request.url !== 'string') {
    throw new Error(`contract fixture ${path}: missing request.method/url`);
  }
  if (!parsed.response || typeof parsed.response.status !== 'number') {
    throw new Error(`contract fixture ${path}: missing response.status`);
  }
  return parsed;
}

/**
 * Recursively enumerate every .json fixture under `dir`. Returns absolute paths.
 */
export function discoverFixtures(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...discoverFixtures(full));
    } else if (full.endsWith('.json')) {
      out.push(full);
    }
  }
  return out.sort();
}

export const FIXTURE_ROOT = resolve(import.meta.dirname, '..', 'fixtures');

export function fixtureLabel(absolutePath: string): string {
  return relative(FIXTURE_ROOT, absolutePath).replace(/\.json$/, '');
}

/**
 * Replays a fixture against the given Fastify app. Asserts:
 *
 *   1. HTTP status code matches.
 *   2. For JSON responses, the top-level shape matches the recorded body.
 *      Shape match = same set of keys + recursive same primitive-type buckets.
 *      We deliberately do not compare scalar values (ids, timestamps, tokens
 *      change between runs) — only structural compatibility is enforced.
 *   3. The recorded body conforms to the expected envelope shape
 *      (`standard` / `openai` / `anthropic`). This catches accidental envelope
 *      drift the inner-payload shape check would otherwise miss.
 */
export async function replayFixture(
  app: FastifyInstance,
  fixture: ContractFixture,
): Promise<void> {
  const headers = { ...(fixture.request.headers ?? {}) };
  const payload = fixture.request.body;
  const method = fixture.request.method.toUpperCase();
  const injectOpts: InjectOptions = {
    method: method as InjectOptions['method'],
    url: fixture.request.url,
    headers: stripHopByHop(headers),
  };
  if (payload !== undefined && payload !== null && method !== 'GET') {
    injectOpts.payload = payload as string | object | Buffer;
  }
  const got = await app.inject(injectOpts);
  expect(got.statusCode, `${fixture.request.method} ${fixture.request.url} status`).toBe(
    fixture.response.status,
  );

  const expectedShape = fixture.expectShape ?? inferShape(fixture.request.url);
  const responseCt = got.headers['content-type'];
  const isJson = typeof responseCt === 'string' && responseCt.includes('application/json');

  if (isJson) {
    let actualBody: unknown;
    try {
      actualBody = JSON.parse(got.payload);
    } catch (e) {
      throw new Error(
        `${fixture.request.method} ${fixture.request.url}: response not parseable JSON: ${(e as Error).message}`,
      );
    }
    assertEnvelopeShape(actualBody, expectedShape, got.statusCode);
    if (fixture.response.body !== undefined && fixture.response.body !== null) {
      assertSameShape(
        actualBody,
        fixture.response.body,
        `${fixture.request.method} ${fixture.request.url}`,
      );
    }
  }
}

/**
 * Quick envelope structural check. Catches when /v1/ accidentally returns a
 * { status: ok, data: ... } wrapper or /admin/ accidentally returns a bare
 * OpenAI body.
 */
export function assertEnvelopeShape(
  body: unknown,
  shape: 'standard' | 'openai' | 'anthropic' | 'raw',
  status: number,
): void {
  if (shape === 'raw') return;
  if (status >= 400) {
    if (shape === 'standard') {
      expect(body, 'standard error must have status:error').toMatchObject({ status: 'error' });
    } else if (shape === 'openai') {
      expect(body, 'openai error must have error.message').toMatchObject({
        error: expect.objectContaining({ message: expect.any(String) }),
      });
    } else if (shape === 'anthropic') {
      expect(body, 'anthropic error must have type:error').toMatchObject({
        type: 'error',
        error: expect.objectContaining({ message: expect.any(String) }),
      });
    }
    return;
  }
  if (shape === 'standard') {
    expect(body, 'standard success must have status:ok').toMatchObject({ status: 'ok' });
  }
  // openai/anthropic success has no fixed top-level marker — the recorded
  // body shape check below catches drift.
}

/**
 * Compares the top-level *shape* of two JSON values:
 *  - same JS type at each path
 *  - same key set on every object
 *  - arrays compared by element-type homogeneity (not length)
 *  - leaf primitives compared by `typeof` only, not value
 */
export function assertSameShape(actual: unknown, expected: unknown, label: string): void {
  shapeWalk(actual, expected, label, []);
}

function shapeWalk(actual: unknown, expected: unknown, label: string, path: string[]): void {
  const at = path.length ? `.${path.join('.')}` : '';
  const actT = typeOf(actual);
  const expT = typeOf(expected);
  if (actT !== expT) {
    throw new Error(`${label}${at}: shape mismatch (got ${actT}, expected ${expT})`);
  }
  if (expT === 'array') {
    const aArr = actual as unknown[];
    const eArr = expected as unknown[];
    if (eArr.length === 0) return; // permissive: empty recorded array
    // Compare each actual element against the *first* recorded element type.
    for (let i = 0; i < aArr.length; i++) {
      shapeWalk(aArr[i], eArr[0], label, [...path, `[${i}]`]);
    }
    return;
  }
  if (expT === 'object') {
    const aObj = actual as Record<string, unknown>;
    const eObj = expected as Record<string, unknown>;
    const aKeys = Object.keys(aObj).sort();
    const eKeys = Object.keys(eObj).sort();
    const missing = eKeys.filter((k) => !aKeys.includes(k));
    const extra = aKeys.filter((k) => !eKeys.includes(k));
    if (missing.length) {
      throw new Error(`${label}${at}: missing keys [${missing.join(', ')}]`);
    }
    if (extra.length) {
      // Extras are allowed — the legacy backend may have added a field; we
      // only fail when something *expected* is gone.
    }
    for (const k of eKeys) {
      shapeWalk(aObj[k], eObj[k], label, [...path, k]);
    }
    return;
  }
  // primitives: same typeof, no value comparison
}

function typeOf(v: unknown): 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean' | 'undefined' {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  return typeof v as 'string' | 'number' | 'boolean' | 'undefined';
}

function inferShape(url: string): 'standard' | 'openai' | 'anthropic' | 'raw' {
  if (url.startsWith('/anthropic/v1/')) return 'anthropic';
  if (url.startsWith('/v1/') || url === '/v1') return 'openai';
  return 'standard';
}

/**
 * Strip hop-by-hop and transport-specific headers that aren't safe to replay.
 * `inject()` rejects some of these or treats them as a body indicator.
 */
function stripHopByHop(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (
      lk === 'host' ||
      lk === 'content-length' ||
      lk === 'connection' ||
      lk === 'transfer-encoding' ||
      lk === 'accept-encoding' ||
      lk === 'keep-alive'
    ) {
      continue;
    }
    out[k] = v;
  }
  return out;
}
