import cookie from '@fastify/cookie';
import fp from 'fastify-plugin';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { get, type ClientRequest, type IncomingMessage } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminContext } from '../../../src/http/plugins/auth-admin.js';
import { makeCapabilitiesPlugin } from '../../../src/http/plugins/capabilities.js';
import { UnauthorizedError } from '../../../src/http/errors.js';
import { registerAdminAgentSessionsRoutes } from '../../../src/routes/admin/agent-sessions/index.js';
import { registerAgentPortalPublicRoutes } from '../../../src/routes/agent-portal/public.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { AdminAuthService } from '../../../src/services/admin-auth.js';
import { AgentPortalService } from '../../../src/services/agent-portal.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const apps: FastifyInstance[] = [];
const clients: ClientRequest[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

async function fixture() {
  let admin: AdminContext | null = {
    user: { id: 1, active: 1, accessLevel: 'owner', username: 'operator' },
    session: { id: 1 },
  } as AdminContext;
  const auth = vi.spyOn(AdminAuthService.prototype, 'resolveSession').mockImplementation(async () => admin);
  vi.spyOn(AgentPortalService.prototype, 'isEnabled').mockResolvedValue(true);
  vi.spyOn(AgentPortalService.prototype, 'latestEventCursor').mockResolvedValue(0);
  const read = vi.spyOn(AgentPortalService.prototype, 'listEventsAfter').mockImplementation(async (after = 0) => ({
    events: [{ cursor: after + 1, session_id: SESSION_ID, type: 'progress', payload: { text: `page-${after + 1}` } }],
    next_cursor: after + 1,
  }));
  const app = Fastify({ logger: false });
  let responseRaw: FastifyReply['raw'] | undefined;
  let closing = false;
  app.addHook('onRequest', async (_req, reply) => { responseRaw = reply.raw; });
  app.addHook('preClose', async () => { closing = true; });
  apps.push(app);
  await app.register(cookie);
  await app.register(fp(async (authApp) => {
    authApp.decorate('resolveAdmin', async () => admin);
    authApp.decorate('requireAdmin', async (req) => {
      if (!admin) throw new UnauthorizedError('Admin required', 'admin_required');
      req.admin = admin;
    });
  }, { name: 'auth-admin' }));
  await app.register(makeCapabilitiesPlugin({ service: null }));
  const ctx = {
    db: {} as RouteContext['db'],
    env: { ...loadTestEnv(), PUBLIC_BASE_URL: 'https://portal.example', STATIC_ROOT: resolve(import.meta.dirname, '../../../../public/admin') },
    keyring: testKeyring(),
  };
  await registerAdminAgentSessionsRoutes(app, ctx);
  await registerAgentPortalPublicRoutes(app, ctx);
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, origin, read, auth, response: () => responseRaw!, isClosing: () => closing, setAdmin: (value: AdminContext | null) => { admin = value; }, demote: () => {
    admin = { ...admin!, user: { ...admin!.user, accessLevel: 'viewer' } };
  } };
}

async function open(url: string, headers: Record<string, string> = {}): Promise<{ response: IncomingMessage; body: () => string; client: ClientRequest }> {
  return await new Promise((resolveOpen, reject) => {
    const client = get(url, { headers: { cookie: 'codex_admin_session=synthetic-test-session', ...headers } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      resolveOpen({ response, body: () => body, client });
    });
    clients.push(client);
    client.on('error', reject);
  });
}

describe.each(['/admin/agent-sessions/events', '/go/api/events'])('real HTTP stream %s', (path) => {
  it('flushes headers, stays connected after request completion, and stops reading on disconnect', async () => {
    const f = await fixture();
    const stream = await open(`${f.origin}${path}?after=0`);
    expect(stream.response.statusCode).toBe(200);
    expect(stream.response.headers['content-type']).toContain('text/event-stream');
    await vi.waitFor(() => expect(stream.body()).toContain('page-2'), { timeout: 3000 });
    expect(stream.response.complete).toBe(false);
    stream.client.destroy();
    await delay(30);
    const reads = f.read.mock.calls.length;
    await delay(1100);
    expect(f.read).toHaveBeenCalledTimes(reads);
  });

  it('closes an open stream during server shutdown within one second', async () => {
    const f = await fixture();
    const stream = await open(`${f.origin}${path}?after=0`);
    await vi.waitFor(() => expect(stream.body()).toContain('page-1'));
    const closed = await Promise.race([f.app.close().then(() => true), delay(750).then(() => false)]);
    expect(closed).toBe(true);
    await vi.waitFor(() => expect(stream.response.complete).toBe(true));
  });

  it('ends a stream immediately with a DB read pending and suppresses its late error write', async () => {
    const f = await fixture();
    let rejectRead!: (error: Error) => void;
    f.read.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
    const stream = await open(`${f.origin}${path}?after=0`);
    await vi.waitFor(() => expect(rejectRead).toBeTypeOf('function'));
    const write = vi.spyOn(f.response(), 'write');
    const end = vi.spyOn(f.response(), 'end');
    expect(await Promise.race([f.app.close().then(() => true), delay(750).then(() => false)])).toBe(true);
    rejectRead(new Error('database closed during shutdown'));
    await delay(20);
    expect(write).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
    expect(stream.body()).not.toContain('unavailable');
  });

  it('does not open a new endless stream when initial cursor lookup finishes after preClose', async () => {
    const f = await fixture();
    let resolveCursor!: (cursor: number) => void;
    vi.mocked(AgentPortalService.prototype.latestEventCursor).mockImplementationOnce(() => new Promise((resolve) => { resolveCursor = resolve; }));
    const opening = open(`${f.origin}${path}`);
    await vi.waitFor(() => expect(resolveCursor).toBeTypeOf('function'));
    const closing = f.app.close();
    await vi.waitFor(() => expect(f.isClosing()).toBe(true));
    resolveCursor(0);
    const stream = await opening;
    expect(await Promise.race([closing.then(() => true), delay(750).then(() => false)])).toBe(true);
    expect(f.read).not.toHaveBeenCalled();
    expect(stream.body()).toBe('');
  });

  it('establishes an empty stream immediately and resumes with Last-Event-ID', async () => {
    const f = await fixture();
    f.read.mockResolvedValue({ events: [], next_cursor: 19 });
    const stream = await Promise.race([
      open(`${f.origin}${path}`, { 'last-event-id': '19' }),
      delay(750).then(() => { throw new Error('SSE headers were not flushed'); }),
    ]);
    expect(stream.response.statusCode).toBe(200);
    await vi.waitFor(() => expect(f.read.mock.calls[0]?.[0]).toBe(19));
    expect(stream.body()).toBe('');
  });

  it('emits named heartbeat events that browsers can use to detect a silent connection', async () => {
    const f = await fixture();
    const stream = await open(`${f.origin}${path}?after=0`);
    await vi.waitFor(() => expect(stream.body()).toContain('page-1'));
    // Advance only the clock; the real socket and its polling timer keep running.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15_001);
    await vi.waitFor(() => expect(stream.body()).toContain('event: heartbeat'), { timeout: 2500 });
    expect(stream.body()).toContain('data: {"server_time":');
  });

  it('stops before reading another page after account revocation', async () => {
    const f = await fixture();
    const stream = await open(`${f.origin}${path}?after=0`);
    await vi.waitFor(() => expect(stream.body()).toContain('page-1'));
    const reads = f.read.mock.calls.length;
    f.setAdmin(null);
    await vi.waitFor(() => expect(stream.body()).toContain('event: unavailable'), { timeout: 2500 });
    expect(f.read).toHaveBeenCalledTimes(reads);
    expect(stream.body()).not.toContain('page-2');
  });

  it('rechecks the current role rather than the initially cached admin', async () => {
    const f = await fixture();
    const stream = await open(`${f.origin}${path}?after=0`);
    await vi.waitFor(() => expect(stream.body()).toContain('page-1'));
    f.demote();
    await vi.waitFor(() => expect(stream.body()).toContain('event: unavailable'), { timeout: 2500 });
    expect(stream.body()).toContain('admin_role_required');
    expect(stream.body()).not.toContain('page-2');
  });
});

it('passes a selected session and explicit cursor into the server query', async () => {
  const f = await fixture();
  const stream = await open(`${f.origin}/admin/agent-sessions/events?after=7&session_id=${SESSION_ID}`);
  await vi.waitFor(() => expect(stream.body()).toContain('page-8'));
  expect(f.read).toHaveBeenCalledWith(7, 250, SESSION_ID);
});

it.each([['false', false], ['0', false], ['true', true], ['1', true]])('parses tail=%s without truthy-string coercion', async (query, expected) => {
  const f = await fixture();
  const list = vi.spyOn(AgentPortalService.prototype, 'listEvents').mockResolvedValue({ events: [], next_cursor: 0 });
  const response = await fetch(`${f.origin}/admin/agent-sessions/${SESSION_ID}/events?tail=${query}`);
  expect(response.status).toBe(200);
  expect(list).toHaveBeenCalledWith(SESSION_ID, 0, 250, expected);
});

it('includes a single server snapshot instant and the matching derived-state inputs', async () => {
  const f = await fixture();
  const snapshot = { generated_at: '2026-09-08T07:00:00.123Z', sessions: [] };
  vi.spyOn(AgentPortalService.prototype, 'listAgentsSnapshot').mockResolvedValue(snapshot);
  const response = await fetch(`${f.origin}/admin/agent-sessions`);
  expect(response.status).toBe(200);
  const payload = await response.json() as { generated_at: string; timings: { working_fresh_seconds: number } };
  expect(payload.generated_at).toBe(snapshot.generated_at);
  expect(payload.timings.working_fresh_seconds).toBeGreaterThan(0);
});

it('gives the phone portal the same server clock contract as Active Clients', async () => {
  const f = await fixture();
  const snapshot = { generated_at: '2026-09-08T07:00:00.123Z', sessions: [] };
  vi.spyOn(AgentPortalService.prototype, 'listAgentsSnapshot').mockResolvedValue(snapshot);
  const response = await fetch(`${f.origin}/go/api/agents`);
  expect(response.status).toBe(200);
  const payload = await response.json() as { data: { generated_at: string; agents: unknown[] } };
  expect(payload.data.generated_at).toBe(snapshot.generated_at);
  expect(payload.data.agents).toEqual([]);
});
