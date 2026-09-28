import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAgentMessagingRoutes } from '../../../src/routes/agent-messaging/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { adminEvents } from '../../../src/db/schema.js';
import { registerCapabilityStack } from '../../helpers/capability-stack.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
const ID = '11111111-1111-4111-8111-111111111111';
const apps: ReturnType<typeof Fastify>[] = [];
async function appFor(role: string | null) {
  const app = Fastify(); apps.push(app);
  const db = createDbFake();
  await registerCapabilityStack(app, { role });
  await registerAgentMessagingRoutes(app, { db, env: loadTestEnv(), keyring: testKeyring() } as unknown as RouteContext);
  return { app, db };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(apps.splice(0).map((app) => app.close())); });
describe('conference inspector authorization and reveal audit', () => {
  it('allows a viewer to read metadata but refuses plaintext before the handler', async () => {
    const list = vi.spyOn(AgentMessagingService.prototype, 'listAdminConferences').mockResolvedValue({ conferences: [] });
    const reveal = vi.spyOn(AgentMessagingService.prototype, 'revealAdminConferenceMessages');
    const { app } = await appFor('viewer');
    expect((await app.inject('/admin/agent-messaging/conferences')).statusCode).toBe(200);
    expect(list).toHaveBeenCalled();
    expect((await app.inject({ method: 'POST', url: `/admin/agent-messaging/conferences/${ID}/reveal`, payload: { message_ids: [ID] } })).statusCode).toBe(403);
    expect(reveal).not.toHaveBeenCalled();
  });
  it('requires authentication for room metadata', async () => {
    const { app } = await appFor(null);
    expect((await app.inject('/admin/agent-messaging/conferences')).statusCode).toBe(401);
  });
  it('reveals only through an audited no-store response without broadcasting bodies', async () => {
    vi.spyOn(AgentMessagingService.prototype, 'revealAdminConferenceMessages').mockResolvedValue({ messages: [{ id: ID, content: 'private report' }], oldest_cursor: 1, newest_cursor: 1, has_more: false } as never);
    const { app, db } = await appFor('owner');
    const observed: string[] = [];
    const unsubscribe = wsPublisher.subscribe((event) => observed.push(JSON.stringify(event)));
    try {
      const response = await app.inject({ method: 'POST', url: `/admin/agent-messaging/conferences/${ID}/reveal`, payload: { message_ids: [ID] } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json().messages[0].content).toBe('private report');
      expect(db.tables.get(adminEvents)).toEqual([expect.objectContaining({ type: 'agent_messaging.conference.revealed', payload: { conference_id: ID, message_ids: [ID], admin_user_id: 7 } })]);
      expect(JSON.stringify(db.tables.get(adminEvents))).not.toContain('private report');
      expect(observed).toEqual([]);
    } finally { unsubscribe(); }
  });
  it('validates cursors and bounds before reading or decrypting', async () => {
    const read = vi.spyOn(AgentMessagingService.prototype, 'listAdminConferenceMessages');
    const reveal = vi.spyOn(AgentMessagingService.prototype, 'revealAdminConferenceMessages');
    const { app } = await appFor('owner');
    for (const query of ['before=1&after=2', 'before=-1', 'after=1.1', 'limit=101']) {
      expect((await app.inject(`/admin/agent-messaging/conferences/${ID}/messages?${query}`)).statusCode).not.toBe(200);
    }
    for (const ids of [[], Array.from({ length: 101 }, () => ID)]) {
      expect((await app.inject({ method: 'POST', url: `/admin/agent-messaging/conferences/${ID}/reveal`, payload: { message_ids: ids } })).statusCode).not.toBe(200);
    }
    expect(read).not.toHaveBeenCalled(); expect(reveal).not.toHaveBeenCalled();
  });
});
