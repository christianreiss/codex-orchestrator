import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { registerAgentReceiverRoutes } from '../../../src/routes/agent-receiver.js';
import { wsPublisher } from '../../../src/ws/publisher.js';

const calls = vi.hoisted(() => ({
  register: vi.fn(async () => ({})),
  update: vi.fn(async () => ({})),
  claim: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(async () => ({ delivery: null })),
}));
vi.mock('../../../src/services/agent-receiver.js', () => ({ AgentReceiverService: class {
  register = calls.register;
  update = calls.update;
  claim = calls.claim;
} }));
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.clearAllMocks(); });
const id = '11111111-1111-4111-8111-111111111111';
const headers = { 'x-agent-bridge-token': 'fixture' };
async function build() {
  const app = Fastify(); apps.push(app);
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof ZodError ? 400 : 500).send({ error: error instanceof Error ? error.message : 'request failed' }));
  await registerAgentReceiverRoutes(app, { db: {} as never, env: {} as never, keyring: {} as never });
  return app;
}
describe('receiver claim-gate telemetry schema', () => {
  it('accepts explicit negotiation and legacy generation-only heartbeats', async () => {
    const app = await build();
    const registration = { generation: id, protocol: 'codex-queue-v1', native_session_id: id, capabilities: { claim_gate_v1: true } };
    expect((await app.inject({ method: 'POST', url: `/host/agent-sessions/${id}/receiver/register`, headers, payload: registration })).statusCode).toBe(200);
    expect(calls.register).toHaveBeenCalledWith(id, 'fixture', registration);
    expect((await app.inject({ method: 'POST', url: `/host/agent-sessions/${id}/receiver/heartbeat`, headers, payload: { generation: id } })).statusCode).toBe(200);
  });
  it.each([0, 604800])('accepts bounded gate age %i', async (seconds) => {
    const app = await build();
    const body = { generation: id, claim_gate: { state: 'thread_active', seconds } };
    expect((await app.inject({ method: 'POST', url: `/host/agent-sessions/${id}/receiver/heartbeat`, headers, payload: body })).statusCode).toBe(200);
    expect(calls.update).toHaveBeenCalledWith(id, 'fixture', id, 'heartbeat', body);
  });
  it.each([
    { state: 'thread_prompt-content', seconds: 0 },
    { state: 'thread_active', seconds: -1 },
    { state: 'thread_active', seconds: 604801 },
    { state: 'thread_active', seconds: 1.5 },
    { state: 'thread_active', seconds: 1, content: 'unbounded diagnostic' },
  ])('refuses malformed or unbounded gate metadata %j', async (claim_gate) => {
    const app = await build();
    expect((await app.inject({ method: 'POST', url: `/host/agent-sessions/${id}/receiver/heartbeat`, headers, payload: { generation: id, claim_gate } })).statusCode).toBe(400);
    expect(calls.update).not.toHaveBeenCalled();
  });
  it.each(['stop', 'ack'])('does not allow heartbeat-only telemetry on %s', async (op) => {
    const app = await build();
    expect((await app.inject({ method: 'POST', url: `/host/agent-sessions/${id}/receiver/${op}`, headers, payload: { generation: id, claim_gate: { state: 'open', seconds: 0 } } })).statusCode).toBe(400);
    expect(calls.update).not.toHaveBeenCalled();
  });
});

describe('receiver claim hold', () => {
  const claimBody = { generation: id, source: 'peer', claim_id: '22222222-2222-4222-8222-222222222222' };
  const claim = (app: Awaited<ReturnType<typeof build>>) =>
    app.inject({ method: 'POST', url: `/host/agent-sessions/${id}/receiver/claim`, headers, payload: claimBody });

  it('answers a non-empty claim at once', async () => {
    calls.claim.mockResolvedValueOnce({ delivery: { message_id: 'm' } });
    const app = await build();
    const started = Date.now();
    expect((await claim(app)).json()).toEqual({ delivery: { message_id: 'm' } });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(calls.claim).toHaveBeenCalledTimes(1);
  });

  it('holds an empty claim and answers again once a message event is published', async () => {
    calls.claim.mockResolvedValueOnce({ delivery: null }).mockResolvedValueOnce({ delivery: { message_id: 'woken' } });
    const app = await build();
    const response = claim(app);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls.claim).toHaveBeenCalledTimes(1);
    wsPublisher.publish('agent_messaging.message.changed', { message_id: 'woken' });
    expect((await response).json()).toEqual({ delivery: { message_id: 'woken' } });
    expect(calls.claim).toHaveBeenCalledTimes(2);
  });

  it('releases on this session\'s portal event but not on another session\'s', async () => {
    calls.claim.mockResolvedValueOnce({ message: null }).mockResolvedValueOnce({ message: { id: 'portal' } });
    const app = await build();
    const response = claim(app);
    await new Promise((resolve) => setTimeout(resolve, 100));
    wsPublisher.publish('agent_portal.sessions.changed', { session_id: '33333333-3333-4333-8333-333333333333' });
    wsPublisher.publish('agent_messaging.address.changed', { session_id: id });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls.claim).toHaveBeenCalledTimes(1);
    wsPublisher.publish('agent_portal.sessions.changed', { session_id: id });
    expect((await response).json()).toEqual({ message: { id: 'portal' } });
  });

  it('does not lose an event published while the first check is in flight', async () => {
    calls.claim
      .mockImplementationOnce(async () => {
        wsPublisher.publish('agent_messaging.message.changed', {});
        return { delivery: null };
      })
      .mockResolvedValueOnce({ delivery: { message_id: 'raced' } });
    const app = await build();
    const started = Date.now();
    expect((await claim(app)).json()).toEqual({ delivery: { message_id: 'raced' } });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
