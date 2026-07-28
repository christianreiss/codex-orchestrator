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

  // Settings
  'settings.changed',

  // Usage
  'chatgpt.usage.updated',
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
