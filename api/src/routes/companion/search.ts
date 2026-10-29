import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RouteContext } from '../index.js';
import { capabilitiesForRole, type Capability } from '../../security/capabilities.js';
import { createAdminEventsService } from '../../services/admin-events.js';
import { SlidingWindowLimiter } from '../../services/agent-room-chat/annotations.js';
import {
  ConversationSearch,
  searchConversations,
  searchQuerySchema,
  type SearchDeps,
} from '../../services/conversation-search.js';

export interface CompanionSearchDeps {
  auth(
    req: FastifyRequest,
    capability?: Capability,
  ): Promise<{ user: { id: number; name: string; accessLevel: string }; device: { id: string } }>;
  rooms: SearchDeps['rooms'];
  portal: SearchDeps['portal'];
  /** Physical portal session id -> the conversation id this operator's app uses. */
  aliases(userId: number, sessions: Array<Record<string, unknown>>): Promise<ReadonlyMap<string, string>>;
}

/**
 * `GET /companion/v1/search`: bounded scan over readable rooms and direct chats. The query
 * text is never logged (request logging is off) and never audited; only counts are.
 */
export function registerCompanionSearch(app: FastifyInstance, ctx: RouteContext, deps: CompanionSearchDeps) {
  const search = new ConversationSearch(ctx.db, ctx.keyring);
  const audit = createAdminEventsService(ctx.db);
  const limit = new SlidingWindowLimiter(20, 60_000, 'Too many searches. Try again in a minute.');
  app.get('/companion/v1/search', async (req) => {
    const { user, device } = await deps.auth(req, 'agent_messaging.reveal_content');
    const query = searchQuerySchema.parse(req.query);
    limit.take(`device:${device.id}`);
    const capabilities = capabilitiesForRole(user.accessLevel);
    const result = await searchConversations(
      { search, rooms: deps.rooms, portal: deps.portal },
      { adminId: user.id, name: user.name },
      query,
      { rooms: true, direct: capabilities.includes('agent_portal.reveal_transcript') },
      (sessions) => deps.aliases(user.id, sessions),
    );
    await audit.record(
      {
        type: 'conversation_search.performed',
        payload: {
          admin_user_id: user.id,
          surface: 'companion',
          scope: query.scope,
          scopes: result.scopes,
          results: result.results.length,
          truncated: result.truncated,
        },
      },
      { broadcast: false },
    );
    return result;
  });
}
