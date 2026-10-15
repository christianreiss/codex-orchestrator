import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { registerAgentMessagingRoutes } from '../../../src/routes/agent-messaging/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { AGENT_MESSAGING_TOOLS } from '../../../src/services/agent-messaging-tool-names.js';
import { registerCapabilityStack } from '../../helpers/capability-stack.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

it('retires call endpoints and tools while keeping direct messages and conferences', async () => {
  const app = Fastify();
  try {
    await registerCapabilityStack(app, { role: null });
    await registerAgentMessagingRoutes(app, {
      db: createDbFake(), env: loadTestEnv(), keyring: testKeyring(),
    } as unknown as RouteContext);
    await app.ready();
    const prefix = '/host/agent-sessions/:id/agent-messaging';
    for (const path of ['call/open', 'call/join']) {
      expect(app.hasRoute({ method: 'POST', url: `${prefix}/${path}` })).toBe(false);
      const response = await app.inject({ method: 'POST', url: `${prefix.replace(':id', '11111111-1111-4111-8111-111111111111')}/${path}`, payload: {} });
      expect(response.statusCode).toBe(404);
    }
    for (const path of ['send', 'reply', 'conf/open', 'conf/join']) {
      expect(app.hasRoute({ method: 'POST', url: `${prefix}/${path}` })).toBe(true);
    }
    expect(AGENT_MESSAGING_TOOLS).not.toContain('agent_call_open');
    expect(AGENT_MESSAGING_TOOLS).not.toContain('agent_call_join');
  } finally {
    await app.close();
  }
});
