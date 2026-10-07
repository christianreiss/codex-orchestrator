import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAgentMessagingRoutes } from '../../../src/routes/agent-messaging/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { adminEvents } from '../../../src/db/schema.js';
import { registerCapabilityStack } from '../../helpers/capability-stack.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const ID = '11111111-1111-4111-8111-111111111111';
const apps: ReturnType<typeof Fastify>[] = [];
async function appFor(role: string | null) {
  const app = Fastify();
  apps.push(app);
  const db = createDbFake();
  await registerCapabilityStack(app, { role });
  await registerAgentMessagingRoutes(app, {
    db,
    env: loadTestEnv(),
    keyring: testKeyring(),
  } as unknown as RouteContext);
  return { app, db };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('group and publication HTTP capabilities', () => {
  it('permits viewer metadata but refuses create and publish before reaching the service', async () => {
    const list = vi
      .spyOn(AgentMessagingService.prototype, 'listAdminGroups')
      .mockResolvedValue({ groups: [] } as never);
    const subscriptions = vi
      .spyOn(AgentMessagingService.prototype, 'listAdminSubscriptions')
      .mockResolvedValue({ subscriptions: [] });
    const publish = vi.spyOn(AgentMessagingService.prototype, 'publishAdmin');
    const create = vi.spyOn(AgentMessagingService.prototype, 'createAdminGroup');
    const { app } = await appFor('viewer');
    expect((await app.inject('/admin/agent-messaging/groups')).statusCode).toBe(200);
    expect((await app.inject('/admin/agent-messaging/subscriptions')).statusCode).toBe(200);
    expect(list).toHaveBeenCalledOnce();
    expect(subscriptions).toHaveBeenCalledOnce();
    for (const url of [
      '/admin/agent-messaging/publish',
      '/admin/agent-messaging/groups/demo/publish',
      '/admin/agent-messaging/groups',
    ]) {
      expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(403);
    }
    expect(publish).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it('requires authentication for subscriptions and membership metadata', async () => {
    const { app } = await appFor(null);
    for (const url of [
      '/admin/agent-messaging/groups',
      '/admin/agent-messaging/groups/demo',
      '/admin/agent-messaging/subscriptions',
    ]) {
      expect((await app.inject(url)).statusCode).toBe(401);
    }
  });
  it('publishes as Server through an audited operator route without plaintext in audit data', async () => {
    const publish = vi
      .spyOn(AgentMessagingService.prototype, 'publishAdmin')
      .mockResolvedValue({
        publication_id: ID,
        topic: 'group:demo',
        created: true,
        recipient_count: 1,
        deliveries: [{ address_id: ID, message_id: ID }],
        skipped: [],
      });
    const { app, db } = await appFor('owner');
    const response = await app.inject({
      method: 'POST',
      url: '/admin/agent-messaging/groups/demo/publish',
      payload: {
        content: 'private publish body',
        client_message_id: ID,
        ttl_seconds: 60,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(publish).toHaveBeenCalledWith({
      topic: 'group:demo',
      content: 'private publish body',
      clientMessageId: ID,
      ttlSeconds: 60,
    });
    expect(db.tables.get(adminEvents)).toEqual([
      expect.objectContaining({
        type: 'agent_messaging.publication.created',
        payload: {
          publication_id: ID,
          topic: 'group:demo',
          recipient_count: 1,
          skipped_count: 0,
          admin_user_id: 7,
        },
      }),
    ]);
    expect(JSON.stringify(db.tables.get(adminEvents))).not.toContain('private publish body');
  });
  it('binds host subscriptions to their bridge credential and refuses invented identity fields', async () => {
    const subscribe = vi
      .spyOn(AgentMessagingService.prototype, 'subscribe')
      .mockResolvedValue({ topic: 'group:demo', subscribed: true, changed: true });
    const { app } = await appFor(null);
    const url = `/host/agent-sessions/${ID}/agent-messaging/subscribe`;
    const accepted = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-agent-bridge-token': 'bridge-token' },
      payload: { topic: 'group:demo' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(subscribe).toHaveBeenCalledWith(ID, 'bridge-token', 'group:demo');
    const absent = await app.inject({ method: 'POST', url, payload: { topic: 'group:demo' } });
    expect(absent.statusCode).not.toBe(200);
    const forged = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-agent-bridge-token': 'bridge-token' },
      payload: { topic: 'group:demo', subscriber_address_id: ID },
    });
    expect(forged.statusCode).not.toBe(200);
    expect(subscribe).toHaveBeenCalledOnce();
  });
});
