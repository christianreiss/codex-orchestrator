/**
 * Canonical event-type catalog for the admin WebSocket. The frontend's
 * `lib/ws/events.ts` is the consumer; keep these strings in lock-step.
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

  // Authoring
  'agents.stored',
  'skill.updated',
  'skill.stored',
  'skill.deleted',
  'memory.changed',
  'memory.created',
  'memory.deleted',

  // API keys
  'api-key.changed',
  'apikey.created',
  'apikey.toggled',
  'apikey.deleted',

  // Settings
  'settings.changed',

  // Usage
  'usage.refreshed',
  'usage.refresh',
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
] as const;

export type WsEventType = (typeof WS_EVENT_TYPES)[number];

export interface WsEvent<P = unknown> {
  type: WsEventType | string;
  payload: P;
  ts: string;
}
