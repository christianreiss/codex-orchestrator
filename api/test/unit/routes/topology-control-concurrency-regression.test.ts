import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { registerAdminTopologyRoutes } from '../../../src/routes/admin/topology/index.js';
import { communicatorRegistry } from '../../../src/services/topology/communicator-registry.js';
import { registerCapabilityStack } from '../../helpers/capability-stack.js';

// Pause the first topology read: two real HTTP requests overlap while the first
// operation is pending. The registry, route and audit writer remain real.
const projection = vi.hoisted(() => ({ entered: () => {}, pending: Promise.resolve() }));
vi.mock('../../../src/services/topology/service.js', () => ({
  TopologyService: class {
    async snapshot() {
      projection.entered();
      await projection.pending;
      return { communicators: [] };
    }
    invalidate() {}
  },
}));

const audits: Array<Record<string, unknown>> = [];
let app: FastifyInstance;
let unblock: () => void;
let entered: Promise<void>;
let requestsStarted = 0;

function socket() {
  const id = randomUUID();
  const close = vi.fn(() => queueMicrotask(() => communicatorRegistry.unregister(id)));
  communicatorRegistry.register({
    id, host_id: 42, username: 'fixture', version: '0.9.76',
    connected_at: new Date().toISOString(), sessions: 0, requests: 0, synced_at: null,
  }, { close, remoteAddress: null });
  return { id, close };
}
const post = (id: string, key: string, action = 'disconnect') => app.inject({
  method: 'POST', url: `/admin/communicators/${id}/${action}`, payload: { client_message_id: key },
});
const body = (response: { json(): any }) => response.json().data ?? response.json();

beforeEach(async () => {
  audits.length = 0;
  requestsStarted = 0;
  communicatorRegistry.reset();
  projection.pending = new Promise<void>((resolve) => { unblock = resolve; });
  entered = new Promise<void>((resolve) => { projection.entered = resolve; });
  app = Fastify({ logger: false });
  app.addHook('onRequest', async () => { requestsStarted += 1; });
  await app.register(cookie);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);
  await registerCapabilityStack(app, { role: 'owner', userId: 7 });
  await registerAdminTopologyRoutes(app, {
    db: { insert: () => ({ values: async (row: Record<string, unknown>) => { audits.push(row); } }) } as never,
    env: {} as never, keyring: {} as never,
  });
  await app.ready();
});
afterEach(async () => {
  unblock();
  await app.close();
  communicatorRegistry.reset();
});

async function overlap(firstId: string, secondId: string, key: string, action = 'disconnect', secondAction = action) {
  const first = post(firstId, key, action).then((response) => response);
  await entered;
  const second = post(secondId, key, secondAction).then((response) => response);
  // No sleeps or socket races: allow in-process inject to enter both handlers.
  for (let i = 0; i < 5; i++) await nextTurn();
  unblock();
  return Promise.all([first, second]);
}

describe('topology concurrent control idempotency', () => {
  it('keeps a pending key reserved when other pending operations fill the cache', async () => {
    const target = socket();
    const key = randomUUID();
    const first = post(target.id, key).then((response) => response);
    await entered;
    const others = Array.from({ length: 256 }, () => {
      const other = socket();
      return post(other.id, randomUUID()).then((response) => response);
    });
    await vi.waitFor(() => expect(requestsStarted).toBe(257), { timeout: 2000, interval: 1 });
    for (let i = 0; i < 5; i++) await nextTurn();
    const retry = post(target.id, key).then((response) => response);
    for (let i = 0; i < 5; i++) await nextTurn();
    unblock();
    const [a, again] = await Promise.all([first, retry]);
    await Promise.all(others);
    const sameKeyAudits = audits.filter((row) => (row.payload as { client_message_id?: string }).client_message_id === key);
    console.info('cache saturation effects', { statuses: [a.statusCode, again.statusCode], closes: target.close.mock.calls.length, sameKeyAudits: sameKeyAudits.length, replayed: [body(a).replayed, body(again).replayed] });
    expect([a.statusCode, again.statusCode]).toEqual([200, 200]);
    expect(target.close).toHaveBeenCalledTimes(1);
    expect(sameKeyAudits).toHaveLength(1);
    expect(body(again).replayed).toBe(true);
  });

  it('dispatches and audits once when the same key is retried before completion', async () => {
    const target = socket();
    const responses = await overlap(target.id, target.id, randomUUID());
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    console.info('same-target effects', { closes: target.close.mock.calls.length, audits: audits.length, replayed: responses.map((r) => body(r).replayed) });
    expect(target.close).toHaveBeenCalledTimes(1);
    expect(audits).toHaveLength(1);
    expect(responses.map((r) => body(r).replayed).sort()).toEqual([false, true]);
  });

  it('rejects concurrent reuse for another socket before any action on that socket', async () => {
    const first = socket();
    const other = socket();
    const responses = await overlap(first.id, other.id, randomUUID());
    console.info('cross-target effects', { statuses: responses.map((r) => r.statusCode), firstCloses: first.close.mock.calls.length, otherCloses: other.close.mock.calls.length, audits: audits.length });
    expect(responses.map((r) => r.statusCode)).toEqual([200, 409]);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(other.close).not.toHaveBeenCalled();
    expect(communicatorRegistry.has(other.id)).toBe(true);
    expect(audits).toHaveLength(1);
  });
});

function terminateSocket() {
  const id = randomUUID();
  const send = vi.fn((value: unknown) => {
    const command = value as { request_id: string; owner_instance_id: string };
    communicatorRegistry.acknowledgeTerminate(id, command.request_id, { accepted: true, pid: 1234, reason: null, instance_id: command.owner_instance_id });
    queueMicrotask(() => communicatorRegistry.unregister(id));
  });
  const close = vi.fn(() => queueMicrotask(() => communicatorRegistry.unregister(id)));
  communicatorRegistry.register({
    id, host_id: 42, username: 'fixture', version: '0.9.76',
    connected_at: new Date().toISOString(), sessions: 0, requests: 0, synced_at: null,
  }, { close, send, remoteAddress: null });
  communicatorRegistry.setCapabilities(id, { terminate: true, pid: 1234, started_at: new Date().toISOString(), instance_id: randomUUID(), runtime_id: 'aaaaaaaaaaaaaaaa' });
  return { id, send, close };
}

describe('topology concurrent terminate idempotency', () => {
  it.each(['pending_ack', 'acknowledged'])('refuses a second key while the first stop is %s', async (phase) => {
    const id = randomUUID();
    const instance = randomUUID();
    const commands: Array<{ request_id: string; owner_instance_id: string }> = [];
    const acknowledge = (command: typeof commands[number]) => communicatorRegistry.acknowledgeTerminate(id, command.request_id, { accepted: true, pid: 1234, reason: null, instance_id: instance });
    const send = vi.fn((value: unknown) => {
      const command = value as typeof commands[number];
      commands.push(command);
      if (phase === 'acknowledged') acknowledge(command);
    });
    communicatorRegistry.register({ id, host_id: 42, username: 'fixture', version: '0.9.78', connected_at: new Date().toISOString(), sessions: 0, requests: 0, synced_at: null }, { close: vi.fn(), send, remoteAddress: null });
    communicatorRegistry.setCapabilities(id, { terminate: true, pid: 1234, started_at: null, instance_id: instance, runtime_id: 'aaaaaaaaaaaaaaaa' });
    const first = post(id, randomUUID(), 'terminate').then((response) => response);
    unblock();
    await vi.waitFor(() => expect(commands).toHaveLength(1), { interval: 1 });
    if (phase === 'acknowledged') await vi.waitFor(() => expect(communicatorRegistry.get(id)?.closing).toBe(true), { interval: 1 });
    const second = post(id, randomUUID(), 'terminate').then((response) => response);
    for (let i = 0; i < 5; i++) await nextTurn();
    if (phase === 'pending_ack') acknowledge(commands[0]!);
    communicatorRegistry.unregister(id);
    const responses = await Promise.all([first, second]);
    console.info('different-key route effects', { phase, statuses: responses.map((r) => r.statusCode), sends: send.mock.calls.length });
    expect(responses.map((r) => r.statusCode)).toEqual([200, 409]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(commands.every((command) => command.owner_instance_id === instance)).toBe(true);
  });

  it('joins a concurrent retry for the same socket without another audit or denial', async () => {
    const target = terminateSocket();
    const responses = await overlap(target.id, target.id, randomUUID(), 'terminate');
    console.info('same-target terminate effects', { statuses: responses.map((r) => r.statusCode), sends: target.send.mock.calls.length, audits: audits.length });
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(target.send).toHaveBeenCalledTimes(1);
    expect(audits).toHaveLength(1);
    expect(responses.map((r) => body(r).replayed).sort()).toEqual([false, true]);
  });

  it('refuses another socket sharing the pending key without sending it a termination', async () => {
    const first = terminateSocket();
    const other = terminateSocket();
    const responses = await overlap(first.id, other.id, randomUUID(), 'terminate');
    console.info('cross-target terminate effects', { statuses: responses.map((r) => r.statusCode), firstSends: first.send.mock.calls.length, otherSends: other.send.mock.calls.length, audits: audits.length });
    expect(responses.map((r) => r.statusCode)).toEqual([200, 409]);
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(other.send).not.toHaveBeenCalled();
    expect(communicatorRegistry.has(other.id)).toBe(true);
    expect(audits).toHaveLength(1);
  });
});

describe('cross-action reuse and stale topology selection', () => {
  it.each([
    ['disconnect', 'terminate'],
    ['terminate', 'disconnect'],
  ])('rejects a pending %s key used for %s on the same socket', async (action, secondAction) => {
    const target = terminateSocket();
    const responses = await overlap(target.id, target.id, randomUUID(), action, secondAction);
    console.info('same-socket cross-action effects', {
      action, secondAction, statuses: responses.map((r) => r.statusCode),
      closes: target.close.mock.calls.length, sends: target.send.mock.calls.length, audits: audits.length,
    });
    expect(responses.map((r) => r.statusCode)).toEqual([200, 409]);
    expect(target.close.mock.calls.length + target.send.mock.calls.length).toBe(1);
    expect(audits).toHaveLength(1);
  });

  it.each([
    ['disconnect', 'terminate'],
    ['terminate', 'disconnect'],
  ])('reserves a pending %s key before a %s request for another target', async (action, secondAction) => {
    const first = terminateSocket();
    const other = terminateSocket();
    const responses = await overlap(first.id, other.id, randomUUID(), action, secondAction);
    console.info('cross-action effects', {
      action, secondAction, statuses: responses.map((r) => r.statusCode),
      firstCloses: first.close.mock.calls.length, firstSends: first.send.mock.calls.length,
      otherCloses: other.close.mock.calls.length, otherSends: other.send.mock.calls.length, audits: audits.length,
    });
    expect(responses.map((r) => r.statusCode)).toEqual([200, 409]);
    expect(other.close).not.toHaveBeenCalled();
    expect(other.send).not.toHaveBeenCalled();
    expect(communicatorRegistry.has(other.id)).toBe(true);
    expect(audits).toHaveLength(1);
  });

  it.each(['disconnect', 'terminate'])('does not act on a successor when the selected %s socket disappeared', async (action) => {
    const old = terminateSocket();
    communicatorRegistry.unregister(old.id);
    const successor = terminateSocket();
    const response = await post(old.id, randomUUID(), action);
    expect(response.statusCode).toBe(404);
    expect(successor.send).not.toHaveBeenCalled();
    expect(successor.close).not.toHaveBeenCalled();
    expect(communicatorRegistry.has(successor.id)).toBe(true);
    expect(audits).toHaveLength(0);
  });

  it.each(['disconnect', 'terminate'])('rejects a stale host/user expectation for %s without dispatch', async (action) => {
    const target = terminateSocket();
    const response = await app.inject({ method: 'POST', url: `/admin/communicators/${target.id}/${action}`,
      payload: { client_message_id: randomUUID(), expect: { host_id: 999, username: 'old-label' } } });
    expect(response.statusCode).toBe(409);
    expect(target.send).not.toHaveBeenCalled();
    expect(target.close).not.toHaveBeenCalled();
    expect(communicatorRegistry.has(target.id)).toBe(true);
    expect(audits).toHaveLength(0);
  });
});
