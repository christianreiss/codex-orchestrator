import type { Database } from '../db/client.js';
import { adminEvents } from '../db/schema.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';

/**
 * Audit-log writer for the admin layer. Every admin mutation goes through
 * here: first a row is persisted to `admin_events` (durable), then the same
 * type+payload is published on the in-process WebSocket bus so connected
 * frontends invalidate the relevant queries immediately.
 */
export interface AdminEventInput {
  type: string;
  hostId?: number | null;
  payload?: Record<string, unknown>;
}

export class AdminEventsService {
  constructor(private readonly db: Database) {}

  /**
   * Persist an audit row + broadcast a matching WS event. Returns the
   * createdAt timestamp so callers can include it in responses if needed.
   */
  async record(input: AdminEventInput, options: { broadcast?: boolean } = {}): Promise<{ createdAt: string }> {
    const type = (input.type ?? '').trim() || 'event';
    const createdAt = nowIso();
    const payload = input.payload ?? {};

    await this.db.insert(adminEvents).values({
      type,
      hostId: input.hostId ?? null,
      payload: Object.keys(payload).length > 0 ? payload : null,
      createdAt,
    });

    if (options.broadcast !== false) {
      wsPublisher.publish(type, payload);
    }

    return { createdAt };
  }
}

export function createAdminEventsService(db: Database): AdminEventsService {
  return new AdminEventsService(db);
}
