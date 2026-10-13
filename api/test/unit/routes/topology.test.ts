import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { registerCommunicatorRoutes } from '../../../src/routes/communicator.js';
import { registerAdminTopologyRoutes } from '../../../src/routes/admin/topology/index.js';
import { communicatorRegistry } from '../../../src/services/topology/communicator-registry.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { registerCapabilityStack } from '../../helpers/capability-stack.js';

// A role that may read hosts but not the agent portal. No shipped role is shaped
// like this today; the route must still hold the line for the day one is.
vi.mock('../../../src/security/capabilities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/security/capabilities.js')>();
  return {
    ...actual,
    roleHasCapability: (role: string, capability: string) =>
      role === 'portal-blind' ? capability !== 'agent_portal.read' : actual.roleHasCapability(role, capability as never),
  };
});

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';

vi.mock('../../../src/services/mcp-session.js', () => ({
  McpSessionService: class {
    async verify() {
      return { id: 1 };
    }
  },
}));
vi.mock('../../../src/services/host-auth.js', () => ({
  createHostAuthService: () => ({
    authenticate: async (req: { headers: Record<string, string>; authHost?: { id: number; secure: number } }) => {
      if (req.headers['x-api-key'] !== 'host-one') throw new Error('denied');
      req.authHost = { id: 1, secure: 1 };
      return req.authHost;
    },
  }),
}));

// The portal projection is a service of its own with its own suites. Here it is
// a fixed list of live sessions, so the test measures what the topology does
// with them and with the socket evidence.
const portal = vi.hoisted(() => ({ sessions: [] as Array<Record<string, unknown>>, enabled: true }));
vi.mock('../../../src/services/agent-portal.js', () => ({
  createAgentPortalService: () => ({
    isEnabled: async () => portal.enabled,
    listAgentsSnapshot: async () => ({ generated_at: new Date().toISOString(), sessions: portal.sessions }),
  }),
}));

const inserted = vi.hoisted(() => [] as Array<Record<string, unknown>>);
function emptyChain(): unknown {
  const chain: unknown = new Proxy(function () {}, {
    get: (_target, prop) => (prop === 'then' ? (resolve: (rows: unknown[]) => void) => resolve([]) : chain),
    apply: () => chain,
  });
  return chain;
}
const db = {
  select: () => emptyChain(),
  insert: () => ({
    values: async (row: Record<string, unknown>) => {
      inserted.push(row);
      return [{ insertId: inserted.length }];
    },
  }),
} as never;

const session = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  engine: 'claude',
  host_id: 1,
  host: 'web01.example',
  username: 'tester',
  cwd: '/srv',
  launch_name: `agent-${id.slice(0, 4)}`,
  session_name: null,
  invocation_kind: 'interactive',
  presence: 'listening',
  status: 'active',
  relay_ready: true,
  started_at: '2026-10-13T17:00:00.000Z',
  heartbeat_at: new Date().toISOString(),
  ended_at: null,
  close: null,
  ...overrides,
});

let apps: FastifyInstance[] = [];
async function build(role: string | null, withCommunicator: boolean) {
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(cookie);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);
  await registerCapabilityStack(app, { role, userId: 7 });
  app.decorateRequest('clientIp', '192.0.2.1');
  const ctx = {
    db,
    env: { CXX_COMMUNICATOR_ENABLED: true, AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS: 45, PUBLIC_BASE_URL: 'https://orch.example' } as never,
    keyring: {} as never,
  };
  if (withCommunicator) {
    await registerCommunicatorRoutes(app, ctx);
    // Stand-ins for the session routes the API would dispatch to. S3 is refused,
    // as a session whose bridge token does not authenticate would be.
    app.post('/host/agent-sessions/:id/heartbeat', (req, reply) => {
      if ((req.params as { id: string }).id === S3) return reply.code(403).send({ code: 'agent_bridge_unauthorized' });
      return { ok: true };
    });
  }
  await registerAdminTopologyRoutes(app, ctx);
  await app.ready();
  return app;
}

async function connect(app: FastifyInstance) {
  const ws = await app.injectWS('/host/communicator/connect', { headers: { 'x-api-key': 'host-one' } });
  const ready = new Promise<void>((resolve) => ws.once('message', () => resolve()));
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, username: 'tester', version: '0.9.74' }));
  await ready;
  return ws;
}

async function call(ws: Awaited<ReturnType<typeof connect>>, path: string, method = 'POST') {
  const id = randomUUID();
  const reply = new Promise<{ status: number }>((resolve) => ws.once('message', (data: unknown) => resolve(JSON.parse(String(data)))));
  ws.send(JSON.stringify({ id, type: 'request', method, path, headers: {}, body: '' }));
  return reply;
}

interface TopologyBody {
  server: Record<string, unknown>;
  communicators: Array<{ id: string; agent_ids: string[] } & Record<string, unknown>>;
  agents: Array<{ id: string; association: Record<string, unknown> } & Record<string, unknown>>;
  recent_disconnects: Array<Record<string, unknown>>;
  counts: Record<string, number>;
}
const topology = async (app: FastifyInstance) => {
  const res = await app.inject({ method: 'GET', url: '/admin/topology' });
  return { status: res.statusCode, body: (res.json().data ?? res.json()) as TopologyBody };
};

beforeEach(() => {
  communicatorRegistry.reset();
  inserted.length = 0;
  portal.enabled = true;
  portal.sessions = [session(S1), session(S2), session(S3)];
});
afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
  communicatorRegistry.reset();
});

describe('GET /admin/topology', () => {
  it('shows the server alone when nobody is connected, with every session direct', async () => {
    const app = await build('viewer', false);
    const { status, body } = await topology(app);
    expect(status).toBe(200);
    expect(body.server).toMatchObject({ id: 'server', label: 'orch.example', communicator_enabled: true, portal_enabled: true });
    expect(body.communicators).toEqual([]);
    expect(body.agents.map((a) => a.association.state)).toEqual(['unattributed', 'unattributed', 'unattributed']);
  });

  it('rejects an anonymous caller', async () => {
    const app = await build(null, false);
    expect((await topology(app)).status).toBe(401);
  });

  it('parents exactly the sessions whose accepted requests crossed the socket', async () => {
    const app = await build('owner', true);
    const ws = await connect(app);
    expect((await call(ws, `/host/agent-sessions/${S1}/heartbeat`)).status).toBe(200);
    // Refused by the API: proves nothing about S3, so it must not become a child.
    expect((await call(ws, `/host/agent-sessions/${S3}/heartbeat`)).status).toBe(403);

    const { body } = await topology(app);
    expect(body.communicators).toHaveLength(1);
    const node = body.communicators[0];
    expect(node).toMatchObject({ host_id: 1, username: 'tester', version: '0.9.74', health: 'live', agent_ids: [S1] });
    const byId = Object.fromEntries(body.agents.map((a) => [a.id, a.association]));
    expect(byId[S1]).toMatchObject({ state: 'attributed', parent_id: node!.id, basis: 'session_traffic' });
    expect(byId[S2]).toMatchObject({ state: 'unattributed', parent_id: 'server' });
    expect(byId[S3]).toMatchObject({ state: 'unattributed', parent_id: 'server' });
    ws.close();
  });

  it('withholds sessions from a role that may read hosts but not the portal', async () => {
    const app = await build('portal-blind', true);
    const ws = await connect(app);
    await call(ws, `/host/agent-sessions/${S1}/heartbeat`);
    const { status, body } = await topology(app);
    expect(status).toBe(200);
    expect(body.communicators).toHaveLength(1);
    expect(body.communicators[0]!.agent_ids).toEqual([]);
    expect(body.agents).toEqual([]);
    expect(body.counts).toMatchObject({ communicators: 1, agents: 0, attributed: 0 });
    ws.close();
  });
});

describe('owner control negotiation and POST /admin/communicators/:id/terminate', () => {
  /** An owner the way cxx behaves: announces itself only to a server that offered control. */
  async function owner(app: FastifyInstance, behaviour: 'acks-and-exits' | 'silent' | 'refuses' | 'old') {
    const ws = await app.injectWS('/host/communicator/connect', { headers: { 'x-api-key': 'host-one' } });
    const frames: Array<Record<string, unknown>> = [];
    const ready = new Promise<void>((resolve) => ws.once('message', (data: unknown) => {
      frames.push(JSON.parse(String(data)));
      resolve();
    }));
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, username: 'tester', version: '0.9.76' }));
    await ready;
    ws.on('message', (data: unknown) => {
      const frame = JSON.parse(String(data));
      frames.push(frame);
      if (frame.type !== 'terminate') return;
      if (behaviour === 'acks-and-exits') {
        ws.send(JSON.stringify({ type: 'terminate_ack', request_id: frame.request_id, accepted: true, pid: 4242 }));
        setTimeout(() => ws.terminate(), 30);
      } else if (behaviour === 'refuses') {
        ws.send(JSON.stringify({ type: 'terminate_ack', request_id: frame.request_id, accepted: false, reason: 'unsupported' }));
      }
    });
    if (behaviour !== 'old' && (frames[0]?.control as string[] | undefined)?.includes('terminate')) {
      ws.send(JSON.stringify({ type: 'capabilities', terminate: true, pid: 4242, started_at: '2026-10-13T17:00:00Z' }));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { ws, frames, id: communicatorRegistry.snapshot()[0]!.view.id };
  }
  const post = (app: FastifyInstance, id: string, body: unknown) =>
    app.inject({ method: 'POST', url: `/admin/communicators/${id}/terminate`, payload: body as object });

  it('offers control in `ready` and shows what the owner says about its own process', async () => {
    const app = await build('owner', true);
    const { ws, frames } = await owner(app, 'acks-and-exits');
    expect(frames[0]).toEqual({ type: 'ready', protocol: 1, control: ['terminate'] });
    const { body } = await topology(app);
    expect(body.communicators[0]).toMatchObject({ can_terminate: true, process: { pid: 4242, started_at: '2026-10-13T17:00:00Z' } });
    ws.close();
  });

  it('terminates only on the owner\'s acknowledgement, then reports the closed connection and the pid', async () => {
    const app = await build('owner', true);
    const { ws, id, frames } = await owner(app, 'acks-and-exits');
    const res = await post(app, id, { client_message_id: randomUUID(), expect: { host_id: 1, username: 'tester' }, note: 'wedged' });
    const body = res.json().data ?? res.json();
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ outcome: 'terminated', acknowledged: true, connection_closed: true, process: { pid: 4242 }, replayed: false });
    expect(frames.find((f) => f.type === 'terminate')).toMatchObject({ reason: 'admin' });
    expect(communicatorRegistry.has(id)).toBe(false);
    const audit = inserted.find((row) => row.type === 'communicator.terminated') as { payload: Record<string, unknown> } | undefined;
    expect(audit!.payload).toMatchObject({ connection_id: id, outcome: 'terminated', reported_pid: 4242, note: 'wedged', admin_user_id: 7 });
    expect((await topology(app)).body.recent_disconnects[0]).toMatchObject({ id, reason: 'admin_terminate', pid: 4242 });
    ws.close();
  });

  it('says "unacknowledged" when the owner never answers, and leaves the connection alone', async () => {
    const app = await build('owner', true);
    const { ws, id } = await owner(app, 'silent');
    const res = await post(app, id, { client_message_id: randomUUID() });
    expect(res.statusCode).toBe(200);
    expect((res.json().data ?? res.json())).toMatchObject({ outcome: 'unacknowledged', acknowledged: false, connection_closed: false });
    expect(communicatorRegistry.has(id)).toBe(true);
    expect(communicatorRegistry.get(id)!.closing).toBe(false);
    ws.close();
  }, 15_000);

  it('reports a refusal', async () => {
    const app = await build('owner', true);
    const { ws, id } = await owner(app, 'refuses');
    const res = await post(app, id, { client_message_id: randomUUID() });
    expect((res.json().data ?? res.json())).toMatchObject({ outcome: 'refused', acknowledged: false });
    ws.close();
  });

  it('answers 409 for an owner that never announced the capability, without sending a frame', async () => {
    const app = await build('owner', true);
    const { ws, id, frames } = await owner(app, 'old');
    const res = await post(app, id, { client_message_id: randomUUID() });
    expect(res.statusCode).toBe(409);
    expect(frames.some((f) => f.type === 'terminate')).toBe(false);
    ws.close();
  });

  it('is gated like the other controls and idempotent', async () => {
    const owned = await build('owner', true);
    const { ws, id } = await owner(owned, 'acks-and-exits');
    for (const role of ['viewer', 'fleet', 'trusted']) {
      const denied = await build(role, false);
      expect((await post(denied, id, { client_message_id: randomUUID() })).statusCode).toBe(403);
    }
    expect((await post(await build(null, false), id, { client_message_id: randomUUID() })).statusCode).toBe(401);
    expect(communicatorRegistry.has(id)).toBe(true);
    const key = randomUUID();
    expect((await post(owned, id, { client_message_id: key })).statusCode).toBe(200);
    const again = await post(owned, id, { client_message_id: key });
    expect((again.json().data ?? again.json()).replayed).toBe(true);
    expect(inserted.filter((row) => row.type === 'communicator.terminated')).toHaveLength(1);
    ws.close();
  });

  it('answers 404 for a connection that is already gone', async () => {
    const app = await build('owner', true);
    expect((await post(app, randomUUID(), { client_message_id: randomUUID() })).statusCode).toBe(404);
  });
});

describe('POST /admin/communicators/:id/disconnect', () => {
  async function connected(app: FastifyInstance) {
    const ws = await connect(app);
    await call(ws, `/host/agent-sessions/${S1}/heartbeat`);
    const { body } = await topology(app);
    return { ws, id: body.communicators[0]!.id };
  }
  const post = (app: FastifyInstance, id: string, body: unknown) =>
    app.inject({ method: 'POST', url: `/admin/communicators/${id}/disconnect`, payload: body as object });

  it('closes exactly the selected socket, names the children, and audits it', async () => {
    const app = await build('owner', true);
    const first = await connected(app);
    const other = await connect(app);
    const closed = new Promise<number>((resolve) => first.ws.once('close', (code: number) => resolve(code)));
    const events: Array<{ type: string; payload: unknown }> = [];
    const stop = wsPublisher.subscribe((event) => events.push(event as never));

    const res = await post(app, first.id, {
      client_message_id: randomUUID(),
      expect: { host_id: 1, username: 'tester' },
      note: 'stuck sync',
    });
    stop();
    const body = res.json().data ?? res.json();
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({
      outcome: 'closed',
      connection_id: first.id,
      reconnect_expected: true,
      replayed: false,
      affected: { agent_ids: [S1] },
    });
    expect(await closed).toBe(4001);
    expect(communicatorRegistry.has(first.id)).toBe(false);
    // The other connection is untouched.
    expect(communicatorRegistry.snapshot()).toHaveLength(1);

    const audit = inserted.find((row) => row.type === 'communicator.disconnected') as { payload: Record<string, unknown> } | undefined;
    expect(audit).toBeTruthy();
    expect(audit!.payload).toMatchObject({
      connection_id: first.id,
      outcome: 'closed',
      affected_agent_ids: [S1],
      note: 'stuck sync',
      admin_user_id: 7,
    });
    expect(events.map((e) => e.type)).toContain('communicator.disconnected');

    const after = await topology(app);
    expect(after.body.recent_disconnects[0]).toMatchObject({ id: first.id, reason: 'admin_disconnect', affected_agent_ids: [S1] });
    other.close();
  });

  it('is idempotent on client_message_id and refuses to reuse it for another target', async () => {
    const app = await build('owner', true);
    const first = await connected(app);
    const other = await connect(app);
    const otherId = communicatorRegistry.snapshot().find((c) => c.view.id !== first.id)!.view.id;
    const key = randomUUID();
    const a = await post(app, first.id, { client_message_id: key });
    expect(a.statusCode).toBe(200);
    const again = await post(app, first.id, { client_message_id: key });
    expect(again.statusCode).toBe(200);
    expect((again.json().data ?? again.json()).replayed).toBe(true);
    expect(inserted.filter((row) => row.type === 'communicator.disconnected')).toHaveLength(1);
    const reused = await post(app, otherId, { client_message_id: key });
    expect(reused.statusCode).toBe(409);
    expect(communicatorRegistry.has(otherId)).toBe(true);
    other.close();
  });

  it('answers 404 for a socket that is already gone, without recording an action', async () => {
    const app = await build('owner', true);
    const gone = await post(app, randomUUID(), { client_message_id: randomUUID() });
    expect(gone.statusCode).toBe(404);
    expect((gone.json().error ?? gone.json()).code ?? gone.json().code).toBe('communicator_not_connected');
    expect(inserted).toEqual([]);
  });

  it('refuses when the selection no longer matches the connection', async () => {
    const app = await build('owner', true);
    const { ws, id } = await connected(app);
    const res = await post(app, id, { client_message_id: randomUUID(), expect: { host_id: 1, username: 'someone-else' } });
    expect(res.statusCode).toBe(409);
    expect(communicatorRegistry.has(id)).toBe(true);
    ws.close();
  });

  it('validates the body', async () => {
    const app = await build('owner', true);
    const { ws, id } = await connected(app);
    expect((await post(app, id, {})).statusCode).toBe(422);
    expect((await post(app, id, { client_message_id: "x" })).statusCode).toBe(422);
    expect((await post(app, id, { client_message_id: randomUUID(), extra: 1 })).statusCode).toBe(422);
    expect((await post(app, "not-a-uuid", { client_message_id: randomUUID() })).statusCode).toBe(422);
    expect(communicatorRegistry.has(id)).toBe(true);
    ws.close();
  });

  it.each(['viewer', 'user', 'trusted', 'fleet'])('refuses the %s role and leaves the socket connected', async (role) => {
    const owner = await build('owner', true);
    const { ws, id } = await connected(owner);
    const app = await build(role, false);
    const res = await post(app, id, { client_message_id: randomUUID() });
    expect(res.statusCode).toBe(403);
    expect(communicatorRegistry.has(id)).toBe(true);
    expect(inserted).toEqual([]);
    ws.close();
  });

  it.each(['owner', 'admin'])('lets the %s role disconnect', async (role) => {
    const app = await build(role, true);
    const { ws, id } = await connected(app);
    const res = await post(app, id, { client_message_id: randomUUID() });
    expect(res.statusCode).toBe(200);
    expect(communicatorRegistry.has(id)).toBe(false);
    ws.close();
  });

  it('rejects an anonymous caller', async () => {
    const app = await build(null, false);
    expect((await post(app, randomUUID(), { client_message_id: randomUUID() })).statusCode).toBe(401);
  });

  it('shows the redial as a new node that replaces the old one', async () => {
    const app = await build('owner', true);
    const first = await connected(app);
    await post(app, first.id, { client_message_id: randomUUID() });
    const again = await connect(app);
    const { body } = await topology(app);
    expect(body.communicators).toHaveLength(1);
    expect(body.communicators[0]!.id).not.toBe(first.id);
    expect(body.recent_disconnects[0]).toMatchObject({ id: first.id, successor_id: body.communicators[0]!.id });
    again.close();
  });
});
