/**
 * Canonical event-type catalog for the admin WebSocket. The frontend's
 * `lib/ws/events.ts` is the consumer; keep these strings in lock-step.
 *
 * `api/test/unit/ws/event-invalidation-coverage.test.ts` enforces both
 * directions: every type published from a `wsPublisher.publish(` site under
 * `api/src` has to appear here, and every entry here has to be either published
 * or routed by the frontend's `DEFAULT_INVALIDATIONS`.
 */
export const WS_EVENT_TYPES = [
  // Logs
  'log.created',
  'log.updated',
  'mcp.invoked',

  // Hosts
  'host.updated',
  'host.created',
  'host.deleted',
  'host.pruned',
  'host.force_delete_ip_mismatch',

  // Users
  'user.updated',
  'user.created',
  'user.deleted',
  'admin.user.wipe',

  // Projects
  'project.changed',
  'project.updated',
  'project.created',
  'project.deleted',
  'project.note.created',
  'project.note.updated',
  'project.note.deleted',
  'project.todo.created',
  'project.todo.updated',
  'project.todo.deleted',
  'project.file.upserted',
  'project.file.updated',
  'project.file.deleted',
  'project.feedback.created',
  // Project board. Per-entity rather than one `project.board.changed`, because
  // the SPA routes `project.*` by prefix and a single type would bypass
  // `projectDetailSubKey` and invalidate the whole project on every card move.
  'project.card.created',
  'project.card.updated',
  'project.card.moved',
  'project.card.claimed',
  'project.card.released',
  'project.card.deleted',
  'project.board.updated',
  'project_board.module_toggled',
  'project_board.claim_force_released',
  'project.memory.created',
  'project.memory.updated',
  'project.memory.deleted',

  // Authoring
  'agents.stored',
  'skill.updated',
  'skill.stored',
  'skill.deleted',
  'memory.changed',
  'memory.created',
  'memory.updated',
  'memory.appended',
  'memory.deleted',
  'shared_memory.changed',
  'shared_memory.created',
  'shared_memory.updated',
  'shared_memory.appended',
  'shared_memory.deleted',
  'claude_artifact.stored',
  'claude_artifact.updated',
  'claude_artifact.deleted',

  // API keys
  'api-key.changed',
  'apikey.created',
  'apikey.toggled',
  'apikey.deleted',

  // Fleet secrets. `secret.revealed` is deliberately absent: it is recorded
  // with `broadcast: false`, because a human reading a credential is an audit
  // fact and not a reason to nudge anything into re-fetching.
  'secret.created',
  'secret.updated',
  'secret.deleted',
  'secret.module_toggled',

  // Settings
  'settings.changed',

  // Agent portal
  'agent_portal.state',
  'agent_portal.user.created',
  'agent_portal.user.updated',
  'agent_portal.user.enabled',
  'agent_portal.user.rotated',
  'agent_portal.user.link_revealed',
  'agent_portal.user.deleted',

  // Agent messaging
  'agent_messaging.state.changed',
  'agent_messaging.host.changed',
  'agent_messaging.address.changed',
  'agent_messaging.conversation.changed',
  'agent_messaging.conference.changed',
  'agent_messaging.message.changed',
  'agent_messaging.relay.changed',
  'agent_messaging.queue.changed',

  // Git Director. One type for every change — a clone appearing, a worktree
  // registering or expiring, a verdict, a release — because the console renders
  // them as one live view and splitting the type would only make the frontend
  // invalidate the same query key from five places.
  'git_director.changed',
  // The two operator actions, which are audit facts as well as view changes.
  'git_director.module_toggled',
  'git_director.decision_forced',
  'git_director.worktree_evicted',

  // Usage
  'chatgpt.usage.updated',
  'claude.usage.updated',
  'insecure.approval.changed',

  // Account
  'passkey.registered',
  'passkey.deleted',

  // Insecure window
  'insecure.requested',
  'insecure.approved',
  'insecure.denied',
  'insecure.domain.allowed',
  'insecure.domain.revoked',

  // Notifications
  'toast',
] as const;

export type WsEventType = (typeof WS_EVENT_TYPES)[number];

export interface WsEvent<P = unknown> {
  type: WsEventType | string;
  payload: P;
  ts: string;
}
