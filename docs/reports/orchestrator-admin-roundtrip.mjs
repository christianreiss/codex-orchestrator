// Run from the checkout with the isolated MySQL test environment described in the companion report.
import { fork, execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import https from 'node:https';
import nodeHttp from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const entry = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(entry), '../..');
const api = path.join(root, 'api');
const requireApi = createRequire(path.join(api, 'package.json'));
if (process.argv[2] === '--listen') {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const remote = new URL(input instanceof Request ? input.url : input);
    if (remote.hostname !== '127.0.0.1') return Promise.reject(new Error('External version discovery is disabled in this lab'));
    return nativeFetch(input, init);
  };
  const { buildServer } = await import(pathToFileURL(path.join(api, 'src/server.ts')));
  const app = await buildServer();
  let closing;
  const shutdown = () => {
    closing ??= app.close().finally(() => {
      if (process.connected) process.disconnect();
    });
    return closing;
  };
  process.once('disconnect', shutdown);
  process.once('message', (m) => {
    if (m === 'shutdown') void shutdown();
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  process.send({ port: app.server.address().port });
} else {
  await run();
}

async function run() {
  const [outDir] = process.argv.slice(2);
  if (!outDir || !process.env.REVIEW_MYSQL_PORT || !process.env.REVIEW_MYSQL_PASSWORD) {
    throw Error('Supply an unused evidence directory and the loopback REVIEW_MYSQL_PORT and REVIEW_MYSQL_PASSWORD.');
  }
  const started = new Date().toISOString();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const out = path.resolve(outDir);
  await fs.mkdir(out, { mode: 0o700 });
  const trace = path.join(out, 'trace');
  await fs.mkdir(trace);
  const data = await fs.mkdtemp(path.join(out, 'private-'));
  const schema = 'review_admin_' + randomUUID().replaceAll('-', '');
  const db = await requireApi('mysql2/promise').createConnection({
    host: '127.0.0.1',
    port: Number(process.env.REVIEW_MYSQL_PORT),
    user: process.env.REVIEW_MYSQL_USER || 'root',
    password: process.env.REVIEW_MYSQL_PASSWORD,
  });
  const [[mysqlVersion]] = await db.query('SELECT VERSION() AS version');
  const env = {
    PATH: process.env.PATH,
    TZ: 'UTC',
    NODE_ENV: 'test',
    ENV_FILE: '/dev/null',
    DB_HOST: '127.0.0.1',
    DB_PORT: process.env.REVIEW_MYSQL_PORT,
    DB_USERNAME: process.env.REVIEW_MYSQL_USER || 'root',
    DB_PASSWORD: process.env.REVIEW_MYSQL_PASSWORD,
    DB_DATABASE: schema,
    DATA_ROOT: data,
    STATIC_ROOT: path.join(root, 'public/admin'),
    ENCRYPTION_ACTIVE_KEY: randomBytes(32).toString('base64'),
    PUBLIC_BASE_URL: 'http://127.0.0.1',
    CXX_COMMUNICATOR_ENABLED: '1',
    AUTH_RUNNER_URL: '',
    AUTH_RUNNER_SHARED_SECRET: '',
    RUN_MIGRATIONS_ON_BOOT: '1',
    MIGRATIONS_DIR: path.join(api, 'src/db/migrations'),
  };
  let child,
    relay,
    cert,
    backend,
    url,
    owner = '',
    group = '',
    identity = 'owner',
    registered = false;
  const rows = [],
    failures = [];
  const headRows = [],
    checkedHeads = new Set();
  // Only stable read models already asked for by a normal operator task. Installation tokens, downloads, exports,
  // activity/audit-triggering reads, stream subscriptions and call-through provider probes deliberately stay outside.
  const repeatableHeads = new Set([
    '/admin/hosts',
    '/admin/engine-state',
    '/admin/model-defaults/:engine',
    '/admin/settings/host-overrides',
    '/admin/hosts/:id/session-housekeeping',
    '/admin/roles',
    '/admin/roles/state',
    '/admin/roles/:slug',
    '/admin/roles/:slug/versions/:version',
    '/admin/roles/:slug/timeline',
    '/admin/skills',
    '/admin/skills/:slug',
    '/admin/projects',
    '/admin/projects/:slug',
    '/admin/projects/:slug/summary',
    '/admin/projects/:slug/notes',
    '/admin/projects/:slug/files',
    '/admin/projects/:slug/files/:id',
    '/admin/projects/:slug/feedback',
    '/admin/projects/feedback',
    '/admin/projects/:slug/changes',
    '/admin/projects/:slug/slop-jobs',
    '/admin/project-board/state',
    '/admin/agents',
    '/admin/agents/versions/:id',
    '/admin/agent-messaging/groups',
    '/admin/agent-messaging/groups/:slug',
    '/admin/workflow-definitions',
    '/admin/workflow-definitions/:id',
    '/admin/workflow-definitions/:id/versions',
    '/admin/workflow-definitions/:id/versions/:version',
    '/admin/workflow-runs',
    '/admin/workflow-runs/:id',
    '/admin/workflow-runs/:id/events',
    '/admin/workflow-runs/:id/report',
    '/admin/workflow-runs/:id/tasks/:taskId',
    '/admin/keys',
    '/admin/users',
    '/admin/companion/devices',
    '/admin/connectors/connections',
    '/admin/auth/status',
    '/admin/schedules',
    '/admin/watchdogs',
    '/admin/server-retention',
    '/admin/response-verbosity',
    '/admin/reverse-dns',
    '/admin/prune-policy',
    '/admin/quota-mode',
    '/admin/theme',
    '/admin/slop-jobs/state',
    '/admin/speech-input',
    '/admin/wrapper/rollout',
    '/admin/wrapper/rollout/enabled',
    '/admin/agent-messaging/state',
    '/admin/agent-messaging/scopes/state',
    '/admin/policy-profiles',
    '/admin/engine-accounts',
    '/admin/quota/status',
    '/admin/workflow-definitions/state',
  ]);
  let deletedMemoryNode;
  const routes = (await fs.readFile(path.join(root, 'docs/reports/orchestrator-entrypoints.tsv'), 'utf8'))
    .split('\n')
    .map((s) => s.split('\t'))
    .filter((r) => r[1] === 'HTTP')
    .map((r) => r[2].split(' '));
  const patternFor = (method, pathname) => {
    const segments = pathname.split('/');
    const candidates = routes.filter(
      ([m, p]) =>
        m === method && p.split('/').length === segments.length && p.split('/').every((v, i) => v === segments[i] || v.startsWith(':')),
    );
    return candidates.sort((a, b) => a[1].split(':').length - b[1].split(':').length)[0]?.[1];
  };
  async function http(method, route, body, evidence, predicate, opts = {}) {
    const target = new URL(route, url);
    if (target.origin !== url) throw Error('Fixture request is not loopback-local');
    const res = await new Promise((resolve, reject) => {
      const wire = https.request(
        target,
        {
          method,
          ca: cert,
          signal: AbortSignal.timeout(12000),
          headers: {
            accept: 'application/json',
            ...(owner ? { cookie: owner } : {}),
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(JSON.stringify(body)) }),
            ...opts.headers,
          },
        },
        (r) => {
          const chunks = [];
          r.on('error', reject);
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => {
            const headers = new Headers();
            for (let i = 0; i < r.rawHeaders.length; i += 2) headers.append(r.rawHeaders[i], r.rawHeaders[i + 1]);
            resolve(new Response(r.statusCode === 204 ? null : Buffer.concat(chunks), { status: r.statusCode, headers }));
          });
        },
      );
      wire.on('error', reject);
      wire.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const raw = await res.text();
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
    const value = json?.data ?? json;
    let ok = false;
    try {
      ok = (opts.status ? res.status === opts.status : res.ok) && !!predicate(value, res, raw);
    } catch {
      /* Shape did not satisfy this operation's contract. */
    }
    const pattern = patternFor(method, target.pathname);
    if (!pattern) throw Error('No matching inventory entry for ' + method + ' ' + target.pathname);
    if (!ok) {
      // Diagnostics are keys and scalar types only. Never print response bodies or credentials.
      const shape = Object.fromEntries(
        Object.entries(value ?? {})
          .slice(0, 28)
          .map(([k, v]) => [k, Array.isArray(v) ? 'array' : v && typeof v === 'object' ? Object.keys(v).slice(0, 10) : typeof v]),
      );
      throw Error(method + ' ' + pattern + ' ' + res.status + ' expected ' + evidence + '; keys ' + JSON.stringify(shape));
    }
    if (method === 'HEAD') {
      headRows.push([group, identity, method, pattern, res.status, evidence]);
    } else {
      rows.push([group, identity, method, pattern, res.status, evidence]);
      if (method === 'GET' && res.ok && repeatableHeads.has(pattern) && !checkedHeads.has(pattern)) {
        await http(
          'HEAD',
          route,
          undefined,
          'same status as the verified GET and zero response body bytes',
          (_v, _r, text) => Buffer.byteLength(text) === 0,
          { ...opts, status: res.status },
        );
        checkedHeads.add(pattern);
      }
    }
    return { v: value, cookie: res.headers.getSetCookie()?.[0]?.split(';')[0], raw };
  }
  const get = async (p, why, fn, o) => (await http('GET', p, undefined, why, fn, o)).v;
  const set = async (p, b, why, fn, m = 'POST', o) => (await http(m, p, b, why, fn, o)).v;
  const del = async (p, why, fn) => set(p, undefined, why, fn, 'DELETE');
  const has = (v, s) => JSON.stringify(v).includes(JSON.stringify(s));
  const ints = (v) => Number.isInteger(v) && v >= 0;
  const bool = (v) => typeof v === 'boolean';
  const list = (v, k) => Array.isArray(v[k]);
  const id = (v) => Number.isInteger(v) && v > 0;
  async function task(title, fn) {
    group = title;
    identity = 'owner';
    try {
      await fn();
    } catch (e) {
      failures.push(title + ': ' + e.message);
      console.error(failures.at(-1));
    }
  }
  try {
    const certPath = path.join(data, 'local.crt'),
      keyPath = path.join(data, 'local.key');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-keyout',
        keyPath,
        '-out',
        certPath,
      ],
      { stdio: 'ignore' },
    );
    cert = await fs.readFile(certPath);
    relay = https.createServer({ cert, key: await fs.readFile(keyPath) }, (request, response) => {
      const upstream = nodeHttp.request(
        { host: '127.0.0.1', port: backend, path: request.url, method: request.method, headers: request.headers },
        (r) => {
          response.writeHead(r.statusCode, r.headers);
          r.pipe(response);
        },
      );
      upstream.on('error', () => {
        response.writeHead(503);
        response.end();
      });
      request.pipe(upstream);
    });
    const listening = once(relay, 'listening');
    relay.listen(0, '127.0.0.1');
    await listening;
    url = 'https://127.0.0.1:' + relay.address().port;
    env.PUBLIC_BASE_URL = url;
    await db.query('CREATE DATABASE ??', [schema]);
    registered = true;
    execFileSync(process.execPath, ['dist/migrate.js', '--init-schema'], { cwd: api, env, stdio: 'pipe' });
    const log = await fs.open(path.join(data, 'private-process.log'), 'w', 0o600);
    try {
      if (process.env.REVIEW_FILE_TEST === '1') {
        const test = spawnSync(
          process.execPath,
          [
            'node_modules/vitest/vitest.mjs',
            'run',
            'test/integration/projects-client/admin-file-metadata.test.ts',
            'test/integration/projects-client/lean-reads.test.ts',
            '--no-file-parallelism',
          ],
          { cwd: api, env: { ...env, TEST_USE_DB: '1' }, encoding: 'utf8' },
        );
        await fs.writeFile(path.join(out, 'targeted-test.log'), test.stdout + test.stderr);
        if (test.status !== 0) throw Error('File metadata MySQL assertions failed; see targeted-test.log');
      }
      child = fork(entry, ['--listen'], {
        cwd: api,
        env: { ...env, ORCH_HTTP_TRACE_DIR: trace },
        execArgv: [
          '--enable-source-maps',
          '--require',
          path.join(root, 'docs/reports/orchestrator-http-trace.cjs'),
          '--import',
          path.join(api, 'node_modules/tsx/dist/loader.mjs'),
        ],
        stdio: ['ignore', log.fd, log.fd, 'ipc'],
      });
    } finally {
      await log.close();
    }
    const address = await Promise.race([
      once(child, 'message').then(([m]) => m.port),
      once(child, 'exit').then(() => {
        throw Error('API startup failed');
      }),
    ]);
    backend = address;
    group = 'Owner bootstrap and session';
    identity = 'anonymous';
    const setup = await http(
      'POST',
      '/admin/setup/owner',
      {
        name: 'Roundtrip owner',
        username: 'fixture-owner',
        email: 'owner@fixture.invalid',
        password: randomBytes(32).toString('base64url'),
      },
      'first owner established with a dashboard session',
      (v, r) => !!r.headers.get('set-cookie'),
    );
    owner = setup.cookie;
    identity = 'owner';
    let host, viewerId;
    const engines = ['codex', 'claude', 'grok', 'kimi'];
    await task('Host enrollment and fleet configuration', async () => {
      const m = await get('/admin/model-defaults/codex', 'model catalog contains selectable defaults', (v) =>
        v.catalog.some((k) => k.model),
      );
      await set('/admin/model-defaults/codex', { model: m.catalog[0].model }, 'persisted selected fleet model', (v) =>
        has(v, m.catalog[0].model),
      );
      const x = await set(
        '/admin/hosts/register',
        { fqdn: 'roundtrip.fixture.invalid', secure: true, vip: true, engines, reverse_dns_mode: 'disabled' },
        'registered named secure host with installer credential',
        (v) => id(v.host.id) && !!v.host.api_key,
      );
      host = x.host;
      await get('/admin/hosts', 'new enrollment visible in inventory', (v) => v.hosts.some((k) => k.id === host.id));
    });
    await task('Operator authorization and dashboard preferences', async () => {
      const pw = randomBytes(32).toString('base64url');
      const v = await set(
        '/admin/users',
        { name: 'Fixture reader', username: 'fixture-reader', access_level: 'viewer', email: 'reader@fixture.invalid', password: pw },
        'created viewer identity',
        (v) => v.user.username === 'fixture-reader',
      );
      viewerId = v.user.id;
      await set(
        '/admin/users/' + viewerId,
        { name: 'Renamed fixture reader' },
        'updated viewer display name',
        (v) => v.user.name === 'Renamed fixture reader',
      );
      await get('/admin/users', 'renamed viewer is listed', (v) =>
        v.users.some((u) => u.id === viewerId && u.name === 'Renamed fixture reader'),
      );
      const vw = await http(
        'POST',
        '/admin/auth/login',
        { username: 'fixture-reader', password: pw },
        'private viewer session cookie issued',
        (v, r) => !!r.headers.get('set-cookie'),
        { headers: { cookie: '' } },
      );
      const opts = { headers: { cookie: vw.cookie } };
      identity = 'viewer';
      await get('/admin/auth/status', 'current principal is the synthetic viewer', (v) => v.authenticated && v.user.id === viewerId, opts);
      await get('/admin/passkeys', 'new viewer has no passkeys', (v) => list(v, 'passkeys') && v.passkeys.length === 0, opts);
      await set(
        '/admin/theme',
        { theme: 'dark' },
        'viewer cannot change the fleet theme',
        (v) => v.required_capability === 'settings.manage',
        'POST',
        { ...opts, status: 403 },
      );
      await get('/admin/theme', 'viewer observes unchanged default theme', (v) => v.theme === 'auto', opts);
      await set('/admin/auth/logout', {}, 'viewer logged out with expired cookie', (_v, r) => !!r.headers.get('set-cookie'), 'POST', opts);
      await get('/admin/auth/status', 'logged-out viewer identity is no longer authenticated', (v) => v.authenticated === false, opts);
      identity = 'owner';
      await set('/admin/theme', { theme: 'dark' }, 'owner saved the fleet theme', (v) => v.theme === 'dark');
      await get('/admin/theme', 'fleet theme persisted', (v) => v.theme === 'dark');
      await del('/admin/users/' + viewerId, 'viewer removed', (v) => Object.keys(v).length === 0);
      await get('/admin/users', 'removed viewer absent from inventory', (v) => !v.users.some((u) => u.id === viewerId));
    });
    await task('Project identity and change history', async () => {
      await set('/admin/projects/state', { enabled: true }, 'project module enabled', (v) => v.enabled === true);
      await set(
        '/admin/projects',
        { slug: 'roundtrip', about: { summary: 'Before revision' } },
        'new project carries its summary',
        (v) => has(v, 'roundtrip') && has(v, 'Before revision'),
      );
      await set('/admin/projects/roundtrip/about', { about: { summary: 'Revised project mission' } }, 'project mission updated', (v) =>
        has(v, 'Revised project mission'),
      );
      await set(
        '/admin/projects/roundtrip/roster',
        { roster_markdown: 'Fixture roster' },
        'roster persisted',
        (v) => v.roster_markdown === 'Fixture roster',
      );
      await get(
        '/admin/projects/roundtrip',
        'detail includes revised mission and roster',
        (v) => has(v, 'Revised project mission') && has(v, 'Fixture roster'),
      );
      await get(
        '/admin/projects/roundtrip/summary',
        'summary includes selected project and revision',
        (v) => has(v, 'roundtrip') && has(v, 'Revised project mission'),
      );
      await get('/admin/projects/roundtrip/changes', 'creation and edits produced change history', (v) => v.changes.length >= 2);
    });
    const project = '/admin/projects/roundtrip';
    await task('Project files, notes and feedback', async () => {
      const note = await set(
        project + '/notes',
        { header: 'Review note', body: 'Initial body' },
        'note created with a persistent ID',
        (v) => id(v.note.id),
      );
      await set(
        project + '/notes/' + note.note.id,
        { header: 'Review note', body: 'Revised body' },
        'existing note body updated',
        (v) => v.note.body === 'Revised body',
      );
      await get(project + '/notes', 'updated note is visible to project members', (v) =>
        v.notes.some((n) => n.id === note.note.id && n.body === 'Revised body'),
      );
      const file = await set(
        project + '/files',
        { stored_name: 'evidence.txt', content: 'Roundtrip file body' },
        'file created with a persistent ID',
        (v) => id(v.file.id),
      );
      await get(project + '/files', 'admin listing returns the created file and its body', (v) =>
        v.files.some((f) => f.id === file.file.id && f.stored_name === 'evidence.txt' && f.content === 'Roundtrip file body'),
      );
      await get(project + '/files/' + file.file.id, 'editor reads exact file body', (v) => v.file.content === 'Roundtrip file body');
      const f = await set(
        project + '/feedback',
        { type: 'bug', title: 'Synthetic project report', body: 'Reproducible fixture' },
        'project feedback created',
        (v) => v.feedback.title === 'Synthetic project report',
      );
      await set(
        project + '/feedback/' + f.feedback.id,
        { title: 'Revised project report' },
        'project feedback edited',
        (v) => v.feedback.title === 'Revised project report',
      );
      await get(project + '/feedback', 'project report present under its project', (v) =>
        v.feedback.some((f) => f.title === 'Revised project report'),
      );
      await get('/admin/projects/feedback', 'fleet project-feedback view includes the same report', (v) =>
        v.feedback.some((f) => f.title === 'Revised project report'),
      );
      await del(project + '/files/' + file.file.id, 'removed only the synthetic file', (v) => v.deleted === file.file.id);
      await del(project + '/notes/' + note.note.id, 'removed only the synthetic note', (v) => v.deleted === note.note.id);
      await get(project + '/files', 'file disappeared after deletion', (v) => v.files.length === 0);
      await get(project + '/notes', 'note disappeared after deletion', (v) => v.notes.length === 0);
    });
    await task('Project document list and single-file preview', async () => {
      const sizes = [16384, 32768, 65536],
        filesURI = project + '/files',
        created = [];
      for (const [i, size] of sizes.entries()) {
        const bytes = Buffer.alloc(size, i === 1 ? Buffer.from([0, 255, 128, 129]) : 'a'),
          encoding = i === 1 ? 'base64' : 'utf8',
          name = ['z.txt', 'a.bin', 'n.txt'][i],
          body = bytes.toString(encoding);
        const v = await set(
          filesURI,
          { stored_name: name, content: body, encoding, mime_type: i === 1 ? 'application/octet-stream' : 'text/plain' },
          'stored ' + size + ' decoded bytes under ' + name,
          (o) => o.file.size_bytes === size && o.file.content === body,
        );
        created.push(v.file);
      }
      const full = await http(
        'GET',
        filesURI,
        undefined,
        'legacy response still returns the exact three payloads in filename order',
        (v) =>
          v.files.length === 3 &&
          v.files[0].stored_name === 'a.bin' &&
          v.files.every((f) => created.find((o) => f.id === o.id)?.content === f.content),
      );
      const metadata = await http(
        'GET',
        filesURI + '?projection=metadata',
        undefined,
        'document list preserves ordered metadata and omits each file body',
        (v) =>
          v.files.length === 3 &&
          v.files.every(
            (f, i) =>
              !Object.hasOwn(f, 'content') && Object.entries(full.v.files[i]).every(([k, value]) => k === 'content' || value === f[k]),
          ),
      );
      await fs.writeFile(
        path.join(out, 'payload.tsv'),
        'view\tfiles\tdecoded_file_bytes\tresponse_body_bytes\n' +
          [
            ['legacy', full],
            ['metadata', metadata],
          ]
            .map(([view, r]) => [view, created.length, sizes.reduce((a, b) => a + b), Buffer.byteLength(r.raw)].join('\t'))
            .join('\n') +
          '\n',
      );
      const emptySha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      const empty = (
        await set(
          filesURI,
          { stored_name: 'empty.bin', content: '    ', encoding: 'b64', mime_type: 'application/octet-stream' },
          'legacy whitespace-only binary is stored with canonical empty content',
          (v) => v.file.content === '' && v.file.size_bytes === 0 && v.file.content_sha256 === emptySha,
        )
      ).file;
      created.push(empty);
      await get(
        filesURI + '/' + empty.id,
        'legacy zero-byte binary reopens with explicit Base64 encoding and empty digest',
        (v) => v.file.content === '' && v.file.content_encoding === 'base64' && v.file.content_sha256 === emptySha,
      );
      await set(
        '/admin/projects/state',
        { enabled: true },
        'enabled the project MCP capability for enrolled hosts',
        (v) => v.enabled === true,
      );
      const checkHost = (tool, args, why, accept) =>
        http(
          'POST',
          '/mcp',
          { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: tool, arguments: args } },
          why,
          (v) => {
            return !v.error && !v.result.isError && accept(JSON.parse(v.result.content[0].text));
          },
          { headers: { cookie: '', 'x-api-key': host.api_key, 'x-engine': 'codex' } },
        );
      identity = 'synthetic host';
      await checkHost(
        'project_file_upsert',
        { slug: 'roundtrip', stored_name: 'empty.bin', description: 'Host empty file', content: '', encoding: 'BASE64' },
        'host MCP retained the canonical zero-byte binary SHA on a metadata update',
        (v) => v.file.id === empty.id && v.file.content_sha256 === emptySha && v.file.size_bytes === 0,
      );
      await checkHost(
        'project_file_read',
        { slug: 'roundtrip', id: empty.id },
        'host MCP read returned the empty Base64 body and zero bytes',
        (v) => v.file.content === '' && v.file.content_encoding === 'base64' && v.file.description === 'Host empty file',
      );
      identity = 'owner';
      for (const [invalid, why] of [
        [{ encoding: 'base64' }, 'missing binary body'],
        [{ content: 42, encoding: 'base64' }, 'non-string binary body'],
        [{ content: '', encoding: 'utf8' }, 'empty UTF-8 body'],
      ]) {
        await http(
          'POST',
          filesURI,
          { stored_name: 'empty.bin', ...invalid },
          why + ' is rejected while the stored file remains unchanged',
          (v, _r, raw) => raw.includes('content is required'),
          { status: 422 },
        );
      }
      await get(
        filesURI + '/' + empty.id,
        'rejected edits preserve the previous empty binary metadata',
        (v) => v.file.content_sha256 === emptySha && v.file.description === 'Host empty file',
      );
      if (process.env.REVIEW_BROWSER === '1') {
        const pw = createRequire(path.join(root, 'frontend/package.json'))('playwright');
        const { createHash, createPublicKey } = await import('node:crypto');
        const spki = createHash('sha256')
          .update(createPublicKey(cert).export({ format: 'der', type: 'spki' }))
          .digest('base64');
        const browser = await pw.chromium.launch({ args: ['--ignore-certificate-errors-spki-list=' + spki] });
        try {
          const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
          await context.route('**/*', (route) => (new URL(route.request().url()).origin === url ? route.continue() : route.abort()));
          const equals = owner.indexOf('=');
          await context.addCookies([
            { name: owner.slice(0, equals), value: owner.slice(equals + 1), url, secure: true, httpOnly: true, sameSite: 'Lax' },
          ]);
          const page = await context.newPage();
          page.setDefaultTimeout(15000);
          const waitForMetadata = page.waitForResponse(
            (r) =>
              new URL(r.url()).pathname === filesURI &&
              new URL(r.url()).searchParams.get('projection') === 'metadata' &&
              r.status() === 200,
          );
          await page.goto(url + project + '/documents');
          const listResponse = await waitForMetadata;
          if ((await listResponse.json()).data.files.some((f) => 'content' in f)) throw Error('Browser file list contains bodies');
          for (const file of [created[0], created[1], empty]) {
            const openFile = () => page.getByRole('button', { name: file.stored_name, exact: true }).click();
            if (file.content_encoding === 'base64' && file.size_bytes > 0) {
              await page.getByText('File saved', { exact: true }).waitFor({ state: 'hidden' });
              await page.setViewportSize({ width: 320, height: 720 });
              const held = Promise.withResolvers(),
                readUrl = url + filesURI + '/' + file.id;
              const delayed = async (route) => {
                await held.promise;
                await route.continue();
              };
              await page.route(readUrl, delayed, { times: 1 });
              try {
                await openFile();
                await page.getByRole('status').filter({ hasText: 'Loading file contents' }).waitFor();
                await page.getByLabel('Description', { exact: true }).focus();
                await page.waitForFunction(() => {
                  const box = document.querySelector('#file-content')?.getBoundingClientRect();
                  return box && box.left >= 0 && box.right <= window.innerWidth;
                });
                await page.evaluate(async () => {
                  const dialog = document.querySelector('#file-content')?.closest('[role=dialog]');
                  if (dialog) await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
                });
                await page.screenshot({ path: path.join(out, 'mobile-file-loading.png'), animations: 'disabled' });
              } finally {
                held.resolve();
              }
            } else await openFile();
            const editor = page.getByLabel(file.content_encoding === 'base64' ? 'Content (Base64)' : 'Content', { exact: true });
            await editor.waitFor();
            await page.waitForFunction(() => document.querySelector('#file-content')?.disabled === false);
            if ((await editor.inputValue()) !== file.content) throw Error('Editor did not show the selected body');
            const desc = 'Edited metadata ' + file.stored_name;
            await page.getByLabel('Description', { exact: true }).fill(desc);
            if (file.content_encoding === 'base64' && file.size_bytes > 0) {
              await editor.fill('invalid base64!');
              const badSave = page.waitForResponse((r) => new URL(r.url()).pathname === filesURI && r.request().method() === 'POST');
              await page.getByRole('button', { name: 'Save file', exact: true }).click();
              const rejected = await badSave;
              const validation = await rejected.text();
              if (rejected.status() < 400 || rejected.status() >= 500 || !validation.toLowerCase().includes('base64'))
                throw Error('Invalid Base64 was not rejected');
              await page
                .getByText(/not valid base64/i)
                .first()
                .waitFor();
              if (
                (await editor.inputValue()) !== 'invalid base64!' ||
                (await page.getByLabel('Description', { exact: true }).inputValue()) !== desc
              )
                throw Error('A rejected save discarded its draft');
              await get(
                filesURI + '/' + file.id,
                'invalid Base64 save preserves previously committed bytes and metadata',
                (v) => v.file.description !== desc && v.file.content === file.content && v.file.content_sha256 === file.content_sha256,
              );
              rows.push([
                group,
                'owner via Chromium',
                'POST',
                '/admin/projects/:slug/files',
                rejected.status(),
                'invalid Base64 save exposes validation feedback and keeps both edited fields in the open draft',
              ]);
              await page.getByText('File saved', { exact: true }).waitFor({ state: 'hidden' });
              await page.screenshot({ path: path.join(out, 'mobile-file-error.png') });
              await editor.fill(file.content);
            }
            const save = page.waitForResponse((r) => new URL(r.url()).pathname === filesURI && r.request().method() === 'POST');
            await page.getByRole('button', { name: 'Save file', exact: true }).click();
            const response = await save,
              submitted = response.request().postDataJSON();
            if (response.status() !== 200 || submitted.encoding !== file.content_encoding || submitted.content !== file.content)
              throw Error('Browser save changed the selected encoding or contents');
            const saved = await get(
              filesURI + '/' + file.id,
              'browser edited ' +
                file.size_bytes +
                '-byte ' +
                file.content_encoding +
                ' description while preserving original contents, digest and size',
              (v) =>
                v.file.description === desc &&
                v.file.content === file.content &&
                v.file.size_bytes === file.size_bytes &&
                v.file.content_sha256 === file.content_sha256,
            );
            const [stored] = await db.query('SELECT content, content_encoding, content_sha256 FROM ??.coord_project_files WHERE id=?', [
              schema,
              file.id,
            ]);
            const storedBytes = Buffer.from(stored[0].content, stored[0].content_encoding);
            if (
              !storedBytes.equals(Buffer.from(file.content, file.content_encoding)) ||
              createHash('sha256').update(storedBytes).digest('hex') !== saved.file.content_sha256
            )
              throw Error('Stored bytes differ from the selected original');
            rows.push([
              group,
              'owner via Chromium',
              'POST',
              '/admin/projects/:slug/files',
              response.status(),
              'description-only save preserves ' +
                file.size_bytes +
                ' decoded bytes for ' +
                file.content_encoding +
                ' in MySQL and the returned SHA-256',
            ]);
            await page.getByRole('button', { name: 'Save file', exact: true }).waitFor({ state: 'hidden' });
          }
          await fs.writeFile(path.join(out, 'browser.txt'), browser.version() + '\n');
        } finally {
          await browser.close();
        }
      }
      for (const file of created) {
        await get(
          filesURI + '/' + file.id,
          'editor fetched the selected ' + file.stored_name + ' body and original SHA-256',
          (v) => v.file.content === file.content && v.file.content_sha256 === file.content_sha256,
        );
        await del(filesURI + '/' + file.id, 'removed the measured ' + file.stored_name + ' fixture', (v) => v.deleted === file.id);
      }
      await get(filesURI + '?projection=metadata', 'deleted documents disappear from the metadata projection', (v) => v.files.length === 0);
    });
    await task('Project board', async () => {
      await set('/admin/project-board/state', { enabled: true }, 'board feature enabled', (v) => v.enabled === true);
      await get('/admin/project-board/state', 'board remains enabled', (v) => v.enabled === true);
      const c = await set(
        project + '/board/cards',
        { title: 'Inspect fixture card', labels: ['review'] },
        'board card created',
        (v) => v.card.title === 'Inspect fixture card',
      );
      const base = project + '/board/cards/' + c.card.id;
      await set(base, { detail: 'Documented change' }, 'board card description updated', (v) => v.card.detail === 'Documented change');
      await set(
        base + '/move',
        { column: 'planning' },
        'board card moved into planning',
        (v) => v.to_column.key === 'planning' && v.from_column.key === 'backlog',
      );
      await get(project + '/board', 'board contains the moved card', (v) => has(v, 'Inspect fixture card') && has(v, 'planning'));
      await del(base, 'board card removed', (v) => v.deleted === Number(c.card.number) || v.deleted === Number(c.card.id));
      await get(project + '/board', 'board no longer contains the card', (v) => !has(v, 'Inspect fixture card'));
    });
    await task('Fleet policy profiles and host override', async () => {
      const profiles = await get(
        '/admin/agent-policy-profiles',
        'fleet security profile catalog includes presets',
        (v) => list(v, 'profiles') && v.profiles.length > 0,
      );
      const original = profiles.profiles.find((p) => p.is_default) ?? profiles.profiles[0];
      const created = await set(
        '/admin/agent-policy-profiles',
        { name: 'Synthetic fixture posture', description: 'Local review fixture', levels: original.levels },
        'custom editable policy created',
        (v) => id(v.profile.id) && v.profile.name === 'Synthetic fixture posture',
      );
      const pid = created.profile.id;
      await set(
        '/admin/agent-policy-profiles/' + pid,
        { name: 'Revised fixture posture' },
        'custom profile name updated',
        (v) => v.profile.name === 'Revised fixture posture',
      );
      await set(
        '/admin/agent-policy-profiles/assign',
        { host_id: host.id, profile_id: pid },
        'assigned profile to synthetic host',
        (v) => v.host_id === host.id && v.profile_id === pid,
      );
      await get(
        '/admin/agent-policy-profiles/enforcement?host_id=' + host.id,
        'host effective levels match selected profile',
        (v) => v.host_id === host.id && Object.entries(original.levels).every(([k, n]) => v.levels[k] === n),
      );
      await set(
        '/admin/agent-policy-profiles/assign',
        { host_id: host.id, profile_id: null },
        'cleared host-specific assignment',
        (v) => v.profile_id === null,
      );
      await del('/admin/agent-policy-profiles/' + pid, 'removed unassigned local profile', (v) => v.deleted_id === pid);
    });
    await task('Skills and Claude-native library', async () => {
      const slug = 'roundtrip-fixture',
        manifest = '---\nname: roundtrip-fixture\ndescription: Fixture manifest\n---\n\nLocal roundtrip';
      await set('/admin/skills/store', { slug, manifest }, 'persisted named skill manifest', (v) => has(v, slug));
      await get('/admin/skills/' + slug, 'skill editor reads its exact manifest', (v) => has(v, manifest));
      await get('/admin/skills', 'skill library contains new skill', (v) => v.skills.some((s) => s.slug === slug));
      await del('/admin/skills/' + slug, 'synthetic skill removed', (v) => v.deleted === slug);
      await get('/admin/skills', 'admin library retains the tombstone for a deleted skill', (v) =>
        v.skills.some((s) => s.slug === slug && !!s.deleted_at),
      );
      const base = '/admin/claude/commands';
      await set(
        base + '/store',
        { slug, description: 'Fixture command', body: 'Produce the fixture observation.' },
        'Claude slash-command stored under its own kind',
        (v) => has(v, slug),
      );
      await get(
        base + '/' + slug,
        'native command editor reads stored body',
        (v) => v.body.includes('Produce the fixture observation.') && v.frontmatter.description === 'Fixture command',
      );
      await get(base, 'native command inventory includes created slug', (v) => v.artifacts.some((a) => a.slug === slug));
      await del(base + '/' + slug, 'native command deleted', (v) => v.deleted === slug);
    });
    await task('Engine switches and account preservation', async () => {
      const active = await get('/admin/engines/active', 'fleet returns active engine list', (v) => list(v, 'engines'));
      await get('/admin/accounts', 'new fleet has no configured provider accounts', (v) => list(v, 'accounts') && v.accounts.length === 0);
      await get('/admin/engines/grok/destroy', 'new Grok engine has no pending destruction', (v) => v.engine === 'grok');
      await set('/admin/engines/grok/state', { enabled: false }, 'Grok master switch suspended', (v) => v.enabled === false);
      await get(
        '/admin/engines/active',
        'Grok marked inactive while Codex remains active',
        (v) => v.engines.some((e) => e.engine === 'grok' && !e.enabled) && v.engines.some((e) => e.engine === 'codex' && e.enabled),
      );
      await set('/admin/engines/grok/state', { enabled: true }, 'Grok master switch resumed', (v) => v.enabled === true);
      await get(
        '/admin/engines/active',
        'resumed Grok present alongside Codex',
        (v) => v.engines.some((e) => e.engine === 'codex' && e.enabled) && v.engines.some((e) => e.engine === 'grok' && e.enabled),
      );
      await get('/admin/accounts', 'empty account list preserved across suspension', (v) => v.accounts.length === 0);
    });
    await task('Host rules and session health', async () => {
      const extra = '/admin/hosts/' + host.id + '/agents-extra';
      await set(
        extra,
        { content: 'Synthetic host-only instruction' },
        'host-specific agent rules saved',
        (v) => v.content === 'Synthetic host-only instruction',
        'PUT',
      );
      await get(extra, 'saved rules read back for same host', (v) => v.content === 'Synthetic host-only instruction');
      await get('/admin/agents/render?engine=codex&host_id=' + host.id, 'rendered policy includes the host rule', (v) =>
        JSON.stringify(v).includes('Synthetic host-only instruction'),
      );
      await set(extra, { content: '' }, 'host-specific agent override removed', (v) => !v.content, 'PUT');
      await get(
        '/admin/hosts/' + host.id + '/session-housekeeping',
        'selected idle host reports Codex, Claude, Grok and Kimi housekeeping policies and no run',
        (v) => engines.every((e) => e in v.policies) && v.last_run === null,
      );
    });
    await task('Shared memory record, audit and optimistic updates', async () => {
      const base = '/admin/memories/shared',
        key = 'roundtrip.shared';
      const first = (
        await set(
          base,
          { id: key, content: 'First shared revision' },
          'created named shared memory',
          (v) => v.memory.id === key && v.memory.content === 'First shared revision',
        )
      ).memory;
      deletedMemoryNode = first.node_id;
      const uri = base + '/' + first.record_id;
      const second = (
        await set(
          uri,
          { expected_etag: first.etag, content: 'Second shared revision' },
          'committed replacement with original etag',
          (v) => v.memory.content === 'Second shared revision' && v.memory.etag !== first.etag,
          'PATCH',
        )
      ).memory;
      await get(
        uri,
        'selected memory detail contains revised body',
        (v) => v.memory.etag === second.etag && v.memory.content === 'Second shared revision',
      );
      await get('/admin/memories/graph', 'memory graph includes the selected record', (v) =>
        v.nodes.some((n) => n.node_id === first.node_id || n.id === first.node_id),
      );
      const appended = (
        await set(
          uri + '/append',
          { content: 'Appendix' },
          'append preserves previous body and adds the supplied text',
          (v) => v.memory.content.includes('Second shared revision') && v.memory.content.includes('Appendix'),
        )
      ).memory;
      await get(
        '/admin/memories/audit?node_id=' + encodeURIComponent(first.node_id),
        'write audit belongs to this node and contains multiple changes',
        (v) => v.node_id === first.node_id && v.activities.length >= 2,
      );
      await set(
        uri,
        { expected_etag: appended.etag },
        'deleted selected memory with current etag',
        (v) => v.status === 'deleted' && v.node_id === first.node_id,
        'DELETE',
      );
    });
    await task('Versioned agent instructions', async () => {
      const content = 'Use a synthetic observation for this fixture.';
      const created = await set('/admin/agents/store', { content }, 'stored versioned fleet instructions', (v) => id(v.version_id));
      const revision = created.version_id;
      await get('/admin/agents/versions/' + revision, 'selected historical instruction matches stored content', (v) => has(v, content));
      await set(
        '/admin/agents/serve',
        { mode: 'locked', version_id: revision },
        'locked serving to selected revision',
        (v) => v.mode === 'locked' && v.served_id === revision,
      );
      await get('/admin/agents', 'currently served version remains locked', (v) => v.mode === 'locked' && v.served_id === revision);
      await set('/admin/agents/serve', { mode: 'latest' }, 'returned fleet serving to latest', (v) => v.mode === 'latest');
    });
    await task('Role publication history', async () => {
      const base = '/admin/roles',
        slug = 'roundtrip-role';
      await set(base + '/state', { enabled: true }, 'role management enabled', (v) => v.enabled === true);
      const created = await set(
        base,
        { slug, display_name: 'Fixture reader', summary: 'Observe this fixture' },
        'created custom role',
        (v) => v.role.slug === slug,
      );
      const uri = base + '/' + slug;
      const updated = await set(
        uri,
        { display_name: 'Revised fixture reader', expected_version: created.role.version },
        'role label changed with matching version',
        (v) => v.role.display_name === 'Revised fixture reader',
        'PATCH',
      );
      await get(
        uri,
        'role detail reflects revised name and version',
        (v) => v.role.display_name === 'Revised fixture reader' && v.role.version === updated.role.version,
      );
      const draft =
        '---\nname: roundtrip-role\ndescription: Observe this fixture\n---\nRead the synthetic fixture and report your observation.';
      await set(
        uri + '/draft',
        { manifest: draft, files: [], changelog: 'Initial release' },
        'saved operator draft for this role',
        (v) => v.draft?.manifest === draft,
        'PUT',
      );
      const released = await set(
        uri + '/publish',
        { changelog: 'Initial release' },
        'published draft obtained a release identity',
        (v) => !!v.role.current_version_id,
      );
      const history = await get(
        uri + '/timeline',
        'role timeline contains its published version',
        (v) => v.role === slug && v.versions.length === 1,
      );
      await get(
        uri + '/versions/' + history.versions[0].version,
        'specific released role version has original manifest',
        (v) => v.manifest === draft,
      );
    });
    await task('Native companion pairing and revocation', async () => {
      const pairing = await set(
        '/admin/companion/pairings',
        {},
        'owner issued a one-time QR pairing for this instance',
        (v) => JSON.parse(v.qr).version === 1 && !!v.device_id && !!v.expires_at,
      );
      identity = 'unpaired device';
      const qr = JSON.parse(pairing.qr);
      const device = await set(
        '/companion/v1/pair',
        { token: qr.token, name: 'Review handset' },
        'synthetic handset exchanged pairing for its bearer identity',
        (v) => v.device_id === pairing.device_id && typeof v.token === 'string',
        'POST',
        { headers: { cookie: '' } },
      );
      const opts = { headers: { cookie: '', authorization: 'Bearer ' + device.token } };
      identity = 'paired device';
      await get(
        '/companion/v1/me',
        'companion reports bound device and its read-sync protocol',
        (v) => v.device_id === device.device_id && v.read_sync_protocol === 1,
        opts,
      );
      identity = 'owner';
      await get('/admin/companion/devices', 'operator can see its paired handset', (v) =>
        v.devices.some((d) => d.id === device.device_id && d.name === 'Review handset'),
      );
      await del('/admin/companion/devices/' + device.device_id, 'operator revoked selected device', (v) => v.revoked === true);
      identity = 'revoked device';
      await get('/companion/v1/me', 'revoked bearer no longer authenticates', (_v, r) => r.status === 401, { ...opts, status: 401 });
    });
    await task('Fleet preferences roundtrip', async () => {
      await set('/admin/response-verbosity', { level: 3 }, 'owner selected response verbosity three', (v) => v.level === 3);
      await get('/admin/response-verbosity', 'saved response verbosity is effective', (v) => v.level === 3);
      await set('/admin/cdx-silent', { silent: true }, 'owner enabled Codex silent mode', (v) => v.silent === true);
      await get('/admin/cdx-silent', 'silent setting persisted', (v) => v.silent === true);
      await set(
        '/admin/prune-policy',
        { inactivity_days: 41 },
        'saved supported 41-day host inactivity window',
        (v) => v.inactivity_window_days === 41,
      );
      await get('/admin/prune-policy', 'read back host inactivity window in days', (v) => v.inactivity_window_days === 41);
      const forms = await get('/admin/address-form', 'address form belongs to server-supplied choices', (v) =>
        v.forms.some((o) => o.form === v.form),
      );
      const next = forms.forms.find((o) => o.form !== forms.form)?.form;
      await set('/admin/address-form', { form: next }, 'selected alternate supported address form', (v) => v.form === next);
      await get('/admin/address-form', 'address form change persisted', (v) => v.form === next);
    });
    // Independent dashboard panels each have a product-specific data contract. No routes are invoked from the route inventory.
    const readPanels = [
      [
        'Authentication and devices',
        '/admin/authorization',
        'effective authorization mode',
        (v) => ['compatible', 'strict'].includes(v.mode),
      ],
      [
        'Authentication and devices',
        '/admin/companion/devices',
        'revoked local handset remains visible in device history',
        (v) => v.push_configured === false && v.devices.some((d) => d.name === 'Review handset' && typeof d.revoked_at === 'string'),
      ],
      [
        'Authentication and devices',
        '/admin/connectors/connections',
        'no OAuth consent grants created',
        (v) => list(v, 'connections') && v.connections.length === 0,
      ],
      [
        'Authentication and devices',
        '/admin/external-clients',
        'no external client added',
        (v) => list(v, 'clients') && v.clients.length === 0,
      ],
      [
        'Host policy',
        '/admin/host-spawn/state',
        'host-spawn setting exposes its VIP requirement',
        (v) => bool(v.enabled) && v.vip_required === true,
      ],
      [
        'Host policy',
        '/admin/hosts/insecure',
        'insecure-host operations include fleet window and approval status',
        (v) => list(v, 'hosts') || typeof v.fleet_window === 'object',
      ],
      ['Host policy', '/admin/insecure-approval', 'operator approval policy is a boolean', (v) => bool(v.enabled)],
      [
        'Host policy',
        '/admin/prune-policy',
        'host inactivity retention is within the supported range',
        (v) => ints(v.inactivity_window_days) && v.inactivity_window_days <= 60,
      ],
      ['Host policy', '/admin/reverse-dns', 'reverse DNS validation preference is boolean', (v) => bool(v.enabled)],
      ['Host policy', '/admin/settings/host-overrides', 'host override inventory reports counts', (v) => Object.values(v).some(ints)],
      [
        'Host policy',
        '/admin/wrapper/rollout/enabled',
        'wrapper rollout switch and its source',
        (v) => bool(v.enabled) && typeof v.source === 'string',
      ],
      [
        'Host policy',
        '/admin/wrapper/rollout',
        'rollout dashboard exposes its enabled state',
        (v) => bool(v.enabled) || bool(v.settings?.enabled),
      ],
      [
        'Host policy',
        '/admin/communicators',
        'no synthetic host communicator was connected',
        (v) => v.connections.length === 0 && v.protocol === 1,
      ],
      ['Settings', '/admin/api/state', 'API serving requests is enabled', (v) => v.disabled === false],
      ['Settings', '/admin/cdx-silent', 'Codex silent-mode setting has a boolean value', (v) => bool(v.silent)],
      ['Settings', '/admin/address-form', 'configured address form exists in offered forms', (v) => v.forms.some((o) => o.form === v.form)],
      [
        'Settings',
        '/admin/response-verbosity',
        'response verbosity choices include the current setting',
        (v) => v.levels?.some((o) => o.level === v.level) || v.options?.includes(v.level),
      ],
      ['Settings', '/admin/speech-input', 'speech-input settings cover all supported engines', (v) => engines.every((e) => e in v.engines)],
      [
        'Settings',
        '/admin/agent-chat/limits',
        'chat upload limit is positive',
        (v) => Object.values(v).some((x) => Number.isInteger(x) && x > 0),
      ],
      [
        'Retention',
        '/admin/server-retention',
        'retention dashboard exposes configured retention policies',
        (v) => list(v, 'policies') || list(v, 'tables') || typeof v.policy === 'object',
      ],
      ['Operations', '/admin/git-director/state', 'Git Director switch is boolean', (v) => bool(v.enabled)],
      ['Operations', '/admin/git-director', 'no clones registered', (v) => list(v, 'clones') && v.clones.length === 0],
      ['Operations', '/admin/agent-messaging/state', 'message bus exposes enabled state', (v) => bool(v.enabled)],
      [
        'Operations',
        '/admin/agent-messaging/addresses',
        'no fixture registered a bus address',
        (v) => list(v, 'addresses') && v.addresses.length === 0,
      ],
      [
        'Operations',
        '/admin/agent-messaging/conversations',
        'no conversations exist',
        (v) => list(v, 'conversations') && v.conversations.length === 0,
      ],
      [
        'Operations',
        '/admin/agent-messaging/messages',
        'no delivery or execution messages exist',
        (v) => list(v, 'messages') && v.messages.length === 0,
      ],
      ['Operations', '/admin/agent-messaging/scopes/state', 'scope coordination setting is boolean', (v) => bool(v.enabled)],
      [
        'Operations',
        '/admin/agent-messaging/scopes',
        'scope inventory contains rooms and claims',
        (v) => list(v, 'rooms') && list(v, 'claims'),
      ],
      ['Operations', '/admin/roles/state', 'roles feature switch is boolean', (v) => bool(v.enabled)],
      ['Operations', '/admin/roles', 'roles view exposes named role entries', (v) => list(v, 'roles') && bool(v.enabled)],
      ['Operations', '/admin/schedules', 'no wake schedules were configured', (v) => list(v, 'schedules') && v.schedules.length === 0],
      ['Operations', '/admin/watchdogs', 'no watchdogs were configured', (v) => list(v, 'watchdogs') && v.watchdogs.length === 0],
      [
        'Operations',
        '/admin/agent-supervisor',
        'supervisor mode and its policies are represented',
        (v) => bool(v.enabled) || Array.isArray(v.policies),
      ],
      ['Operations', '/admin/workflow-definitions/state', 'workflow feature switch is boolean', (v) => bool(v.enabled)],
      ['Operations', '/admin/workflow-definitions', 'no workflow definitions created', (v) => list(v, 'items') && v.items.length === 0],
      ['Operations', '/admin/workflow-runs', 'no workflow dispatched', (v) => list(v, 'items') && v.items.length === 0],
      ['Operations', '/admin/slop-jobs/state', 'diagnostic job feature switch is boolean', (v) => bool(v.enabled)],
      [
        'Operations',
        '/admin/feedback/configuration',
        'fresh feedback configuration has no runner or token',
        (v) => v.runner_enabled === false && v.token_configured === false,
      ],
      ['Operations', '/admin/feedback/summary', 'fleet feedback summary has numeric counters', (v) => Object.values(v).some(ints)],
      [
        'Operations',
        '/admin/feedback',
        'project feedback is isolated from fleet feedback',
        (v) => list(v, 'feedback') && v.feedback.length === 0,
      ],
      [
        'Operations',
        '/admin/memories/graph',
        'graph drops the removed shared memory',
        (v) =>
          list(v, 'nodes') &&
          list(v, 'edges') &&
          typeof deletedMemoryNode === 'string' &&
          !v.nodes.some((n) => n.id === deletedMemoryNode || n.node_id === deletedMemoryNode),
      ],
      [
        'Operations',
        '/admin/setup/wizard',
        'creating an owner left wizard completion and dismissal unset',
        (v) => v.completed_at === null && v.dismissed_at === null,
      ],
      [
        'Chat workspace',
        '/admin/chatty/status',
        'provider-neutral Chatty readiness is explicit',
        (v) => bool(v.enabled) || list(v, 'engines'),
      ],
      [
        'Chat workspace',
        '/admin/chatty/session',
        'no previous assistant messages for test owner',
        (v) => list(v, 'events') && v.events.length === 0 && v.active === null,
      ],
      ['Chat workspace', '/admin/chatty/settings', 'operator Chatty configuration exposes its switch', (v) => bool(v.enabled)],
    ];
    for (const [panel, route, why, test] of readPanels) await task(panel, () => get(route, why, test));
    await task('Fleet dashboard and project diagnostics', async () => {
      await get('/admin/overview', 'dashboard counts the enrolled synthetic host', (v) => v.totals.hosts === 1);
      await get(
        '/admin/agent-messaging',
        'messaging directory has no active agents in this isolated fleet',
        (v) => (Array.isArray(v.agents) && v.agents.length === 0) || (Array.isArray(v.addresses) && v.addresses.length === 0),
      );
      await get(
        project + '/slop-jobs',
        'newly created project lists no static or advisor jobs',
        (v) => v.project === 'roundtrip' && v.jobs.length === 0 && v.idle_hours > 0,
      );
    });
    await task('Named messaging group', async () => {
      const base = '/admin/agent-messaging/groups',
        slug = 'roundtrip-members';
      await set(
        '/admin/agent-messaging/state',
        { enabled: true },
        'messaging is enabled for this synthetic fleet',
        (v) => v.enabled === true,
      );
      const created = await set(
        base,
        { slug, title: 'Roundtrip members', description: 'Local group' },
        'created a uniquely named empty group',
        (v) => v.group.slug === slug && v.group.member_count === 0 && v.created === true,
      );
      await get(
        base + '/' + slug,
        'selected group has the expected ID and no subscribers',
        (v) => v.group.id === created.group.id && v.members.length === 0,
      );
      await get(base, 'named group appears in the group browser', (v) => v.groups.some((g) => g.id === created.group.id));
      await del(base + '/' + slug, 'group deletion confirms the same slug', (v) => v.deleted === true && v.slug === slug);
      await get(base, 'removed group no longer appears', (v) => !v.groups.some((g) => g.id === created.group.id));
    });
    await task('Workflow definition, revision and prepared run', async () => {
      const definitions = '/admin/workflow-definitions',
        runs = '/admin/workflow-runs';
      const doc = {
        schema_version: 1,
        title: 'Roundtrip scenario',
        summary: 'Fixture observation',
        goal: { statement: 'Collect fixture', success_criteria: [{ id: 'fixture', text: 'Fixture exists' }] },
        inputs: [],
        tasks: [
          {
            id: 'fixture',
            title: 'Inspect fixture',
            instructions: 'Inspect fixture',
            acceptance_criteria: ['Fixture observed'],
            depends_on: [],
            knowledge_ids: [],
          },
        ],
        knowledge: [],
      };
      await set(
        definitions + '/state',
        { enabled: true, client_request_id: randomUUID() },
        'workflow module enabled',
        (v) => v.enabled === true,
      );
      const created = await set(
        definitions,
        { client_request_id: randomUUID(), slug: 'roundtrip-workflow', reason: 'Fixture was created', document: doc },
        'definition stores the selected task and a SHA',
        (v) => v.version === 1 && v.document.tasks[0].id === 'fixture' && typeof v.sha256 === 'string',
      );
      const uri = definitions + '/' + created.workflow_id;
      await get(
        uri,
        'selected definition contains the created workflow',
        (v) => v.workflow_id === created.workflow_id && v.document.title === doc.title,
      );
      const revised = await set(
        uri + '/revise',
        {
          client_request_id: randomUUID(),
          expected_workflow_version: 1,
          reason: 'Clarify scope',
          document: { ...doc, summary: 'Revised fixture' },
        },
        'revision creates version two with changed summary',
        (v) => v.version === 2 && v.document.summary === 'Revised fixture',
      );
      await get(uri + '/versions', 'version history contains original and revised SHA', (v) =>
        [revised.sha256, created.sha256].every((sha) => v.items.some((i) => i.sha256 === sha)),
      );
      await get(
        uri + '/versions/1',
        'historical version retains its original summary',
        (v) => v.version === 1 && v.document.summary === doc.summary,
      );
      const prepared = await set(
        runs,
        { client_request_id: randomUUID(), workflow_id: created.workflow_id, version: 'latest', title: 'Observe roundtrip', inputs: {} },
        'prepared run is pinned to workflow revision two',
        (v) => typeof v.run_id === 'string' && v.workflow_version === 2,
      );
      const run = runs + '/' + prepared.run_id;
      await get(run, 'prepared run can be reopened by ID', (v) => v.run_id === prepared.run_id && v.workflow_id === created.workflow_id);
      await get(run + '/events', 'prepared run has its own event history', (v) => Array.isArray(v.items) && v.items.length > 0);
      await get(
        run + '/tasks/fixture',
        'prepared task holds the original instructions',
        (v) => v.task.id === 'fixture' || v.task.task_id === 'fixture',
      );
      await get(
        run + '/report',
        'run report points to the same workflow version',
        (v) => v.run_id === prepared.run_id && v.workflow_version === 2,
      );
      await set(
        run + '/prepare-cancel',
        { client_request_id: randomUUID(), expected_run_version: prepared.version, reason: 'Local fixture completed' },
        'prepared run lifecycle ends explicitly',
        (v) => v.run_id === prepared.run_id && v.version > prepared.version,
      );
    });
    group = 'Project fixture cleanup';
    identity = 'owner';
    await del(project, 'only the named synthetic project removed', (v) => v.deleted === 'roundtrip');
  } finally {
    if (child?.connected) {
      const stopped = once(child, 'exit');
      child.send('shutdown');
      await stopped;
    }
    if (relay?.listening) {
      const closed = once(relay, 'close');
      relay.close();
      relay.closeAllConnections();
      await closed;
    }
    if (registered) {
      await db.query('DROP DATABASE ??', [schema]);
      const [remaining] = await db.query('SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME=?', [schema]);
      if (remaining.length) throw Error('The synthetic schema was not cleaned');
    }
    await db.end();
    await fs.rm(data, { recursive: true, force: true });
  }
  const spa = JSON.parse(await fs.readFile(path.join(root, 'public/admin/_app/version.json'), 'utf8'));
  await fs.writeFile(
    path.join(out, 'environment.json'),
    JSON.stringify(
      {
        started,
        finished: new Date().toISOString(),
        head,
        node: process.version,
        mysql: mysqlVersion.version,
        spa: spa.version,
        schemaRemoved: true,
      },
      null,
      2,
    ) + '\n',
  );
  headRows.sort((a, b) => a[3].localeCompare(b[3]));
  await fs.writeFile(
    path.join(out, 'head.tsv'),
    [['Workflow', 'Identity', 'Method', 'Registered pattern', 'HTTP status', 'Verified protocol outcome'], ...headRows]
      .map((r) => r.join('\t'))
      .join('\n') + '\n',
  );
  rows.sort((a, b) => a[3].localeCompare(b[3]) || a[2].localeCompare(b[2]) || a[5].localeCompare(b[5]));
  await fs.writeFile(
    path.join(out, 'result.tsv'),
    [['Workflow', 'Identity', 'Method', 'Registered pattern', 'HTTP status', 'Verified business outcome'], ...rows]
      .map((r) => r.join('\t'))
      .join('\n') + '\n',
  );
  console.log(
    rows.length +
      ' verified observations; ' +
      new Set(rows.map((r) => r[2] + ' ' + r[3])).size +
      ' methods and patterns; ' +
      failures.length +
      ' failed assertions',
  );
  if (failures.length) process.exitCode = 1;
}
