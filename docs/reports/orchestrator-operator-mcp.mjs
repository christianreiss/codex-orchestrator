import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// Run from a checkout with its API dependencies installed, against a disposable loopback MySQL.
const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '../..');
const api = path.join(root, 'api');
const req = createRequire(path.join(api, 'package.json'));
const mysql = req('mysql2/promise'),
  WS = req('ws');
const [destination] = process.argv.slice(2);
const dbPort = Number(process.env.REVIEW_MYSQL_PORT),
  pass = process.env.REVIEW_MYSQL_PASSWORD;
assert(
  destination && pass && Number.isInteger(dbPort) && dbPort > 0 && dbPort <= 65535,
  'Supply a new evidence directory, REVIEW_MYSQL_PORT and REVIEW_MYSQL_PASSWORD',
);
const username = process.env.REVIEW_MYSQL_USER || 'root';
const lab = path.resolve(destination);
await fs.mkdir(lab, { mode: 0o700 });
const store = await fs.mkdtemp(path.join(lab, 'private-'));
const fsRoot = path.join(store, 'fs');
const schema = 'review_operator_' + randomUUID().replaceAll('-', '');
const operator = randomBytes(24).toString('hex');
const runtime = ['--import', path.join(api, 'node_modules/tsx/dist/loader.mjs')];
let db,
  created = false,
  base,
  epoch = 0;
const started = new Date().toISOString();
const revision = (ref) => execFileSync('git', ['rev-parse', ref], { cwd: root, encoding: 'utf8' }).trim();
const gitHead = revision('HEAD'),
  apiTree = revision('HEAD:api');
const env = {
  PATH: process.env.PATH,
  TZ: 'UTC',
  CXX_COMMUNICATOR_ENABLED: '1',
  ENV_FILE: '/dev/null',
  DB_HOST: '127.0.0.1',
  DB_PORT: String(dbPort),
  DB_USERNAME: username,
  DB_PASSWORD: pass,
  DB_DATABASE: schema,
  AUTH_RUNNER_URL: '',
  AUTH_RUNNER_SHARED_SECRET: '',
  MIGRATIONS_DIR: path.join(api, 'src/db/migrations'),
  ENCRYPTION_ACTIVE_KEY: randomBytes(32).toString('base64'),
  LISTEN_HOST: '127.0.0.1',
  LISTEN_PORT: '0',
  LOG_LEVEL: 'info',
  DATA_ROOT: store,
  PUBLIC_BASE_URL: 'http://127.0.0.1',
  MCP_OPERATOR_TOKEN: operator,
  MCP_FS_ROOT: fsRoot,
};
await fs.mkdir(fsRoot);
await fs.mkdir(path.join(fsRoot, 'notes'));
let server,
  cookie = '',
  step = '';
const sockets = [];
const evidence = [],
  pending = [],
  rows = [],
  hostLabels = new Map(),
  bridgeLabels = new Map();
function identity(headers) {
  if (headers.Authorization) return 'operator + enrolled host';
  if (headers['x-agent-bridge-token'])
    return bridgeLabels.get(headers['x-agent-bridge-token']) || 'synthetic native session';
  return hostLabels.get(headers['x-api-key']) || 'synthetic host';
}
function done(name) {
  step = name;
  evidence.push(name);
  for (const row of pending.splice(0)) rows.push([row.name, row.identity, name, row.source]);
  console.log(name);
}
async function http(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json();
  return {
    status: res.status,
    v: j.data ?? j,
    cookie: res.headers.get('set-cookie')?.split(';')[0],
  };
}
async function ok(method, url, body, headers) {
  const r = await http(method, url, body, headers);
  assert(
    r.status >= 200 && r.status < 300,
    method + ' ' + url + ' ' + r.status + ' ' + (r.v?.code ?? r.v?.error?.code ?? 'request failed'),
  );
  return r.v;
}
async function call(headers, method, params = {}) {
  const { v, status } = await http('POST', '/mcp', { jsonrpc: '2.0', id: randomUUID(), method, params }, headers);
  if (v.error || status !== 200)
    throw Error(
      JSON.stringify({
        name: method,
        status,
        code: v.error?.code,
        msg: v.error?.message ?? v.code ?? v.message,
      }).slice(0, 350),
    );
  return v.result;
}
async function tool(h, n, args = {}) {
  const caller = new Error().stack
    .split('\n')
    .slice(2)
    .find((line) => line.includes(script));
  const loc = caller?.match(/:(\d+):\d+\)?$/)?.[1];
  assert(loc, 'Expected a local tool-call source');
  const r = await call(h, 'tools/call', { name: n, arguments: args });
  const s = r?.content?.[0]?.text;
  if (r.isError) throw Error(n + ': ' + s?.slice(0, 260));
  const value = s === undefined ? r : JSON.parse(s);
  pending.push({ name: n, identity: identity(h), source: 'docs/reports/orchestrator-operator-mcp.mjs:' + loc });
  return value;
}
async function refused(action, label) {
  const expected = {
    'host filesystem call': /-32601/,
    'operator missing host': /invalid_mcp_credential/,
    'resource stale digest': /shared_memory_conflict/,
    'schedule stale version': /schedule_version_conflict/,
    'Git missing native proof': /native instance attachment/,
    'native session bound to other host': /agent_bridge_host_mismatch/,
  }[label];
  assert(expected, label);
  await assert.rejects(action, expected, label);
}
function digest(x) {
  return createHash('sha256').update(x).digest('hex');
}
async function start(fsEnabled = true) {
  const logPath = path.join(store, 'api-' + ++epoch + '.log');
  const log = await fs.open(logPath, 'wx', 0o600);
  try {
    server = spawn(process.execPath, [...runtime, 'src/server.ts'], {
      cwd: api,
      env: { ...env, MCP_FS_ROOT: fsEnabled ? fsRoot : '' },
      stdio: ['ignore', log.fd, log.fd],
    });
  } finally {
    await log.close();
  }
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    if (server.exitCode !== null || server.signalCode !== null) throw Error('Synthetic API exited before readiness');
    const message = (await fs.readFile(logPath, 'utf8')).match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
    if (message) {
      base = message[1];
      if ((await http('GET', '/healthz')).v.ok) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('Synthetic API did not announce its loopback listener');
}
async function attach(a, headers) {
  await ok(
    'POST',
    '/host/agent-sessions/' + a.session_id + '/native-control',
    { protocol: 1, instance_id: a.native },
    { ...headers, 'x-agent-bridge-token': a.bridge_token },
  );
  const stream_id = randomUUID(),
    ws = new WS(base.replace('http:', 'ws:') + '/host/communicator/connect', {
      headers,
    });
  sockets.push(ws);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Error('session attachment timed out')), 7000);
    ws.once('error', reject);
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          type: 'hello',
          protocol: 1,
          username: 'fixture',
          version: 'operator-lab',
        }),
      ),
    );
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw);
      if (frame.type === 'ready')
        ws.send(
          JSON.stringify({
            type: 'state_open',
            protocol: 1,
            stream_id,
            scope: {
              topic: 'session',
              session_id: a.session_id,
              binding_generation: 1,
              native_instance_id: a.native,
            },
            auth: { bridge_token: a.bridge_token },
            payload: { authorization_refresh: 1 },
          }),
        );
      if (frame.type === 'state_snapshot' || frame.type === 'state_delta') {
        ws.send(
          JSON.stringify({
            type: 'state_ack',
            protocol: 1,
            stream_id: frame.stream_id,
            owner_epoch: frame.owner_epoch,
            revision: frame.revision,
          }),
        );
        clearTimeout(t);
        resolve();
      }
      if (frame.type === 'state_close') {
        clearTimeout(t);
        reject(Error('session attachment closed'));
      }
    });
  });
  return ws;
}
async function stop() {
  if (server && server.exitCode === null && server.signalCode === null) {
    const closed = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    await closed;
  }
  server = undefined;
}
try {
  db = await mysql.createConnection({ host: '127.0.0.1', port: dbPort, user: username, password: pass });
  await db.query('CREATE DATABASE ??', [schema]);
  created = true;
  await db.query('USE ??', [schema]);
  execFileSync(process.execPath, [...runtime, 'src/db/migrate-cli.ts', '--init-schema'], {
    cwd: api,
    env,
    stdio: 'pipe',
  });
  await start();
  const made = await http('POST', '/admin/setup/owner', {
    name: 'Operator fixture',
    username: 'fixture-owner',
    email: 'operator@fixture.invalid',
    password: randomBytes(24).toString('hex'),
  });
  assert(made.cookie);
  const admin = { Cookie: made.cookie, Origin: base };
  const defaults = await ok('GET', '/admin/model-defaults/codex', undefined, admin);
  await ok('POST', '/admin/model-defaults/codex', { model: defaults.catalog[0].model }, admin);
  const hosts = [];
  for (const suffix of ['alpha', 'beta']) {
    const { host } = await ok(
      'POST',
      '/admin/hosts/register',
      {
        fqdn: suffix + '.fixture.invalid',
        secure: true,
        vip: true,
        engines: ['codex'],
        reverse_dns_mode: 'disabled',
      },
      admin,
    );
    hostLabels.set(host.api_key, 'host ' + suffix);
    hosts.push({ id: host.id, 'x-api-key': host.api_key });
  }
  const h = { 'x-api-key': hosts[0]['x-api-key'] },
    other = { 'x-api-key': hosts[1]['x-api-key'] },
    op = { ...h, Authorization: 'Bearer ' + operator };
  const files = ['fs_read_file', 'fs_write_file', 'fs_search_in_files', 'fs_list_dir', 'fs_file_exists', 'fs_stat'];
  const tools = async (hd) => (await call(hd, 'tools/list')).tools.map((x) => x.name);
  assert.deepEqual((await tools(op)).filter((x) => x.startsWith('fs_')).sort(), files.sort());
  assert.deepEqual(
    (await tools(h)).filter((x) => x.startsWith('fs_')),
    [],
  );
  await refused(tool(h, 'fs_stat', { path: 'notes' }), 'host filesystem call');
  await refused(call({ Authorization: 'Bearer ' + operator }, 'tools/list'), 'operator missing host');
  done('operator bearer requires a host; host role cannot discover or call fs tools');
  const f = 'notes/acceptance.txt',
    content = 'synthetic operator note\nneedle check\n';
  assert.equal((await tool(op, 'fs_file_exists', { path: f })).exists, false);
  await tool(op, 'fs_write_file', { path: f, content });
  assert.equal(await fs.readFile(path.join(fsRoot, f), 'utf8'), content);
  assert.equal((await tool(op, 'fs_read_file', { path: f })).content, content);
  assert.equal((await tool(op, 'fs_file_exists', { path: f })).exists, true);
  const stat = await tool(op, 'fs_stat', { path: f });
  assert.equal(stat.size_bytes ?? stat.size, Buffer.byteLength(content));
  assert((await tool(op, 'fs_list_dir', { path: 'notes' })).entries.some((x) => x.name === 'acceptance.txt'));
  const hits = await tool(op, 'fs_search_in_files', {
    path: 'notes',
    pattern: 'needle',
    glob: 'notes/*.txt',
    max_hits: 4,
  });
  assert(JSON.stringify(hits).includes('needle'));
  await tool(op, 'fs_write_file', { path: f, content: 'replacement' });
  assert.equal(await fs.readFile(path.join(fsRoot, f), 'utf8'), 'replacement');
  done('all six fs tools exercised, replace/write verified on disk');
  const u = 'shared://review.operator-note',
    first = 'fixture resource',
    second = 'updated fixture resource';
  await tool(h, 'resource_create', { uri: u, text: first });
  assert.equal((await call(h, 'resources/read', { uri: u })).contents[0].text, first);
  assert(JSON.stringify(await call(h, 'resources/list')).includes(u));
  await refused(
    tool(h, 'resource_update', {
      uri: u,
      text: second,
      expected_sha256: digest('stale'),
    }),
    'resource stale digest',
  );
  await tool(h, 'resource_update', {
    uri: u,
    text: second,
    expected_sha256: digest(first),
  });
  assert.equal((await tool(other, 'resource_read', { uri: u })).contents[0].text, second);
  await tool(h, 'resource_delete', { uri: u });
  await assert.rejects(call(h, 'resources/read', { uri: u }));
  done('resource create/read/list/conditional update/delete through both MCP tool and resource methods');
  const project = 'operator-lab-project';
  await tool(h, 'project_create', {
    slug: project,
    about: { summary: 'Operator acceptance fixture' },
  });
  const projectUri = 'project://' + project + '/memory/roundtrip';
  await call(h, 'resources/create', { uri: projectUri, text: 'project alpha' });
  const projectRead = async () => JSON.stringify(await tool(h, 'resource_read', { uri: projectUri }));
  assert((await projectRead()).includes('project alpha'));
  await call(h, 'resources/update', { uri: projectUri, text: 'project beta' });
  assert((await projectRead()).includes('project beta'));
  await call(h, 'resources/delete', { uri: projectUri });
  const missingProjectMemory = await projectRead().catch(() => null);
  assert(!missingProjectMemory || !missingProjectMemory.includes('project beta'));
  await tool(h, 'project_archive', {
    slug: project,
    reason: 'Synthetic lifecycle complete',
  });
  done('project memory resource CRUD and archive of its synthetic project');
  const localUri = 'memory://operator-lab-key',
    localContents = async (hd) => JSON.parse((await call(hd, 'resources/read', { uri: localUri })).contents[0].text);
  await call(h, 'resources/create', { uri: localUri, text: 'alpha' });
  assert.equal((await localContents(h)).memory.content, 'alpha');
  assert.equal((await localContents(other)).status, 'missing');
  await call(other, 'resources/create', { uri: localUri, text: 'beta' });
  await call(h, 'resources/update', { uri: localUri, text: 'alpha changed' });
  assert.equal((await localContents(h)).memory.content, 'alpha changed');
  assert.equal((await localContents(other)).memory.content, 'beta');
  await call(other, 'resources/delete', { uri: localUri });
  assert.equal((await localContents(other)).status, 'missing');
  done('direct resources CRUD: identical URI, distinct host-local rows and deletion scope');
  await ok('POST', '/admin/agent-messaging/state', { enabled: true }, admin);
  await ok('POST', '/admin/git-director/state', { enabled: true }, admin);
  const principal = async (host, name, gitCommon) => {
    const session_id = randomUUID(),
      upstream = randomUUID(),
      bridge_token = randomBytes(32).toString('base64url'),
      native = randomUUID();
    bridgeLabels.set(bridge_token, 'native session ' + name);
    const cwd = path.join(store, 'synthetic-checkout-' + name),
      common = gitCommon ?? path.join(cwd, '.git'),
      head = 'a'.repeat(40);
    const workspace = {
      cwd,
      git_status: 'repository',
      git_root: cwd,
      git_common_dir: common,
      branch: 'fixture',
      head_sha: head,
      origin_url: 'https://example.invalid/review/operator-fixture.git',
    };
    const session = await ok(
      'POST',
      '/host/agent-sessions',
      {
        engine: 'codex',
        username: 'fixture',
        cwd,
        workspace,
        invocation_kind: 'interactive',
        session_id,
        bridge_token,
        upstream_session_id: upstream,
        adapter_capabilities: {
          native_control_version: 1,
          ...(name === 'c' ? { scope_protocol_version: 1 } : {}),
        },
      },
      host,
    );
    assert(session.enabled, JSON.stringify(Object.keys(session)));
    return {
      session_id,
      upstream,
      bridge_token,
      native,
      cwd,
      common,
      head,
      session,
      headers: {
        ...host,
        'x-agent-session-id': session_id,
        'x-agent-bridge-token': bridge_token,
      },
    };
  };
  const a = await principal(h, 'a');
  const address = a.session.agent_address;
  const addr = typeof address === 'string' ? address : (address?.address ?? 'agent:' + address?.id);
  assert.match(addr, /^agent:[a-f0-9-]{36}$/);
  const scheduled = await tool(h, 'schedule_create', {
    name: 'Synthetic operator fixture',
    target: addr,
    prompt: 'Never due during this lab',
    kind: 'interval',
    interval_minutes: 1440,
    enabled: false,
  });
  const s = scheduled.schedule ?? scheduled;
  assert(s.id);
  assert.equal(s.enabled, false);
  assert(JSON.stringify(await tool(other, 'schedule_list')).includes(s.id));
  const updated = await tool(other, 'schedule_update', {
    id: s.id,
    version: s.version,
    name: 'Updated synthetic fixture',
    enabled: true,
  });
  const s2 = updated.schedule ?? updated;
  assert(s2.version > s.version);
  await refused(tool(h, 'schedule_update', { id: s.id, version: s.version, name: 'Stale' }), 'schedule stale version');
  const got = await tool(h, 'schedule_get', { id: s.id });
  assert.equal((got.schedule ?? got).name, 'Updated synthetic fixture');
  await tool(h, 'schedule_delete', { id: s.id, version: s2.version });
  const [[stored]] = await db.execute('SELECT enabled, deleted_at, updated_by FROM agent_schedules WHERE id=?', [s.id]);
  assert(stored.deleted_at && stored.enabled === 0);
  done('schedule create/detail/list, cross-host update, stale-version rejection, SQL soft deletion and no firing');
  const register = {
    worktree_path: a.cwd,
    clone_dir: a.common,
    repo_root: a.cwd,
    remote_url: 'https://example.invalid/review/operator-fixture.git',
    branch: 'fixture',
    head_sha: a.head,
    username: 'fixture',
    engine: 'codex',
  };
  await refused(tool(a.headers, 'git_register', register), 'Git missing native proof');
  await refused(tool({ ...a.headers, ...other }, 'git_list', {}), 'native session bound to other host');
  done('git registration requires current native attachment');
  const wake = await tool(h, 'schedule_create', {
    name: 'Synthetic one-time wake',
    target: addr,
    prompt: 'Offer one synthetic work item',
    kind: 'once',
    at: new Date(Date.now() + 1400).toISOString(),
    persistent: false,
  });
  const wakeId = wake.schedule.id;
  async function waitRun(status) {
    for (let i = 0; i < 90; i++) {
      const [r] = await db.execute('SELECT id,status,message_id FROM agent_schedule_runs WHERE schedule_id=?', [
        wakeId,
      ]);
      if (r[0]?.status === status) {
        assert.equal(r.length, 1);
        return r[0];
      }
      await new Promise((ok) => setTimeout(ok, 125));
    }
    throw Error('schedule failed to reach ' + status);
  }
  const offline = await waitRun('waiting');
  assert.equal(offline.message_id, null);
  done('one-time due tick with a disconnected receiver: one durable waiting run, no message');
  const nativeSocket = await attach(a, h);
  const generation = randomUUID(),
    rx = await ok(
      'POST',
      '/host/agent-sessions/' + a.session_id + '/receiver/register',
      {
        generation,
        protocol: 'codex-queue-v1',
        native_session_id: a.upstream,
        capabilities: { queue_delivery_v1: true, delivery_timing_v1: true },
      },
      { ...h, 'x-agent-bridge-token': a.bridge_token },
    );
  assert(rx.sources.includes('peer'));
  const rstream = randomUUID();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('receiver state snapshot missing')), 6000);
    const fn = (raw) => {
      const frame = JSON.parse(raw);
      if (frame.stream_id !== rstream) return;
      if (frame.type === 'state_snapshot') {
        clearTimeout(timeout);
        resolve();
      }
      if (frame.type === 'state_close') {
        clearTimeout(timeout);
        reject(Error('receiver state closed'));
      }
    };
    nativeSocket.on('message', fn);
    nativeSocket.send(
      JSON.stringify({
        type: 'state_open',
        protocol: 1,
        stream_id: rstream,
        scope: {
          topic: 'receiver',
          receiver_generation: generation,
          session_id: a.session_id,
          binding_generation: 1,
        },
        auth: { bridge_token: a.bridge_token },
      }),
    );
  });
  const queued = await waitRun('queued');
  assert.equal(queued.id, offline.id);
  assert(queued.message_id);
  const currentWake = await tool(h, 'schedule_get', { id: wakeId });
  await tool(h, 'schedule_delete', {
    id: wakeId,
    version: currentWake.schedule.version,
  });
  const [[stopped]] = await db.execute('SELECT status FROM agent_bus_messages WHERE id=?', [queued.message_id]);
  assert.equal(stopped.status, 'canceled');
  done('receiver registration and WebSocket reconnect delivers the same run once; removal cancels unaccepted message');

  const registration = await tool(a.headers, 'git_register', register);
  assert.equal(registration.ownership_mode, 'connection');
  const repeated = await tool(a.headers, 'git_register', register);
  assert.equal(registration.worktree_id, repeated.worktree_id);
  await tool(a.headers, 'git_join', {
    worktree_path: a.cwd,
    task: 'Synthetic only',
    target_branch: 'main',
    paths: ['fixture.txt'],
  });
  const listed = await tool(a.headers, 'git_list', {
    worktree_path: a.cwd,
    scope: 'clone',
  });
  assert(JSON.stringify(listed).includes(a.cwd));
  const requestId = randomUUID();
  const params = {
    worktree_path: a.cwd,
    target_branch: 'main',
    client_request_id: requestId,
    base_sha: a.head,
    head_sha: a.head,
    changed_paths: ['fixture.txt'],
  };
  const grant = await tool(a.headers, 'git_merge_request', params);
  assert.equal(grant.verdict, 'allow');
  const replay = await tool(a.headers, 'git_merge_request', params);
  assert.equal(grant.request_id, replay.request_id);
  const current = await tool(a.headers, 'git_merge_status', {
    request_id: grant.request_id,
  });
  assert(current);
  const b = await principal(h, 'b', a.common);
  await attach(b, h);
  const rb = await tool(b.headers, 'git_register', {
    ...register,
    worktree_path: b.cwd,
    repo_root: b.cwd,
    branch: 'fixture-b',
  });
  assert.equal(rb.clone.clone_id, registration.clone.clone_id);
  await tool(b.headers, 'git_join', {
    worktree_path: b.cwd,
    task: 'Synthetic peer',
    target_branch: 'main',
    paths: ['other.txt'],
  });
  const breq = {
    ...params,
    worktree_path: b.cwd,
    client_request_id: randomUUID(),
    changed_paths: ['other.txt'],
  };
  const waiting = await tool(b.headers, 'git_merge_request', breq);
  assert.equal(waiting.verdict, 'wait');
  assert.equal((await tool(b.headers, 'git_merge_request', breq)).request_id, waiting.request_id);
  await tool(a.headers, 'git_release', {
    worktree_path: a.cwd,
    request_id: grant.request_id,
  });
  await tool(a.headers, 'git_release', {
    worktree_path: a.cwd,
    deregister: true,
  });
  const promoted = await tool(b.headers, 'git_merge_status', {
    request_id: waiting.request_id,
  });
  assert.equal(promoted.verdict, 'allow');
  await tool(b.headers, 'git_release', {
    worktree_path: b.cwd,
    request_id: waiting.request_id,
  });
  await tool(b.headers, 'git_release', {
    worktree_path: b.cwd,
    deregister: true,
  });
  const [[claims]] = await db.execute('SELECT COUNT(*) AS count FROM git_merge_requests WHERE clone_id = ?', [
    registration.clone.clone_id,
  ]);
  assert.equal(Number(claims.count), 2);
  done(
    'two distinct sessions on same synthetic clone: lease wait/replay, then promotion after release; SQL contains exactly two merge requests',
  );
  const [[wt]] = await db.execute('SELECT status FROM git_worktrees WHERE id=?', [registration.worktree_id]);
  assert.notEqual(wt.status, 'active');
  done('Git register and replay, join/list, merge-request replay/status/release/deregister, DB retirement');
  await ok('POST', '/admin/agent-messaging/scopes/state', { enabled: true }, admin);
  const c = await principal(h, 'c');
  await attach(c, h);
  const regC = await tool(c.headers, 'git_register', {
    ...register,
    clone_dir: c.common,
    worktree_path: c.cwd,
    repo_root: c.cwd,
  });
  const reqC = {
    ...params,
    client_request_id: randomUUID(),
    worktree_path: c.cwd,
  };
  await assert.rejects(tool(c.headers, 'git_merge_request', reqC), /claims before requesting/);
  const claimsPath = '/host/agent-sessions/' + c.session_id + '/agent-messaging/claims/',
    claimBody = {
      purpose: 'synthetic branch admission',
      client_request_id: randomUUID(),
      resources: [
        { kind: 'git', common_dir: c.common, branch: 'main' },
        { kind: 'path', path: c.cwd },
      ],
    };
  const claim = await ok('POST', claimsPath + 'acquire', claimBody, c.headers);
  assert.equal(claim.state, 'active');
  const sameClaim = await ok('POST', claimsPath + 'acquire', claimBody, c.headers);
  assert.equal(sameClaim.id, claim.id);
  const gated = await tool(c.headers, 'git_merge_request', reqC);
  assert.equal(gated.verdict, 'allow');
  await tool(c.headers, 'git_release', {
    worktree_path: c.cwd,
    request_id: gated.request_id,
  });
  await tool(c.headers, 'git_release', {
    worktree_path: c.cwd,
    deregister: true,
  });
  const released = await ok(
    'POST',
    claimsPath + 'release',
    {
      claim_id: claim.id,
      outcome: 'completed',
      reason: 'synthetic check complete',
    },
    c.headers,
  );
  assert.equal(released.state, 'released');
  done(
    'scope protocol v1 refuses unclaimed merge; matching path and branch claims are idempotently acquired and explicitly released',
  );
  for (const p of [a, b, c])
    await ok(
      'POST',
      '/host/agent-sessions/' + p.session_id + '/finish',
      { status: 'completed', summary: 'Synthetic lifecycle complete' },
      { ...h, 'x-agent-bridge-token': p.bridge_token },
    );
  for (const ws of sockets) ws.close();
  await stop();
  await start(false);
  assert.deepEqual(
    (await tools(op)).filter((x) => x.startsWith('fs_')),
    [],
  );
  await assert.rejects(tool(op, 'fs_stat', { path: f }));
  done('same database after API restart: unset MCP_FS_ROOT hides all filesystem tools');
  assert.equal((await localContents(h)).memory.content, 'alpha changed');
  assert.equal((await localContents(other)).status, 'missing');
  await call(h, 'resources/delete', { uri: localUri });
  assert.equal((await localContents(h)).status, 'missing');
  done('host-local resource survived owner restart; verified deletion');
  assert.equal(evidence.length, 14);
  assert.equal(pending.length, 0);
  const [[version]] = await db.query('SELECT VERSION() AS version');
  await fs.writeFile(
    path.join(lab, 'tools.tsv'),
    [['Tool', 'Identity', 'Verified scenario outcome', 'Source'], ...rows].map((row) => row.join('\t')).join('\n') +
      '\n',
  );
  await fs.writeFile(
    path.join(lab, 'environment.json'),
    JSON.stringify(
      {
        head: gitHead,
        apiTree,
        started,
        finished: new Date().toISOString(),
        node: process.version,
        mysql: version.version,
        scenarios: evidence.length,
        toolCalls: rows.length,
      },
      null,
      2,
    ) + '\n',
  );
  console.log('PASS', evidence.length, 'scenarios;', rows.length, 'verified tool invocations');
} catch (e) {
  console.error('FAIL after', step, e.stack?.split('\n').slice(0, 4).join('\n') ?? String(e));
  process.exitCode = 1;
} finally {
  try {
    for (const ws of sockets) ws.terminate();
    await stop();
  } finally {
    try {
      if (created) {
        await db.query('DROP DATABASE ??', [schema]);
        const [existing] = await db.query('SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME=?', [
          schema,
        ]);
        assert.equal(existing.length, 0);
      }
    } finally {
      await db?.end();
      await fs.rm(store, { recursive: true, force: true });
    }
  }
}
