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
