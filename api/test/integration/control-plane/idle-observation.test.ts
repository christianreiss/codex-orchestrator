import { Session as InspectorSession } from 'node:inspector';
import { randomUUID } from 'node:crypto';
import { createServer as createPortReservation } from 'node:net';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import type { Browser, BrowserContext } from 'playwright';
import { AdminAuthService } from '../../../src/services/admin-auth.js';
import { AdminUsersService } from '../../../src/services/admin-users.js';
import { AdminEventsService } from '../../../src/services/admin-events.js';
import { describe, it, expect, vi } from 'vitest';
import { buildServer } from '../../../src/server.js';
import { loadBaseline } from '../../../src/db/migrator.js';
import { resetEnvCache } from '../../../src/env.js';
import { HostManagementService } from '../../../src/services/host-management.js';
import { makeAdminEventsWriter } from '../../../src/services/admin-events-writer.js';
import { requestHost } from '../../../src/control-plane/state/admission.js';
import { SettingsService } from '../../../src/services/settings.js';
import { registerOwnedMessagingSession } from '../../../src/control-plane/state/session-registration.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { installSqlBudget } from '../../helpers/sql-budget.js';

// Opt-in wall-clock observation. Real HTTP server and TCP WebSocket transports;
// communicator clients are simulated. OWNER_IDLE_TABS adds real Chromium tabs.
const seconds = Number(process.env.OWNER_IDLE_SECONDS ?? 0);
const count = Number(process.env.OWNER_IDLE_COMMUNICATORS ?? 1);
const tabs = Number(process.env.OWNER_IDLE_TABS ?? 0);
const delegateLiveness = process.env.OWNER_IDLE_DELEGATE_LIVENESS === '1';
describe.skipIf(!seconds || process.env.TEST_USE_DB !== '1' || !process.env.TEST_DATABASE_URL)(
  'full-server idle observation',
  () => {
    it(
      'keeps connected native sessions without persistent heartbeat traffic',
      async () => {
        if (
          !Number.isInteger(seconds) ||
          seconds < 1 ||
          seconds > 3600 ||
          ![1, 20, 200].includes(count) ||
          ![0, 1, 5].includes(tabs)
        )
          throw new Error('Invalid observation bounds');
        const sourceManifest = process.env.OWNER_IDLE_SOURCE_MANIFEST
          ? (JSON.parse(await readFile(process.env.OWNER_IDLE_SOURCE_MANIFEST, 'utf8')) as unknown)
          : null;
        const url = new URL(process.env.TEST_DATABASE_URL!);
        const database = `idle_${randomUUID().replaceAll('-', '')}`;
        const control = await mysql.createConnection({
          host: url.hostname,
          port: Number(url.port || 3306),
          user: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
        });
        const root = await mkdtemp(join(tmpdir(), 'owner-idle-'));
        const sockets: Array<{
          send(data: string): void;
          terminate(): void;
          readyState: number;
          on(event: string, listener: (data: Buffer) => void): void;
        }> = [];
        const timers: Array<ReturnType<typeof setInterval>> = [];
        let app: Awaited<ReturnType<typeof buildServer>> | undefined;
        let restore: (() => void) | undefined;
        let browser: Browser | undefined;
        let browserContext: BrowserContext | undefined;
        let measuring = false;
        let profiler: InspectorSession | undefined;
        const profilePost = (method: string, params: object = {}) =>
          new Promise<unknown>((resolve, reject) =>
            profiler!.post(method, params, (error, result) => (error ? reject(error) : resolve(result))),
          );
        const communicatorFrames: Record<string, number> = {};
        const browserFrames: Record<string, number> = {};
        const business = (counts: Record<string, number>) =>
          Object.fromEntries(
            Object.entries(counts).filter(
              ([type]) => !['ping', 'pong', 'state_ping', 'state_pong'].includes(type),
            ),
          );
        const browserRequests: string[] = [];
        const browserErrors: string[] = [];
        const reconnectRequests: string[] = [];
        let reconnecting = false,
          browserHellos = 0;
        let reconnect: { visible: boolean; newHelloFrames: number; requests: string[] } | null = null;
        async function mysqlCpu(): Promise<number | null> {
          if (!process.env.OWNER_IDLE_MYSQL_CPU_FILE) return null;
          const match = /^usage_usec (\d+)$/m.exec(
            await readFile(process.env.OWNER_IDLE_MYSQL_CPU_FILE, 'utf8'),
          );
          if (!match) throw new Error('MySQL cgroup usage_usec missing');
          return Number(match[1]);
        }
        const failures: string[] = [];
        const progress = (stage: string) =>
          process.stderr.write(`[idle-observation] ${new Date().toISOString()} ${database} ${stage}\n`);
        try {
          await control.query(`CREATE DATABASE \`${database}\``);
          await control.query(`USE \`${database}\``);
          for (const sql of await loadBaseline()) await control.query(sql);
          progress('baseline loaded');
          testKeyring();
          const reservation = createPortReservation();
          await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
          const reserved = reservation.address();
          if (!reserved || typeof reserved === 'string') throw new Error('No local fixture port');
          const port = reserved.port;
          await new Promise<void>((resolve, reject) =>
            reservation.close((error) => (error ? reject(error) : resolve())),
          );
          if (process.env.OWNER_IDLE_BRIDGE_TTL)
            vi.stubEnv('AGENT_PORTAL_BRIDGE_TTL_SECONDS', process.env.OWNER_IDLE_BRIDGE_TTL);
          for (const [key, value] of Object.entries({
            DB_HOST: url.hostname,
            DB_PORT: url.port || '3306',
            DB_USERNAME: decodeURIComponent(url.username),
            DB_PASSWORD: decodeURIComponent(url.password),
            DB_DATABASE: database,
            DATA_ROOT: root,
            AUTH_RUNNER_URL: '',
            AUTH_RUNNER_SHARED_SECRET: '',
            PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
            RUN_MIGRATIONS_ON_BOOT: '1',
            MIGRATIONS_DIR: join(process.cwd(), 'src/db/migrations'),
            CXX_COMMUNICATOR_ENABLED: '1',
            ADMIN_WS_ENABLED: '1',
            LOG_LEVEL: 'silent',
          }))
            vi.stubEnv(key, value);
          resetEnvCache();
          const pools = vi.spyOn(mysql, 'createPool');
          let observedPool: mysql.Pool;
          try {
            app = await buildServer();
            observedPool = pools.mock.results.at(-1)!.value;
          } finally {
            pools.mockRestore();
          }
          progress('server built');
          await app.listen({ host: '127.0.0.1', port });
          const address = app.server.address();
          if (!address || typeof address === 'string') throw new Error('Listener absent');
          const hosts = new HostManagementService({
            db: app.db,
            keyring: app.keyring,
            env: app.env,
            events: makeAdminEventsWriter(app.db),
          });
          const settings = new SettingsService(app.db);
          await settings.set('agent_messaging_enabled', '1');
          const runtime = app.controlPlane.runtime;
          const WebSocket = createRequire(import.meta.url)('ws');
          for (let n = 0; n < count; n++) {
            if (n % 20 === 0) progress(`attaching communicator ${n + 1}/${count}`);
            const engine = (['codex', 'claude', 'grok'] as const)[n % 3]!;
            const registered = await hosts.register({
              fqdn: `idle-${n}.fixture.test`,
              secure: true,
              engines: ['codex', 'claude', 'grok'],
              reverse_dns_mode: 'disabled',
            });
            const host = requestHost(
              runtime.state.snapshot().hosts.get(registered.host.id)!,
              registered.apiKeyPlain,
            );
            const attachments: Array<{ sessionId: string; bridgeToken: string; streamId: string }> = [];
            // A single communicator still exercises all engines. Larger cohorts
            // distribute one native identity per host across the three engines.
            for (const sessionEngine of count === 1 ? (['codex', 'claude', 'grok'] as const) : [engine]) {
              const sessionId = randomUUID(),
                bridgeToken = randomUUID() + randomUUID();
              await registerOwnedMessagingSession(
                runtime,
                host,
                {
                  sessionId,
                  bridgeToken,
                  engine: sessionEngine,
                  username: 'fixture',
                  cwd: '/fixture',
                  invocationKind: 'interactive',
                  upstreamSessionId: randomUUID(),
                  adapterProtocol: 'fixture-v1',
                  adapterCapabilities: {
                    launch_identity_version: 1,
                    control_state_protocol: 1,
                    execution_contract_version: 2,
                  },
                },
                app.env,
              );
              attachments.push({ sessionId, bridgeToken, streamId: randomUUID() });
            }
            const socket = new WebSocket(`ws://127.0.0.1:${address.port}/host/communicator/connect`, {
              headers: { 'x-api-key': registered.apiKeyPlain },
            });
            sockets.push(socket);
            const pending = new Set(attachments.map((item) => item.streamId));
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error('State attachment timed out')), 15000);
              socket.on('error', (error: Error) => {
                clearTimeout(timeout);
                reject(error);
              });
              socket.on('close', () => {
                if (pending.size) {
                  clearTimeout(timeout);
                  reject(new Error(`Communicator ${n} closed before attachment`));
                }
              });
              socket.on('open', () =>
                socket.send(
                  JSON.stringify({
                    type: 'hello',
                    protocol: 1,
                    username: 'fixture',
                    version: 'idle-fixture',
                  }),
                ),
              );
              socket.on('message', (raw: Buffer) => {
                const frame = JSON.parse(raw.toString());
                if (measuring) communicatorFrames[frame.type] = (communicatorFrames[frame.type] ?? 0) + 1;
                if (frame.type === 'ready' && delegateLiveness)
                  socket.send(
                    JSON.stringify({
                      type: 'capabilities',
                      terminate: false,
                      pid: process.pid,
                      started_at: new Date().toISOString(),
                      state_liveness: 'communicator',
                    }),
                  );
                if (
                  (frame.type === 'ready' && !delegateLiveness) ||
                  (frame.type === 'state_liveness_ready' && delegateLiveness)
                )
                  for (const item of attachments)
                    socket.send(
                      JSON.stringify({
                        type: 'state_open',
                        protocol: 1,
                        stream_id: item.streamId,
                        scope: { topic: 'session', session_id: item.sessionId, binding_generation: 1 },
                        auth: { bridge_token: item.bridgeToken },
                      }),
                    );
                if (frame.type === 'state_snapshot' || frame.type === 'state_delta') {
                  socket.send(
                    JSON.stringify({
                      type: 'state_ack',
                      protocol: 1,
                      stream_id: frame.stream_id,
                      owner_epoch: frame.owner_epoch,
                      revision: frame.revision,
                    }),
                  );
                  pending.delete(frame.stream_id);
                  if (!pending.size) {
                    clearTimeout(timeout);
                    resolve();
                  }
                }
                if (frame.type === 'state_ping')
                  socket.send(JSON.stringify({ ...frame, type: 'state_pong' }));
                if (frame.type === 'state_close') {
                  failures.push(frame.code ?? 'state_closed');
                  clearTimeout(timeout);
                  reject(new Error(frame.code ?? 'state_closed'));
                }
              });
            });
            socket.on('close', () => failures.push('communicator_closed'));
            timers.push(setInterval(() => socket.send(JSON.stringify({ type: 'ping' })), 15000));
          }
          const budget = installSqlBudget(observedPool);
          budget.track(app.controlPlane.ownership.heldConnection());
          restore = () => budget.restore();
          budget.reset();
          if (tabs) {
            const auth = new AdminAuthService(app.db, app.env);
            await new AdminUsersService(app.db, auth, new AdminEventsService(app.db)).create({
              name: 'Idle observer',
              username: 'idle-observer',
              email: 'idle@example.invalid',
              password: 'test-password-idle-123',
              access_level: 'owner',
            });
            const session = await auth.login('idle-observer', 'test-password-idle-123', null, null);
            const playwright = await import('playwright');
            browser = await playwright.chromium.launch({
              headless: true,
              args: ['--no-sandbox'],
              executablePath: process.env.OWNER_IDLE_CHROMIUM,
            });
            browserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            await browserContext.addInitScript(() => {
              const state = globalThis as typeof globalThis & { __ownerTestSockets: WebSocket[] };
              state.__ownerTestSockets = [];
              const Original = globalThis.WebSocket;
              globalThis.WebSocket = class extends Original {
                constructor(url: string | URL, protocols?: string | string[]) {
                  super(url, protocols);
                  state.__ownerTestSockets.push(this);
                }
              };
            });
            const origin = `http://127.0.0.1:${address.port}`;
            await browserContext.addCookies([
              {
                name: app.env.ADMIN_SESSION_COOKIE,
                value: session.token,
                url: origin,
                httpOnly: true,
                sameSite: 'Lax',
              },
            ]);
            const paths = [
              '/admin/dashboard',
              '/admin/hosts',
              '/admin/agents',
              '/admin/schedules',
              '/admin/accounts',
            ];
            for (const path of paths.slice(0, tabs)) {
              const page = await browserContext.newPage();
              page.on('request', (request) => {
                if (['fetch', 'xhr'].includes(request.resourceType())) {
                  const route = `${request.method()} ${new URL(request.url()).pathname}`;
                  if (measuring) browserRequests.push(route);
                  if (reconnecting) reconnectRequests.push(route);
                }
              });
              page.on('response', (response) => {
                if (response.status() >= 400 && ['fetch', 'xhr'].includes(response.request().resourceType()))
                  browserErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
              });
              page.on('pageerror', (error) => browserErrors.push(error.message));
              const hello = new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(
                  () => reject(new Error(`Admin WebSocket hello absent for ${path}`)),
                  30000,
                );
                page.on('websocket', (socket) => {
                  socket.on('framereceived', (frame) => {
                    try {
                      const type = JSON.parse(String(frame.payload)).type;
                      if (measuring) browserFrames[type] = (browserFrames[type] ?? 0) + 1;
                      if (type === 'hello') {
                        browserHellos++;
                        clearTimeout(timeout);
                        resolve();
                      }
                    } catch {
                      /* non-JSON transport frame */
                    }
                  });
                  socket.on('close', () => {
                    if (measuring) browserErrors.push(`WebSocket closed: ${path}`);
                  });
                  socket.on('socketerror', () => {
                    if (!reconnecting) browserErrors.push(`WebSocket error: ${path}`);
                  });
                });
              });
              await page.goto(origin + path, { waitUntil: 'networkidle' });
              await hello;
              await page.locator('h1').first().waitFor({ state: 'visible' });
              expect(new URL(page.url()).pathname).toBe(path);
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 3000));
          progress('quiet window started');
          const hydrationSql = budget.snapshot();
          budget.reset();
          measuring = true;
          if (process.env.OWNER_IDLE_CPU_PROFILE) {
            profiler = new InspectorSession();
            profiler.connect();
            await profilePost('Profiler.enable');
            await profilePost('Profiler.setSamplingInterval', { interval: 10000 });
            await profilePost('Profiler.start');
          }
          const mysqlBefore = await mysqlCpu(),
            cpu = process.cpuUsage(),
            start = performance.now();
          const cpuBuckets: Array<{ seconds: number; cpuPercent: number; sqlStatements: number }> = [];
          let previousCpu = cpu,
            previousWall = start,
            previousSql = 0;
          const cpuBucket = () => {
            const wall = performance.now(),
              current = process.cpuUsage(),
              delta = process.cpuUsage(previousCpu),
              statements = budget.snapshot().length;
            cpuBuckets.push({
              seconds: (wall - previousWall) / 1000,
              cpuPercent: (delta.user + delta.system) / ((wall - previousWall) * 10),
              sqlStatements: statements - previousSql,
            });
            previousCpu = current;
            previousWall = wall;
            previousSql = statements;
          };
          const cpuTimer = setInterval(cpuBucket, 60000);
          timers.push(cpuTimer);
          await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
          progress('quiet window ended');
          const elapsedMs = performance.now() - start,
            used = process.cpuUsage(cpu),
            sql = budget.snapshot();
          measuring = false;
          clearInterval(cpuTimer);
          if (performance.now() - previousWall > 1000) cpuBucket();
          const mysqlAfter = await mysqlCpu();
          if (profiler) {
            const profile = (await profilePost('Profiler.stop')) as { profile: unknown };
            await writeFile(process.env.OWNER_IDLE_CPU_PROFILE!, JSON.stringify(profile.profile));
            profiler.disconnect();
            profiler = undefined;
          }
          if (browserContext) {
            reconnecting = true;
            const page = browserContext.pages()[tabs === 5 ? 1 : 0]!;
            if (tabs === 1)
              await page.goto(`http://127.0.0.1:${address.port}/admin/hosts`, { waitUntil: 'networkidle' });
            const before = browserHellos;
            await browserContext.setOffline(true);
            for (const tab of browserContext.pages())
              await tab.evaluate(() => {
                for (const socket of (globalThis as typeof globalThis & { __ownerTestSockets: WebSocket[] })
                  .__ownerTestSockets)
                  socket.close(4000, 'acceptance reconnect');
              });
            await hosts.register({
              fqdn: 'after-reconnect.fixture.test',
              secure: true,
              engines: ['codex', 'claude', 'grok'],
              reverse_dns_mode: 'disabled',
            });
            await browserContext.setOffline(false);
            await page
              .getByText('after-reconnect.fixture.test', { exact: true })
              .first()
              .waitFor({ state: 'visible', timeout: 30000 });
            await vi.waitFor(() => expect(browserHellos).toBeGreaterThan(before), { timeout: 30000 });
            reconnect = {
              visible: true,
              newHelloFrames: browserHellos - before,
              requests: reconnectRequests,
            };
          }
          const result = {
            seconds: elapsedMs / 1000,
            communicators: count,
            nativeSessions: count === 1 ? 3 : count,
            engines: ['codex', 'claude', 'grok'],
            browserTabs: tabs,
            delegateLiveness,
            bridgeTtlSeconds: app.env.AGENT_PORTAL_BRIDGE_TTL_SECONDS,
            browserRequests,
            browserErrors,
            communicatorFrames,
            browserFrames,
            businessFrames: { communicator: business(communicatorFrames), browser: business(browserFrames) },
            memoryBytes: process.memoryUsage(),
            hydrationSql,
            providerAccounts: runtime.state.snapshot().table('providerAccounts').all().length,
            protocolClients: 'simulated TCP clients',
            sql,
            failures,
            processCpuPercent: (used.user + used.system) / (elapsedMs * 10),
            cpuBuckets,
            profilerEnabled: !!process.env.OWNER_IDLE_CPU_PROFILE,
            cpuScope: 'Node server plus simulated clients; optional Inspector sampling overhead included',
            mysqlCpuPercent:
              mysqlBefore !== null && mysqlAfter !== null
                ? (mysqlAfter - mysqlBefore) / (elapsedMs * 10)
                : null,
            mysqlCpuExclusive: process.env.OWNER_IDLE_MYSQL_EXCLUSIVE === '1',
            mysqlCpuScope:
              mysqlBefore === null
                ? 'not measured'
                : process.env.OWNER_IDLE_MYSQL_EXCLUSIVE === '1'
                  ? 'total isolated MySQL cgroup including baseline and sampler overhead'
                  : 'shared MySQL cgroup; concurrency not excluded, diagnostic only',
            reconnect,
            source: 'isolated worktree; sourceManifest records prelaunch content when supplied',
            sourceManifest,
          };
          if (process.env.OWNER_IDLE_RESULT)
            await writeFile(process.env.OWNER_IDLE_RESULT, JSON.stringify(result, null, 2));
          expect(failures).toEqual([]);
          expect(business(communicatorFrames)).toEqual({});
          expect(business(browserFrames)).toEqual({});
          expect(browserErrors).toEqual([]);
          expect(browserRequests).toEqual([]);
          expect(sql).toEqual([]);
        } catch (error) {
          progress(`failed: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        } finally {
          progress('cleanup started');
          measuring = false;
          profiler?.disconnect();
          await browserContext?.close();
          await browser?.close();
          restore?.();
          for (const timer of timers) clearInterval(timer);
          for (const socket of sockets) socket.terminate();
          await app?.close();
          vi.unstubAllEnvs();
          resetEnvCache();
          await control.query(`DROP DATABASE IF EXISTS \`${database}\``);
          await control.end();
          await rm(root, { recursive: true, force: true });
          progress('cleanup finished');
        }
      },
      (seconds + 600) * 1000,
    );
  },
);
