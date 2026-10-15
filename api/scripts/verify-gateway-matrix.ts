/** Live provider acceptance, opt-in only. See docs/auth-runner.md. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { createDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrator.js';
import { versions } from '../src/db/schema.js';
import type { Env } from '../src/env.js';
import { Keyring } from '../src/security/keyring.js';
import { envelopePlugin } from '../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../src/http/plugins/request-id.js';
import type { RouteContext } from '../src/routes/index.js';
import { registerOpenAiCompatRoutes } from '../src/routes/v1/index.js';
import { registerAnthropicCompatRoutes } from '../src/routes/anthropic-v1/index.js';
import { registerGrokCompatRoutes } from '../src/routes/grok-v1/index.js';
import { API_SURFACES, API_SURFACE_IDS, createSurfaceRouting, type ApiSurfaceId } from '../src/services/api-surfaces.js';
import { createGatewayBackends } from '../src/services/gateway-backends.js';
import { OpenAiKeyService } from '../src/services/openai-keys.js';
import { invalidateFleetEngineState } from '../src/services/engine-switch.js';
import { ENGINES, type Engine } from '../src/util/engine.js';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value !== null && typeof value === 'object' ? value as ObjectValue : {};
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function content(value: unknown): string {
  return list(value).map(block => text(object(block).text)).join('');
}
function answer(body: ObjectValue): string {
  const choice = object(list(body.choices)[0]);
  return text(object(choice.message).content) || text(choice.text) || text(body.completion)
    || content(body.content) || list(body.output).map(item => content(object(item).content)).join('');
}
function sseAnswer(raw: string, anthropic: boolean): string {
  return raw.split(/\r?\n/).filter(line => line.startsWith('data: '))
    .map(line => line.slice(6)).filter(line => line !== '[DONE]')
    .map(line => object(JSON.parse(line)))
    .map(event => anthropic ? text(object(event.delta).text)
      : text(object(object(list(event.choices)[0]).delta).content) || text(object(list(event.choices)[0]).text)).join('');
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

assert.equal(process.env.GATEWAY_MATRIX_LIVE, '1', 'Set GATEWAY_MATRIX_LIVE=1 for real, billable provider calls');
const dbUrl = new URL(process.env.TEST_DATABASE_URL ?? '');
const runnerUrl = new URL(process.env.GATEWAY_MATRIX_RUNNER_URL ?? '');
for (const url of [dbUrl, runnerUrl]) {
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use an isolated loopback database and runner');
}
assert.match(dbUrl.pathname, /^\/gateway_matrix(?:_[a-z0-9_]+)?$/, 'Use a dedicated gateway_matrix database');
assert(process.env.GATEWAY_MATRIX_RUNNER_SECRET, 'Provide the isolated runner secret');
assert(process.env.GATEWAY_MATRIX_REPORT, 'Provide a report destination');

let input = '';
for await (const chunk of process.stdin) input += String(chunk);
const snapshots = object(object(JSON.parse(input)).snapshots);
input = '';
for (const engine of ENGINES) assert(Object.keys(object(snapshots[engine])).length, `Missing ${engine} access snapshot`);
function rejectRefresh(value: unknown) {
  for (const [key, entry] of Object.entries(object(value))) {
    if (/^refresh_?token$/i.test(key)) assert(!entry, 'Only refresh-incapable snapshots may enter this test');
    else if (entry && typeof entry === 'object') rejectRefresh(entry);
  }
}
rejectRefresh(snapshots);

const runId = randomBytes(6).toString('hex').toUpperCase();
const startedAt = new Date().toISOString();
const harnessSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
const traces: ObjectValue[] = [];
const checks: ObjectValue[] = [];
let sequence = 0;
const proxy = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const payload = object(JSON.parse(raw));
    assert.equal(req.headers['x-runner-auth'], 'isolated-relay');
    const credentialEngine = ENGINES.find(engine => JSON.stringify(snapshots[engine]) === JSON.stringify(payload.auth_json));
    const trace: ObjectValue = {
      marker: text(payload.prompt).match(/MATRIX_[A-Z0-9_]+/)?.[0],
      engine: payload.engine, model: payload.model, credential_engine: credentialEngine ?? 'unknown',
    };
    traces.push(trace);
    const upstream = await fetch(new URL('/exec', runnerUrl), {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-runner-auth': process.env.GATEWAY_MATRIX_RUNNER_SECRET! },
      body: raw, signal: AbortSignal.timeout(70_000),
    });
    const response = await upstream.text();
    trace.http = upstream.status;
    trace.runner_status = object(JSON.parse(response)).status;
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(response);
  } catch {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'fail', error: 'Isolated runner relay failed' }));
  }
});
const relay = await listen(proxy);
const env = {
  DB_HOST: dbUrl.hostname, DB_PORT: Number(dbUrl.port || 3306), DB_DATABASE: dbUrl.pathname.slice(1),
  DB_USERNAME: decodeURIComponent(dbUrl.username), DB_PASSWORD: decodeURIComponent(dbUrl.password),
  AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  AUTH_RUNNER_URL: `${relay}/verify`, AUTH_RUNNER_SHARED_SECRET: 'isolated-relay', AUTH_RUNNER_EXEC_TIMEOUT: 60,
} as Env;
const { db, pool } = createDb(env);
const app = Fastify({ logger: false });
const keys = new OpenAiKeyService({ db, keyring: Keyring.fromEnv(env) });
const issued: Partial<Record<Engine, Awaited<ReturnType<typeof keys.issue>>>> = {};
const legacyIssued: typeof issued = {};
const cleanupKeys: Array<{ id: number; engine: Engine }> = [];
const model: Record<Engine, string> = { codex: 'gpt-6.1-sol', claude: 'claude-sonnet-5', grok: 'grok-4.7' };
let base = '';
let runnerHealth: unknown;

async function flag(name: string, version: string) {
  await db.insert(versions).values({ name, version, updatedAt: new Date().toISOString() })
    .onDuplicateKeyUpdate({ set: { version, updatedAt: new Date().toISOString() } });
  invalidateFleetEngineState(db);
}
function headers(surface: ApiSurfaceId, engine = API_SURFACES[surface].keyEngine, legacy = false): Record<string, string> {
  const key = (legacy ? legacyIssued : issued)[engine]?.key;
  assert(key);
  return surface === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${key}` };
}

interface Case {
  surface: ApiSurfaceId;
  backend: Engine;
  name: string;
  path: string;
  method?: string;
  payload?: ObjectValue;
  status?: number;
  generation?: boolean;
  stream?: boolean;
  fallback?: boolean;
  badKey?: boolean;
  legacy?: boolean;
  verify?: (body: ObjectValue) => void;
}
async function check(test: Case) {
  const marker = `MATRIX_${runId}_${++sequence}`;
  const left = 100 + randomBytes(2).readUInt16LE() % 300;
  const right = 100 + randomBytes(2).readUInt16LE() % 300;
  const expected = String(left + right);
  // A real arithmetic question avoids providers treating an arbitrary-token
  // echo as prompt injection. The answer must still be freshly computed.
  const prompt = `Smoke-test reference: ${marker}. What is ${left} + ${right}? Answer with the number only.`;
  const payload = {
    model: model[test.backend], messages: [{ role: 'system', content: 'Follow the requested response format.' }, { role: 'user', content: prompt }],
    prompt, input: prompt, ...(test.surface === 'anthropic' ? { max_tokens: 128 } : {}), ...test.payload,
  };
  const row: ObjectValue = { surface: test.surface, backend: test.backend, routing_mode: test.legacy ? 'endpoint_default' : 'assigned_key', check: test.name, path: test.path };
  const began = performance.now();
  try {
    const response = await fetch(`${base}${API_SURFACES[test.surface].basePath}${test.path}`, {
      method: test.method ?? 'POST',
      headers: { ...headers(test.surface, test.badKey ? ENGINES.find(engine => engine !== API_SURFACES[test.surface].keyEngine) : undefined, test.legacy), 'content-type': 'application/json' },
      body: (test.method === 'GET' || test.method === 'OPTIONS') ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(75_000),
    });
    const raw = await response.text();
    const body = response.headers.get('content-type')?.includes('text/event-stream') ? {} : object(raw ? JSON.parse(raw) : {});
    row.http = response.status;
    if (body.error) row.error = body.error;
    assert.equal(response.status, test.status ?? 200, raw);
    const dispatched = traces.filter(trace => trace.marker === marker);
    if (test.generation) {
      const output = test.stream ? sseAnswer(raw, test.surface === 'anthropic') : answer(body);
      row.output = output;
      row.model = body.model;
      row.dispatch = dispatched;
      row.challenge = { marker, left, right, expected_sum: expected };
      assert.equal(output.trim(), expected, 'Provider must compute the fresh arithmetic challenge');
      assert.equal(dispatched.length, 1, 'Exactly one real runner dispatch');
      assert.equal(dispatched[0]?.engine, test.backend);
      assert.equal(dispatched[0]?.credential_engine, test.backend);
      assert.equal(dispatched[0]?.http, 200);
      assert.equal(dispatched[0]?.runner_status, 'ok');
      if (!test.fallback) assert.equal(dispatched[0]?.model, model[test.backend]);
      if (!test.stream) {
        assert.equal(body.model, dispatched[0]?.model);
        assert(text(body.id), 'Generated objects must carry an id');
        if (test.path === '/responses') assert.equal(body.object, 'response');
        else if (test.surface === 'anthropic') assert.equal(body.type, test.path === '/messages' ? 'message' : 'completion');
        else assert.equal(body.object, test.path === '/chat/completions' ? 'chat.completion' : 'text_completion');
      }
      if (test.stream) {
        assert(response.headers.get('content-type')?.includes('text/event-stream'));
        assert(raw.includes(test.surface === 'anthropic' ? 'event: message_stop' : 'data: [DONE]'));
      }
    } else {
      assert.equal(dispatched.length, 0, 'Refused/metadata requests must not execute a provider');
    }
    test.verify?.(body);
    row.result = 'pass';
  } catch (error) {
    row.result = 'fail';
    row.failure = error instanceof Error ? error.message : String(error);
  }
  row.elapsed_ms = Math.round(performance.now() - began);
  checks.push(row);
  process.stderr.write(`${row.result === 'pass' ? 'PASS' : 'FAIL'} ${test.surface}/${test.backend} ${test.name} (${row.http ?? 'no response'}, ${row.elapsed_ms}ms)\n`);
}

try {
  const health = await fetch(new URL('/health', runnerUrl));
  runnerHealth = await health.json();
  assert.equal(health.status, 200);
  for (const engine of ENGINES) assert.equal(object(object(object(runnerHealth).engines)[engine]).available, true);
  await runMigrations(pool, { initSchema: true, appliedBy: 'live-gateway-matrix' });
  for (const engine of ENGINES) {
    legacyIssued[engine] = await keys.issue({ name: `matrix-${runId}-${engine}-legacy`, engine });
    cleanupKeys.push({ id: legacyIssued[engine]!.record.id, engine });
    await flag(`${engine}_engine_disabled`, '0');
  }
  for (const surface of API_SURFACE_IDS) await flag(API_SURFACES[surface].disabledFlag, '0');
  await app.register(cookie);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);
  const ctx = { db, env, keyring: Keyring.fromEnv(env) } as RouteContext;
  const gateway = {
    routing: createSurfaceRouting(db, 0),
    backends: createGatewayBackends(ctx, undefined, Object.fromEntries(ENGINES.map(engine => [engine, {
      authSnapshot: async () => snapshots[engine], onExecSuccess: () => undefined,
    }]))),
  };
  await registerOpenAiCompatRoutes(app, ctx, { gateway });
  await registerGrokCompatRoutes(app, ctx, { gateway });
  await registerAnthropicCompatRoutes(app, ctx, { gateway });
  base = await app.listen({ host: '127.0.0.1', port: 0 });

  for (const backend of ENGINES) {
    const conflictingDefault = ENGINES[(ENGINES.indexOf(backend) + 1) % ENGINES.length]!;
    for (const surface of API_SURFACE_IDS) {
      const engine = API_SURFACES[surface].keyEngine;
      issued[engine] = await keys.issue({ name: `matrix-${runId}-${surface}-${backend}`, engine, backendEngine: backend });
      cleanupKeys.push({ id: issued[engine]!.record.id, engine });
      await flag(API_SURFACES[surface].backendFlag, conflictingDefault);
    }
    await Promise.all(API_SURFACE_IDS.map(async surface => {
      const common = { surface, backend };
      const primary = surface === 'anthropic' ? '/messages' : '/chat/completions';
      await check({ ...common, name: 'models', path: '/models', method: 'GET', verify: body => {
        assert(list(body.data).some(item => object(item).id === model[backend]));
        const first = object(list(body.data)[0]);
        assert.equal(surface === 'anthropic' ? first.type : first.object, 'model');
      } });
      await check({ ...common, name: 'retrieve-model', path: `/models/${model[backend]}`, method: 'GET', verify: body => assert.equal(body.id, model[backend]) });
      await check({ ...common, name: 'reject-other-key-namespace', path: '/models', method: 'GET', badKey: true, status: 401 });
      for (const path of (surface === 'anthropic' ? ['/messages', '/complete', '/completions', '/responses'] : ['/chat/completions', '/completions', '/responses'])) {
        await check({ ...common, name: `generate${path}`, path, generation: true });
      }
      for (const path of surface === 'anthropic' ? ['/messages', '/complete', '/completions'] : ['/chat/completions', '/completions']) {
        await check({ ...common, name: `stream${path}`, path, payload: { stream: true },
          stream: true, generation: backend !== 'grok', status: backend === 'grok' ? 400 : 200 });
      }
      await check({ ...common, name: 'responses-reject-stream', path: '/responses', payload: { stream: true }, status: 400 });
      if (backend !== API_SURFACES[surface].identityBackend) {
        await check({ ...common, name: 'native-model-fallback', path: primary, generation: true, fallback: true,
          payload: { model: model[API_SURFACES[surface].identityBackend] } });
      }
      if (surface === 'anthropic') await check({ ...common, name: 'count-tokens', path: '/messages/count_tokens', verify: body => assert(Number(body.input_tokens) > 0) });
      await check({ ...common, name: 'embeddings-contract', path: '/embeddings', status: surface === 'anthropic' ? 501 : 400 });
      await check({ ...common, name: 'unknown-model', path: '/models/unknown-matrix-model', method: 'GET', status: 404 });
    }));
    await flag(`${backend}_engine_disabled`, '1');
    for (const surface of API_SURFACE_IDS) await check({ surface, backend, name: 'backend-master-switch', path: surface === 'anthropic' ? '/messages' : '/chat/completions', status: 503 });
    await flag(`${backend}_engine_disabled`, '0');
    for (const surface of API_SURFACE_IDS) await flag(API_SURFACES[surface].backendFlag, backend);
    await Promise.all(API_SURFACE_IDS.map(async surface => {
      await check({ surface, backend, legacy: true, name: 'legacy-models', path: '/models', method: 'GET', verify: body => {
        assert(list(body.data).some(item => object(item).id === model[backend]));
      } });
      await check({ surface, backend, legacy: true, name: 'legacy-generate', path: surface === 'anthropic' ? '/messages' : '/chat/completions', generation: true });
    }));
  }
} finally {
  await app.close();
  await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
  for (const { id, engine } of cleanupKeys) await keys.delete(id, engine);
  await pool.end();
  let commit = 'unknown';
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* no git */ }
  const report = {
    started_at: startedAt, finished_at: new Date().toISOString(), run_id: runId, source_commit: commit,
    boundary: 'Isolated MySQL and HTTP API/runner; production route, key, model and adapter code; access-only verified canonical snapshots injected; no production routing changes.',
    runner_url: runnerUrl.origin, runner_image: process.env.GATEWAY_MATRIX_RUNNER_IMAGE ?? 'unspecified', runner_health: runnerHealth,
    harness_sha256: harnessSha256,
    combinations: API_SURFACE_IDS.flatMap(surface => ENGINES.map(backend => {
      const rows = checks.filter(row => row.surface === surface && row.backend === backend);
      const generated = rows.filter(row => row.result === 'pass' && row.output).length;
      return { surface, backend, result: rows.length === 0 ? 'not_run'
        : generated > 0 && rows.every(row => row.result === 'pass') ? 'pass' : 'fail', generated };
    })),
    checks,
  };
  await writeFile(process.env.GATEWAY_MATRIX_REPORT!, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const failed = checks.filter(row => row.result === 'fail').length;
  process.stderr.write(`Matrix: ${checks.length - failed}/${checks.length} checks passed; ${traces.length} real runner calls.\n`);
  if (failed || checks.length === 0) process.exitCode = 1;
}
