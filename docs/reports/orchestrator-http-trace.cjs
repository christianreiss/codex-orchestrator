// Test-only preload and reducer. See orchestrator-http-trace.md for invocations.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const diagnostics = require('node:diagnostics_channel');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { IncomingMessage } = require('node:http');
const { Socket } = require('node:net');
const root = path.resolve(__dirname, '../..');
const requireApi = createRequire(path.join(root, 'api/package.json'));
const register = fs
  .readFileSync(path.join(__dirname, 'orchestrator-entrypoints.tsv'), 'utf8')
  .trimEnd()
  .split('\n')
  .slice(1)
  .map((line) => line.split('\t'));
const routes = new Map(register.filter((row) => row[1] === 'HTTP').map((row) => [row[2], row[3]]));
const tools = new Map([
  ['/mcp', new Set(register.filter((row) => row[1] === 'Fleet MCP').map((row) => row[2]))],
  ['/connectors/mcp', new Set(register.filter((row) => row[1] === 'Connector MCP').map((row) => row[2]))],
]);
const mark = Symbol('registered test trace');
const classes = ['product', 'fixture', 'plugin', 'other'];
// Only allow actual local spec files. Unrecognized workers and non-Vitest controls remain explicit.
const specs = new Set(
  fs
    .readdirSync(path.join(root, 'api/test'), { recursive: true })
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => 'test/' + f.replaceAll(path.sep, '/')),
);
function currentSpec() {
  const file = globalThis.__vitest_worker__?.filepath;
  if (typeof file !== 'string') return 'unattributed';
  const relative = path.relative(path.join(root, 'api'), file).replaceAll(path.sep, '/');
  return specs.has(relative) ? relative : 'unattributed';
}

const stats = new Map();
let eventFd;
let eventDir;
function recordEvent({ key, origin }, field, label) {
  if (eventFd === undefined) {
    eventFd = fs.openSync(path.join(eventDir, process.pid + '-' + randomUUID() + '.jsonl'), 'wx', 0o600);
  }
  fs.writeSync(eventFd, JSON.stringify([key, origin, field, label, currentSpec()]) + '\n');
}

function bucket(route, origin) {
  const key = route + '\t' + origin;
  if (!stats.has(key))
    stats.set(key, {
      registered: 0,
      matched: 0,
      handler: 0,
      status: {},
      afterHandler: {},
      transport: {},
      rpc: {},
      suites: Object.create(null),
    });
  return stats.get(key);
}
function count(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
}

// Classify the first registration caller outside Fastify internals. Never retain the stack.
function originFor(pattern) {
  const prev = Error.stackTraceLimit;
  let frames;
  try {
    Error.stackTraceLimit = 48;
    frames = new Error().stack.split('\n').slice(1);
  } finally {
    Error.stackTraceLimit = prev;
  }
  for (const frame of frames) {
    const f = frame.replaceAll('\\', '/');
    if (f.includes(__filename)) {
      if (f.includes('registerFixtureCounterexample')) return 'fixture';
      continue;
    }
    if (f.includes('/node_modules/fastify/')) continue;
    if (f.includes('/node_modules/@fastify/')) return 'plugin';
    const src = f.match(/\/(api\/(?:src|test)\/[^():\n]+?)\.[cm]?[tj]s:\d+/);
    if (src) {
      if (src[1].startsWith('api/test/')) return 'fixture';
      return routes
        .get(pattern)
        ?.replace(/:\d+$/, '')
        .replace(/\.[cm]?[tj]s$/, '') === src[1]
        ? 'product'
        : 'other';
    }
    if (f.includes('/node_modules/') || f.includes('(node:') || f.includes('node:internal')) return 'other';
  }
  return 'other';
}

function attach({ fastify }) {
  const entered = new WeakSet();
  fastify.addHook('onRoute', (options) => {
    const patterns = {};
    for (const method of [].concat(options.method)) {
      const key = method + ' ' + options.url;
      if (!routes.has(key)) continue;
      const origin = originFor(key);
      patterns[method] = { key, origin };
      recordEvent(patterns[method], 'registered');
    }
    if (!Object.keys(patterns).length) return;
    // Fastify copies config into the matched route context. A private symbol
    // survives that copy and does not change serialized config or HTTP data.
    options.config = { ...options.config, [mark]: patterns };
    if (options.websocket || options.wsHandler || typeof options.handler !== 'function') return;
    options.handler = new Proxy(options.handler, {
      apply(original, self, args) {
        const request = args[0];
        const record = request?.routeOptions?.config?.[mark]?.[request.method];
        if (record && record === patterns[request.method]) {
          entered.add(request);
          recordEvent(record, 'handler');
        }
        return Reflect.apply(original, self, args);
      },
    });
  });
  fastify.addHook('onRequest', (request, _reply, done) => {
    const record = request.routeOptions?.config?.[mark]?.[request.method];
    if (record) recordEvent(record, 'matched');
    done();
  });
  fastify.addHook('onResponse', (request, reply, done) => {
    const record = request.routeOptions?.config?.[mark]?.[request.method];
    if (record) {
      const group = Math.floor(reply.statusCode / 100);
      const status = group >= 1 && group <= 5 ? group + 'xx' : 'other';
      recordEvent(record, 'status', status);
      const raw = request.raw;
      const transport = Object.hasOwn(raw, '_lightMyRequest')
        ? 'inject'
        : raw instanceof IncomingMessage && raw.socket instanceof Socket && raw.socket.server
          ? 'http1'
          : 'unknown';
      recordEvent(record, 'transport', transport);
      if (entered.has(request)) recordEvent(record, 'afterHandler', status);
      if (record.origin === 'product' && request.method === 'POST' && tools.has(request.routeOptions.url)) {
        forEachToolName(request.routeOptions.url, request.body, (name) => recordEvent(record, 'rpc', name));
      }
    }
    done();
  });
}

// Inputs never leave this function. The callback receives only an inventory-approved literal.
function forEachToolName(url, body, emit) {
  const allow = tools.get(url);
  const calls = url === '/mcp' && Array.isArray(body) ? body : [body];
  for (const call of calls) {
    if (call?.jsonrpc !== '2.0' || call.method !== 'tools/call' || !Object.hasOwn(call, 'id')) continue;
    if (call.id !== null && typeof call.id !== 'string' && !Number.isFinite(call.id)) continue;
    if (allow.has(call.params?.name)) emit(call.params.name);
  }
}

function reduce(dir) {
  const totals = new Map();
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  if (!files.length) throw Error('No Fastify trace shards');
  for (const file of files) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').trimEnd().split('\n')) {
      if (!line) continue;
      const [route, origin, field, label, spec] = JSON.parse(line);
      if (spec !== 'unattributed' && !specs.has(spec)) throw Error('Invalid test source');
      if (!routes.has(route) || !classes.includes(origin)) throw Error('Invalid route or origin');
      const b = bucket(route, origin);
      if (['matched', 'handler', 'status', 'afterHandler'].includes(field)) {
        const evidence = (b.suites[spec] ??= {});
        count(evidence, field === 'status' ? label : field === 'afterHandler' ? 'h' + label : field);
      }
      if (['registered', 'matched', 'handler'].includes(field)) b[field]++;
      else if (field === 'transport' && ['http1', 'inject', 'unknown'].includes(label))
        count(b.transport, label);
      else if (field === 'rpc' && tools.get(route.slice(5))?.has(label)) count(b.rpc, label);
      else if (['status', 'afterHandler'].includes(field) && (label === 'other' || /^[1-5]xx$/.test(label)))
        count(b[field], label);
      else throw Error('Invalid trace event');
    }
  }
  const format = (obj) =>
    Object.keys(obj)
      .sort()
      .map((k) => k + '=' + obj[k])
      .join(',') || '-';
  const lines = [
    [
      'method and registered pattern',
      'inventory source',
      'product registrations',
      'product matched',
      'original handler calls',
      'product responses',
      'product response transport',
      'responses after original handler',
      'fixture registered',
      'fixture matched',
      'fixture handler calls',
      'fixture responses',
      'plugin registered',
      'plugin matched',
      'plugin handler calls',
      'plugin responses',
      'other registered',
      'other matched',
      'other handler calls',
      'other responses',
      'allowlisted tools/call envelopes in HTTP requests',
      'product request evidence by Vitest spec',
    ].join('\t'),
  ];
  for (const [key, source] of routes) {
    const [p, f, plugin, other] = classes.map((origin) => bucket(key, origin));
    lines.push(
      [
        key,
        source,
        p.registered,
        p.matched,
        p.handler,
        format(p.status),
        format(p.transport),
        format(p.afterHandler),
        f.registered,
        f.matched,
        f.handler,
        format(f.status),
        plugin.registered,
        plugin.matched,
        plugin.handler,
        format(plugin.status),
        other.registered,
        other.matched,
        other.handler,
        format(other.status),
        format(p.rpc),
        Object.entries(p.suites)
          .sort(([a], [b]) => a.localeCompare(b, 'en'))
          .map(([s, v]) => s + '[' + format(v) + ']')
          .join(';') || '-',
      ].join('\t'),
    );
    for (const [what, value] of Object.entries({
      registered: p.registered,
      matched: p.matched,
      entered: p.handler,
      fixture: f.matched,
      plugin: plugin.matched,
      other: other.matched,
    }))
      if (value) totals.set(what, (totals.get(what) || 0) + 1);
  }
  return { text: lines.join('\n') + '\n', totals: Object.fromEntries(totals) };
}
if (process.env.ORCH_HTTP_TRACE_DIR && process.env.NODE_ENV === 'test') {
  eventDir = fs.realpathSync(process.env.ORCH_HTTP_TRACE_DIR);
  diagnostics.channel('fastify.initialization').subscribe(attach);
}
if (require.main === module && process.argv[2] === 'reduce') {
  const result = reduce(process.argv[3]);
  fs.writeFileSync(process.argv[4], result.text);
  console.log(JSON.stringify(result.totals));
}

async function selftest() {
  const assert = require('node:assert/strict');
  const fastify = requireApi('fastify');
  const { registerHealthRoutes } = await import('../../api/src/routes/health.ts');
  const dir = fs.realpathSync(process.env.ORCH_HTTP_TRACE_DIR);
  assert.equal(fs.readdirSync(dir).length, 0, 'Control requires an empty, separate output directory');
  const app = fastify();
  const fixture = fastify();
  function registerFixtureCounterexample() {
    fixture.get('/healthz', () => ({ ok: true }));
  }
  registerFixtureCounterexample();
  let deny = false;
  app.addHook('onRequest', async (_req, reply) => {
    if (deny) return reply.code(403).send();
  });
  await registerHealthRoutes(app, {}, async () => ({ critical_complete: false, checks: [] }));
  try {
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    assert.equal((await fetch(base + '/healthz')).status, 200);
    assert.equal((await fetch(base + '/healthz', { method: 'HEAD' })).status, 200);
    deny = true;
    assert.equal((await fetch(base + '/healthz')).status, 403);
    deny = false;
    assert.equal((await app.inject('/readyz')).statusCode, 503);
    assert.equal((await fixture.inject('/healthz')).statusCode, 200);
  } finally {
    await app.close();
    await fixture.close();
  }
  reduce(dir);
  const h = bucket('GET /healthz', 'product');
  assert.deepEqual(
    [h.matched, h.handler, h.status, h.afterHandler, h.transport],
    [2, 1, { '2xx': 1, '4xx': 1 }, { '2xx': 1 }, { http1: 2 }],
  );
  assert.equal(bucket('HEAD /healthz', 'product').handler, 1);
  assert.deepEqual(bucket('GET /readyz', 'product').afterHandler, { '5xx': 1 });
  assert.deepEqual(bucket('GET /readyz', 'product').transport, { inject: 1 });
  assert.equal(bucket('GET /healthz', 'fixture').handler, 1);
  const names = [];
  const call = { jsonrpc: '2.0', id: null, method: 'tools/call', params: { name: 'skill_list' } };
  const { id: _id, ...notification } = call;
  forEachToolName(
    '/mcp',
    [call, notification, { ...call, id: {} }, { ...call, params: { name: 'unlisted' } }],
    (value) => names.push(value),
  );
  forEachToolName('/connectors/mcp', [call], (value) => names.push(value));
  forEachToolName('/connectors/mcp', { ...call, params: { name: 'hosts_list' } }, (value) =>
    names.push(value),
  );
  assert.deepEqual(names, ['skill_list', 'hosts_list']);
  console.log(
    'Control passed: product GET and implicit HEAD, rejected GET, handler 503, fixture lookalike, HTTP/1 and injection.',
  );
}
if (require.main === module && process.argv[2] === 'selftest') {
  selftest().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

// The canonical run retains its original, individually verifiable columns.
// Supplemental runs have their own counters. A source list measures the union
// by route without counting a repeated scenario twice as additional coverage.
if (require.main === module && process.argv[2] === 'merge') {
  const [canonicalDir, output, ...arguments_] = process.argv.slice(3);
  if (!canonicalDir || !output || !arguments_.length) {
    throw Error('Usage: merge CANONICAL_DIR OUTPUT.tsv SOURCE=DIR [SOURCE=DIR ...]');
  }
  const runs = new Map([['canonical', [canonicalDir]]]);
  for (const arg of arguments_) {
    const separator = arg.indexOf('=');
    const name = arg.slice(0, separator);
    const directory = arg.slice(separator + 1);
    if (separator < 1 || !/^[a-z][a-z0-9-]{0,39}$/.test(name) || name === 'canonical' || !directory)
      throw Error('Invalid additional trace source');
    if (!runs.has(name)) runs.set(name, []);
    runs.get(name).push(directory);
  }
  const seenDirectories = new Set();
  const seenShards = new Set();
  const fields = [
    'product registrations',
    'product matched',
    'original handler calls',
    'product responses',
    'product response transport',
    'responses after original handler',
    'allowlisted tools/call envelopes in HTTP requests',
    'product request evidence by Vitest spec',
  ];
  let lines;
  let indexes;
  const unions = new Map();
  for (const [name, directories] of runs) {
    stats.clear();
    let table;
    for (const directory of directories) {
      const real = fs.realpathSync(directory);
      if (seenDirectories.has(real)) throw Error('Repeated trace directory');
      seenDirectories.add(real);
      for (const shard of fs.readdirSync(real).filter((file) => file.endsWith('.jsonl'))) {
        // Each collector creates a new random shard name. Preserve that name when transporting it.
        const source = fs.realpathSync(path.join(real, shard));
        if (seenShards.has(shard) || seenShards.has(source)) throw Error('Repeated trace shard');
        seenShards.add(shard);
        seenShards.add(source);
      }
      // Each reduction adds this directory's validated events to the current run.
      table = reduce(real)
        .text.trimEnd()
        .split('\n')
        .map((r) => r.split('\t'));
    }
    if (!lines) {
      lines = table.map((row) => [...row]);
      indexes = fields.map((field) => table[0].indexOf(field));
      if (indexes.includes(-1)) throw Error('Incomplete canonical trace');
    } else {
      lines[0].push(...fields.map((field) => name + ' ' + field));
    }
    for (let i = 1; i < table.length; i++) {
      const row = table[i];
      if (row[0] !== lines[i][0] || row[1] !== lines[i][1]) throw Error('Trace inventory differs');
      const values = indexes.map((column) => row[column]);
      if (name !== 'canonical') lines[i].push(...values);
      const covered = [
        Number(values[0]) > 0,
        Number(values[1]) > 0,
        Number(values[2]) > 0,
        /(?:^|,)2xx=/.test(values[5]),
        /(?:^|,)http1=/.test(values[4]),
      ];
      if (!unions.has(i))
        unions.set(
          i,
          covered.map(() => []),
        );
      covered.forEach((present, j) => {
        if (present) unions.get(i)[j].push(name);
      });
    }
  }
  lines[0].push(
    'union product registration sources',
    'union product match sources',
    'union original handler sources',
    'union handler 2xx sources',
    'union HTTP/1 response sources',
  );
  for (let i = 1; i < lines.length; i++)
    lines[i].push(...unions.get(i).map((names) => names.join(',') || '-'));
  fs.writeFileSync(output, lines.map((row) => row.join('\t')).join('\n') + '\n');
}
