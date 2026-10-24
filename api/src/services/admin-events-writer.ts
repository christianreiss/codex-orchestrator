/**
 * Minimal audit-log writer for the admin events table.
 *
 * Every admin-side mutation should:
 *   1. Persist an `admin_events` row (audit-first).
 *   2. Publish the matching WS event so connected admin sockets refresh.
 *
 * `appendAndPublish` does both in that order. The DB write happens first so a
 * crash between the two leaves the audit trail intact. WS publish is fire-
 * and-forget; failures are logged but never thrown.
 */
import type { Database } from '../db/client.js';
import { adminEvents } from '../db/schema.js';
import { wsPublisher } from '../ws/publisher.js';
import type { WsEventType } from '../ws/events.js';
import { nowIso } from '../util/timestamp.js';
import { ownerRuntimeFor, mutateOwnerState } from '../control-plane/state/runtime.js';

export interface AdminEventRecord {
  id: number;
  type: string;
  hostId: number | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface AdminEventsWriter {
  withDb?(db: Database): AdminEventsWriter;
  append(
    type: string,
    payload: Record<string, unknown>,
    hostId?: number | null,
  ): Promise<AdminEventRecord>;
  appendAndPublish(
    type: string,
    payload: Record<string, unknown>,
    options?: {
      hostId?: number | null;
      wsType?: WsEventType | string;
      wsPayload?: Record<string, unknown>;
    },
  ): Promise<AdminEventRecord>;
}

export function makeAdminEventsWriter(db: Database): AdminEventsWriter {
  async function append(
    type: string,
    payload: Record<string, unknown>,
    hostId: number | null = null,
  ): Promise<AdminEventRecord> {
    const cleanedType = type.trim() || 'event';
    const createdAt = nowIso();
    const json = Object.keys(payload).length > 0 ? payload : null;
    const owner=ownerRuntimeFor(db);
    if(owner)return await mutateOwnerState(owner,{kind:'admin.audit.append',payload:{type:cleanedType,hostId},prepare(ctx){
      let id=0;ctx.write(async tx=>{const [inserted]=await tx.insert(adminEvents).values({type:cleanedType,hostId,payload:json,createdAt});id=Number(inserted.insertId);if(!Number.isSafeInteger(id)||id<1)throw new Error('Audit insert returned no identity');ctx.draft.upsert('versions',{name:'owner_admin_event_id',version:String(id),updatedAt:createdAt});});
      return ()=>JSON.parse(JSON.stringify({id,type:cleanedType,hostId,payload:json,createdAt})) as import('../control-plane/commands.js').Json;
    }}) as unknown as AdminEventRecord;
    const result = await db
      .insert(adminEvents)
      .values({
        type: cleanedType,
        hostId: hostId ?? null,
        payload: json as unknown,
        createdAt,
      });
    // mysql2 returns [{ insertId, affectedRows }]
    const insertId =
      Array.isArray(result) && result[0] && typeof (result[0] as { insertId?: number }).insertId === 'number'
        ? (result[0] as { insertId: number }).insertId
        : 0;
    return {
      id: insertId,
      type: cleanedType,
      hostId,
      payload: json,
      createdAt,
    };
  }

  async function appendAndPublish(
    type: string,
    payload: Record<string, unknown>,
    options: {
      hostId?: number | null;
      wsType?: WsEventType | string;
      wsPayload?: Record<string, unknown>;
    } = {},
  ): Promise<AdminEventRecord> {
    const record = await append(type, payload, options.hostId ?? null);
    const evType = options.wsType ?? type;
    const evPayload = options.wsPayload ?? { ...payload, event_id: record.id };
    try {
      wsPublisher.publish(evType, evPayload);
    } catch {
      /* publishing must never fail the request */
    }
    return record;
  }

  return { append, appendAndPublish, withDb: makeAdminEventsWriter };
}
