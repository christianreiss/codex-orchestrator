import { mutateOwnerState, ownerRuntimeFor } from '../control-plane/state/runtime.js';
import { adminAudit } from '../control-plane/state/admin.js';
import { desc } from 'drizzle-orm';
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

    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      await mutateOwnerState(owner, { kind: 'admin.audit.record', payload: { type, hostId: input.hostId ?? null }, prepare(ctx) {
        adminAudit(ctx, type, payload, createdAt, input.hostId ?? null); return null;
      } });
      if (options.broadcast !== false) wsPublisher.publish(type, payload);
      return { createdAt };
    }
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

  /**
   * Return the id of the most recent admin_events row, or null when the table
   * is empty. Used by `/admin/ws/info` so reconnecting clients can resume.
   */
  async latestEventId(): Promise<number | null> {
    const owner = ownerRuntimeFor(this.db);
    if (owner) { owner.assertOwner(); const raw = owner.state.snapshot().setting('owner_admin_event_id'); return raw ? Number(raw) : null; }
    const rows = await this.db
      .select({ id: adminEvents.id })
      .from(adminEvents)
      .orderBy(desc(adminEvents.id))
      .limit(1);
    const row = rows[0];
    return row ? Number(row.id) : null;
  }
}

export function createAdminEventsService(db: Database): AdminEventsService {
  return new AdminEventsService(db);
}
