import { wsPublisher } from '../ws/publisher.js';
import type { WsEventType } from '../ws/events.js';

/**
 * Thin wrapper around `wsPublisher.publish` that other services use to emit
 * admin WebSocket events without touching the publisher singleton directly.
 *
 * Every publish goes through `wsPublisher.publish(type, payload)`; this module
 * just gives mutation paths a typed, intention-revealing call site:
 *
 *   publishHostEvent('host.updated', host.id, { config_version });
 *
 * If/when the WS transport is swapped out (e.g. NATS, Redis pub/sub) the
 * publisher singleton changes; callers stay put.
 */

export type HostEventType = Extract<WsEventType, `host.${string}`>;
export type UserEventType = Extract<WsEventType, `user.${string}`>;
export type ProjectEventType = Extract<WsEventType, `project.${string}`>;
export type SkillEventType = Extract<WsEventType, `skill.${string}`>;
export type MemoryEventType = Extract<WsEventType, `memory.${string}`>;
export type ApiKeyEventType = Extract<WsEventType, `apikey.${string}` | 'api-key.changed'>;

interface HostEventPayload {
  id: number;
  config_version?: number;
  [k: string]: unknown;
}

/**
 * Publish a `host.*` event. Always includes `id`; extra fields (e.g.
 * `config_version`) are stitched into the payload.
 */
export function publishHostEvent(
  type: HostEventType,
  hostId: number,
  extra: Omit<HostEventPayload, 'id'> = {},
): void {
  wsPublisher.publish<HostEventPayload>(type, { id: hostId, ...extra });
}

interface UserEventPayload {
  id: number;
  [k: string]: unknown;
}

export function publishUserEvent(
  type: UserEventType,
  userId: number,
  extra: Omit<UserEventPayload, 'id'> = {},
): void {
  wsPublisher.publish<UserEventPayload>(type, { id: userId, ...extra });
}

interface ProjectEventPayload {
  id?: number | string;
  [k: string]: unknown;
}

export function publishProjectEvent(
  type: ProjectEventType,
  payload: ProjectEventPayload,
): void {
  wsPublisher.publish<ProjectEventPayload>(type, payload);
}

interface SettingsChangedPayload {
  key?: string;
  [k: string]: unknown;
}

export function publishSettingsChanged(payload: SettingsChangedPayload = {}): void {
  wsPublisher.publish<SettingsChangedPayload>('settings.changed', payload);
}

/**
 * Escape hatch for event types not covered above. Same effect as calling
 * `wsPublisher.publish` directly; keep call sites here so a future transport
 * swap is a one-file change.
 */
export function publishEvent<P>(type: WsEventType | string, payload: P): void {
  wsPublisher.publish(type, payload);
}
