import { deriveCanonicalBodyProof } from './canonical-metadata.js';
import {
  emptyCompanionEventIndex,
  COMPANION_REPLY_INDEX_LIMIT,
  type CompanionEventType,
  type CompanionEventIndex,
} from './companion-index.js';
import { hydrateMessagingTotals } from './messaging-totals.js';
import { emptyRoomHead, type RoomHead } from './room-heads.js';
import { parseRoleManifest } from '../../services/roles/contract.js';
import { boundedProjectEvents, type ProjectEventMetadata } from './project-history.js';
import type { Keyring } from '../../security/keyring.js';
import { decrypt } from '../../security/secret-box.js';
import { desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { AnyMySqlColumn } from 'drizzle-orm/mysql-core';
import type { Database } from '../../db/client.js';
import * as schema from '../../db/schema.js';
import {
  assertSchemaCoverage,
  OWNED_TABLE_NAMES,
  stateColumns,
  workingSetPredicate,
  type OwnedTableName,
  type StateSeed,
} from './catalog.js';
import {
  OwnerStateSnapshot,
  OwnerStateStore,
  DEFAULT_OWNER_STATE_LIMITS,
  type OwnerStateLimits,
  type StateRevision,
} from './store.js';

export type HydrationLimits = OwnerStateLimits;
export const DEFAULT_HYDRATION_LIMITS = DEFAULT_OWNER_STATE_LIMITS;
export interface HydrationStats {
  readonly rows: number;
  readonly metadataBytes: number;
  readonly tables: Readonly<Record<string, number>>;
}

/**
 * Caller holds the exclusive owner connection and a consistent read transaction.
 * This function is boot/recovery only, never a request fallback or a timer.
 * Limits refuse readiness, rather than quietly forgetting durable obligations.
 */
export async function hydrateOwnerState(
  transaction: Pick<Database, 'select'>,
  revision: StateRevision,
  overrides: Partial<HydrationLimits> & { keyring?: Keyring } = {},
): Promise<{ store: OwnerStateStore; stats: HydrationStats }> {
  assertSchemaCoverage();
  const { keyring, ...limitOverrides } = overrides;
  const limits = { ...DEFAULT_HYDRATION_LIMITS, ...limitOverrides };
  for (const [name, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid state hydration limit ${name}`);
  const seed: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  let totalRows = 0;
  let metadataBytes = 0;
  for (const name of OWNED_TABLE_NAMES) {
    const columns: Record<string, AnyMySqlColumn | SQL> = stateColumns(name);
    if (name === 'hosts') {
      // Legacy cleartext credentials never cross the persistence boundary.
      columns.credentialLookupHash = sql<string>`COALESCE(NULLIF(${schema.hosts.apiKeyHash}, ''), SHA2(${schema.hosts.apiKey}, 256))`;
      columns.registrationAt = sql<
        string | null
      >`(SELECT MAX(l.created_at) FROM logs l WHERE l.host_id = ${schema.hosts.id} AND l.action IN ('host.created','host.rotated'))`;
      columns.authFingerprint = sql<string>`SHA2(COALESCE(NULLIF(${schema.hosts.apiKeyHash}, ''), ${schema.hosts.apiKey}), 256)`;
    }
    if (name === 'sharedMemories') {
      columns.contentPreview = sql<string>`LEFT(${schema.sharedMemories.content},400)`;
      columns.highestRevision = sql<number>`GREATEST(${schema.sharedMemories.revision},COALESCE((SELECT MAX(c.revision) FROM shared_memory_chunks c WHERE c.memory_id=${schema.sharedMemories.id}),0),COALESCE((SELECT MAX(r.revision) FROM shared_memory_revisions r WHERE r.memory_id=${schema.sharedMemories.id}),0))`;
    }
    if (name === 'coordProjectNotes') {
      columns.bodyPreview = sql<string>`LEFT(${schema.coordProjectNotes.body},280)`;
      columns.bodyLength = sql<number>`(OCTET_LENGTH(CONVERT(${schema.coordProjectNotes.body} USING utf16))/2)`;
    }
    if (name === 'coordProjectMemories') {
      columns.contentPreview = sql<string>`LEFT(${schema.coordProjectMemories.content},280)`;
      columns.contentLength = sql<number>`(OCTET_LENGTH(CONVERT(${schema.coordProjectMemories.content} USING utf16))/2)`;
    }
    if (name === 'coordProjectFiles') {
      columns.sizeBytes = sql<number>`OCTET_LENGTH(${schema.coordProjectFiles.content})`;
      columns.contentTail = sql<string>`RIGHT(${schema.coordProjectFiles.content},2)`;
    }
    if (name === 'companionDevices')
      columns.pushTokenDigest = sql<string | null>`SHA2(${schema.companionDevices.fcmTokenEnc}, 256)`;
    if (name === 'agentRoleVersions') columns.manifest = schema.agentRoleVersions.manifest;
    if (name === 'adminUsers')
      columns.credentialDigest = sql<string>`SHA2(${schema.adminUsers.passwordHash}, 256)`;
    const rows = await transaction
      .select(columns)
      .from(schema[name])
      .where(workingSetPredicate(name))
      .limit(limits.rowsPerTable + 1);
    if (name === 'agentRoleVersions')
      for (const row of rows) {
        const role = ((seed.agentRoles ?? []) as Array<{ id: string; slug: string }>).find(
          (role) => role.id === row.roleId,
        );
        try {
          row.roleLabel = role ? parseRoleManifest(role.slug, row.manifest).label : null;
        } catch {
          row.roleLabel = null;
        }
        delete row.manifest;
      }
    if (rows.length > limits.rowsPerTable) throw new Error(`Owner hydration exceeds row limit for ${name}`);
    totalRows += rows.length;
    if (totalRows > limits.totalRows) throw new Error('Owner hydration exceeds total row limit');
    metadataBytes += Buffer.byteLength(
      JSON.stringify(rows, (_, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)),
    );
    if (metadataBytes > limits.metadataBytes) throw new Error('Owner hydration exceeds metadata byte limit');
    seed[name] = rows;
    counts[name] = rows.length;
  }
  {
    const e = schema.agentRoomEvents;
    const counts = await transaction
      .select({
        roomId: e.roomId,
        actor: e.actor,
        count: sql<number>`COUNT(*)`,
        lastAt: sql<string>`MAX(${e.createdAt})`,
      })
      .from(e)
      .groupBy(e.roomId, e.actor)
      .limit(limits.totalRows + 1);
    if (counts.length > limits.totalRows)
      throw new Error('Owner hydration exceeds room actor metadata limit');
    const rooms = new Map(
      ['agentBusGroups', 'agentBusConferences', 'agentScopes']
        .flatMap((name) => (seed[name] ?? []) as Array<Record<string, unknown>>)
        .map((row) => [row.id, row]),
    );
    for (const count of counts) {
      const room = rooms.get(count.roomId);
      if (!room) continue;
      const head = (room.roomHead ??= emptyRoomHead()) as RoomHead,
        n = Number(count.count);
      head.eventCount += n;
      head.actorCounts[count.actor] = n;
      if (!head.lastAt || count.lastAt > head.lastAt) head.lastAt = count.lastAt;
    }
    const r = schema.agentRoomReads;
    const reads = await transaction
      .select({
        roomId: r.roomId,
        adminId: r.adminId,
        unreadCount: sql<number>`(SELECT COUNT(*) FROM agent_room_events e WHERE BINARY e.room_id=BINARY ${r.roomId} AND e.created_at>${r.readAt} AND e.actor<>CONCAT('admin:',${r.adminId}))`,
      })
      .from(r)
      .limit(limits.rowsPerTable + 1);
    if (reads.length > limits.rowsPerTable)
      throw new Error('Owner hydration exceeds room read metadata limit');
    const readMap = new Map(reads.map((row) => [row.roomId + ':' + row.adminId, Number(row.unreadCount)]));
    for (const row of (seed.agentRoomReads as Array<Record<string, unknown>>) ?? [])
      row.unreadCount = readMap.get(row.roomId + ':' + row.adminId) ?? 0;
    totalRows += counts.length;
    metadataBytes +=
      Buffer.byteLength(JSON.stringify([...rooms.values()].map((row) => row.roomHead))) +
      Buffer.byteLength(JSON.stringify(reads));
    if (totalRows > limits.totalRows || metadataBytes > limits.metadataBytes)
      throw new Error('Owner hydration exceeds room metadata bounds');
  }
  if (seed.coordProjects?.length) {
    const e = schema.coordProjectEvents;
    const rows = await transaction
      .select({
        id: e.id,
        projectId: e.projectId,
        seq: e.seq,
        eventType: e.eventType,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId,
        payloadJson: sql<Record<
          string,
          unknown
        > | null>`CASE WHEN OCTET_LENGTH(${e.payloadJson})<=16384 THEN ${e.payloadJson} ELSE JSON_OBJECT('_owner_payload_omitted',true) END`,
        sourceHostId: e.sourceHostId,
        createdAt: e.createdAt,
      })
      .from(e)
      .where(
        sql`(SELECT COUNT(*) FROM coord_project_events newer WHERE newer.project_id=${e.projectId} AND newer.seq>${e.seq})<20 OR (${e.entityType}='card' AND ${e.action}='claim_expired' AND (SELECT COUNT(*) FROM coord_project_events newer WHERE newer.project_id=${e.projectId} AND newer.entity_type='card' AND newer.action='claim_expired' AND newer.seq>${e.seq})<10)`,
      )
      .limit(limits.totalRows + 1);
    if (rows.length > limits.totalRows)
      throw new Error('Owner hydration exceeds project event metadata limit');
    const projects = new Map(
      (seed.coordProjects as Array<Record<string, unknown>>).map((row) => [row.id, row]),
    );
    for (const raw of rows) {
      const project = projects.get(raw.projectId);
      if (!project) continue;
      const event = {
        ...raw,
        id: Number(raw.id),
        seq: Number(raw.seq),
        payloadJson: typeof raw.payloadJson === 'string' ? JSON.parse(raw.payloadJson) : raw.payloadJson,
      } as ProjectEventMetadata;
      project.recentEvents = [...((project.recentEvents as ProjectEventMetadata[]) ?? []), event];
    }
    for (const project of projects.values())
      project.recentEvents = boundedProjectEvents((project.recentEvents as ProjectEventMetadata[]) ?? []);
    totalRows += rows.length;
    metadataBytes += Buffer.byteLength(JSON.stringify([...projects.values()].map((p) => p.recentEvents)));
    if (totalRows > limits.totalRows || metadataBytes > limits.metadataBytes)
      throw new Error('Owner hydration exceeds project metadata bounds');
  }
  if (seed.agentBusConversations?.length) {
    const cursors = await transaction
      .select({
        conversationId: schema.agentBusMessages.conversationId,
        targetAddressId: schema.agentBusMessages.targetAddressId,
        sequence: sql<number>`MAX(${schema.agentBusMessages.sequence})`,
      })
      .from(schema.agentBusMessages)
      .groupBy(schema.agentBusMessages.conversationId, schema.agentBusMessages.targetAddressId)
      .limit(limits.rowsPerTable * 2 + 1);
    if (cursors.length > limits.rowsPerTable * 2)
      throw new Error('Owner hydration exceeds conversation cursor limit');
    const conversations = new Map(
      (seed.agentBusConversations as Array<Record<string, unknown>>).map((row) => [row.id, row]),
    );
    for (const cursor of cursors) {
      const row = conversations.get(cursor.conversationId);
      if (!row) continue;
      const sequence = Number(cursor.sequence);
      if (!Number.isSafeInteger(sequence) || sequence < 0)
        throw new Error('Invalid durable conversation cursor');
      if (cursor.targetAddressId === row.addressAId) row.lastToASequence = sequence;
      if (cursor.targetAddressId === row.addressBId) row.lastToBSequence = sequence;
    }
    metadataBytes += seed.agentBusConversations.length * 64;
    if (metadataBytes > limits.metadataBytes)
      throw new Error('Owner hydration exceeds conversation cursor byte limit');
  }
  if (seed.agentSessions?.length) {
    const events = await transaction
      .select({
        sessionId: schema.agentEvents.sessionId,
        cursor: sql<number>`MAX(${schema.agentEvents.id})`,
        attention: sql<number>`COALESCE(MAX(CASE WHEN ${schema.agentEvents.eventType}='attention' THEN ${schema.agentEvents.id} END),0)`,
        cleared: sql<number>`COALESCE(MAX(CASE WHEN ${schema.agentEvents.eventType} IN ('user_message','close_requested','attention_resolved') THEN ${schema.agentEvents.id} END),0)`,
      })
      .from(schema.agentEvents)
      .groupBy(schema.agentEvents.sessionId)
      .limit(limits.rowsPerTable + 1);
    if (events.length > limits.rowsPerTable)
      throw new Error('Owner hydration exceeds portal event head limit');
    const sessions = new Map(
      (seed.agentSessions as Array<Record<string, unknown>>).map((row) => [row.id, row]),
    );
    const lastEvents = await transaction
      .select({
        id: schema.agentEvents.id,
        sessionId: schema.agentEvents.sessionId,
        type: schema.agentEvents.eventType,
        createdAt: schema.agentEvents.createdAt,
      })
      .from(schema.agentEvents)
      .where(
        sql`${schema.agentEvents.id}=(SELECT MAX(e.id) FROM agent_events e WHERE e.session_id=${schema.agentEvents.sessionId})`,
      )
      .limit(limits.rowsPerTable + 1);
    if (lastEvents.length > limits.rowsPerTable)
      throw new Error('Owner hydration exceeds portal latest event limit');
    for (const event of events) {
      const row = sessions.get(event.sessionId);
      if (row)
        Object.assign(row, {
          portalEventCursor: Number(event.cursor),
          portalAttentionCursor: Number(event.attention),
          portalAttentionClearedCursor: Number(event.cleared),
        });
    }
    for (const event of lastEvents) {
      const row = sessions.get(event.sessionId);
      if (row) Object.assign(row, { portalLastEventType: event.type, portalLastEventAt: event.createdAt });
    }
    metadataBytes +=
      Buffer.byteLength(JSON.stringify(events)) + Buffer.byteLength(JSON.stringify(lastEvents));
    if (metadataBytes > limits.metadataBytes)
      throw new Error('Owner hydration exceeds portal metadata byte limit');
  }
  if (seed.agentSessions?.length) {
    const sessions = new Map(
      (seed.agentSessions as Array<Record<string, unknown>>).map((row) => {
        row.companionEvents = emptyCompanionEventIndex();
        return [row.id, row];
      }),
    );
    const e = schema.agentEvents;
    const heads = await transaction
      .select({
        sessionId: e.sessionId,
        type: e.eventType,
        id: sql<number>`MAX(${e.id})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(e)
      .where(sql`${e.eventType} IN ('assistant_message','waiting_input','attention','session_named')`)
      .groupBy(e.sessionId, e.eventType)
      .limit(limits.totalRows + 1);
    if (heads.length > limits.totalRows) throw new Error('Owner hydration exceeds companion head limit');
    for (const head of heads) {
      const session = sessions.get(head.sessionId);
      if (!session) continue;
      const index = session.companionEvents as CompanionEventIndex;
      index.heads[head.type as CompanionEventType] = Number(head.id);
      if (head.type === 'assistant_message') index.assistantCount = Number(head.count);
    }
    const recent = await transaction
      .select({ sessionId: sql<string>`reply_index.session_id`, id: sql<number>`reply_index.id` })
      .from(
        sql`(SELECT id,session_id,ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id DESC) AS reply_rank FROM agent_events WHERE event_type='assistant_message') AS reply_index`,
      )
      .where(sql`reply_index.reply_rank<=${COMPANION_REPLY_INDEX_LIMIT}`)
      .limit(limits.totalRows + 1);
    if (recent.length > limits.totalRows)
      throw new Error('Owner hydration exceeds companion reply metadata limit');
    for (const event of recent) {
      const session = sessions.get(event.sessionId);
      if (session) (session.companionEvents as CompanionEventIndex).recentAssistantIds.push(Number(event.id));
    }
    for (const session of sessions.values())
      (session.companionEvents as CompanionEventIndex).recentAssistantIds.sort((a, b) => a - b);
    totalRows += heads.length + recent.length;
    metadataBytes += Buffer.byteLength(
      JSON.stringify([...sessions.values()].map((session) => session.companionEvents)),
    );
    if (totalRows > limits.totalRows || metadataBytes > limits.metadataBytes)
      throw new Error('Owner hydration exceeds companion index bounds');
  }
  if (seed.authPayloads?.length) {
    const payloads = seed.authPayloads as Array<Record<string, unknown>>;
    for (let start = 0; start < payloads.length; start += 200) {
      const batch = payloads.slice(start, start + 200),
        ids = batch.map((row) => Number(row.id));
      const bodies = await transaction
        .select()
        .from(schema.authPayloads)
        .where(inArray(schema.authPayloads.id, ids));
      const proofs = new Map(
        bodies.map((row) => [row.id, deriveCanonicalBodyProof(transaction, row, keyring)]),
      );
      for (const row of batch) row.canonicalBodyProof = proofs.get(Number(row.id)) ?? null;
      metadataBytes += Buffer.byteLength(JSON.stringify([...proofs]));
      if (metadataBytes > limits.metadataBytes)
        throw new Error('Owner canonical proof hydration exceeds metadata limit');
    }
  }
  const [portalHead] = await transaction
    .select({ id: schema.agentEvents.id, createdAt: schema.agentEvents.createdAt })
    .from(schema.agentEvents)
    .orderBy(desc(schema.agentEvents.id))
    .limit(1);
  if (portalHead) {
    const pointer = {
      name: 'owner_portal_event_id',
      version: String(portalHead.id),
      updatedAt: portalHead.createdAt,
    };
    seed.versions = [
      ...(seed.versions ?? []).filter((row) => (row as { name: string }).name !== pointer.name),
      pointer,
    ];
    totalRows++;
    metadataBytes += Buffer.byteLength(JSON.stringify(pointer));
    counts.versions = (counts.versions ?? 0) + 1;
  }
  if (keyring && seed.agentSessions?.length) {
    const names = await transaction
      .select({
        id: schema.agentEvents.id,
        sessionId: schema.agentEvents.sessionId,
        payload: schema.agentEvents.payloadEnc,
      })
      .from(schema.agentEvents)
      .where(
        sql`${schema.agentEvents.eventType} = 'session_named' AND ${schema.agentEvents.id} = (SELECT MAX(n.id) FROM agent_events n WHERE n.session_id = ${schema.agentEvents.sessionId} AND n.event_type = 'session_named')`,
      )
      .limit(limits.rowsPerTable + 1);
    if (names.length > limits.rowsPerTable) throw new Error('Owner hydration exceeds naming metadata limit');
    const sessions = new Map(
      (seed.agentSessions as Array<Record<string, unknown>>).map((row) => [row.id, row]),
    );
    for (const event of names) {
      const session = sessions.get(event.sessionId);
      if (!session) continue;
      try {
        const payload = JSON.parse(decrypt(event.payload, keyring)) as Record<string, unknown>;
        if (payload.native_session_id !== session.upstreamSessionId || typeof payload.name !== 'string')
          continue;
        const title = payload.name.slice(0, 160);
        Object.assign(session, {
          taskTitle: title,
          taskTitleNativeId: session.upstreamSessionId ?? null,
          taskTitleEventId: event.id,
        });
        metadataBytes += Buffer.byteLength(JSON.stringify([title, session.upstreamSessionId, event.id]));
        if (metadataBytes > limits.metadataBytes)
          throw new Error('Owner hydration exceeds naming metadata byte limit');
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Owner hydration exceeds')) throw error;
        // Optional malformed historical titles cannot hide a session.
      }
    }
  }
  if (seed.chattySessions?.length) {
    const heads = await transaction
      .select({
        userId: schema.chattySessions.userId,
        id: sql<number>`COALESCE(MAX(${schema.chattyEvents.id}), 0)`,
      })
      .from(schema.chattySessions)
      .leftJoin(
        schema.chattyEvents,
        sql`${schema.chattyEvents.userId} = ${schema.chattySessions.userId} AND ${schema.chattyEvents.generation} = ${schema.chattySessions.generation}`,
      )
      .groupBy(schema.chattySessions.userId);
    const byUser = new Map(heads.map((row) => [row.userId, Number(row.id)]));
    for (const row of seed.chattySessions as Array<Record<string, unknown>>)
      row.eventCursor = byUser.get(Number(row.userId)) ?? 0;
    metadataBytes += heads.length * 24;
    if (metadataBytes > limits.metadataBytes)
      throw new Error('Owner hydration exceeds Chatty cursor metadata limit');
  }
  // Preserve the pre-owner dashboard's last engine actor from durable audit.
  // New changes persist this small projection in versions; history stays cold.
  const settings = seed.versions ?? [];
  const actorKeys = new Set(settings.map((row) => String((row as { name: string }).name)));
  const missingActors = new Set(
    ['codex', 'claude', 'grok'].filter((engine) => !actorKeys.has(`owner_engine_actor_${engine}`)),
  );
  if (missingActors.size) {
    const audit = await transaction
      .select({ details: schema.logs.details, createdAt: schema.logs.createdAt })
      .from(schema.logs)
      .where(eq(schema.logs.action, 'admin.engine.state'))
      .orderBy(desc(schema.logs.id))
      .limit(50);
    for (const event of audit) {
      let value: { engine?: string; actor?: unknown };
      try {
        value = JSON.parse(event.details ?? '{}') as typeof value;
      } catch {
        continue;
      }
      if (!value.engine || !missingActors.delete(value.engine)) continue;
      const row = {
        name: `owner_engine_actor_${value.engine}`,
        version: typeof value.actor === 'string' ? value.actor : '',
        updatedAt: event.createdAt,
      };
      settings.push(row);
      totalRows++;
      metadataBytes += Buffer.byteLength(JSON.stringify(row));
      counts.versions = (counts.versions ?? 0) + 1;
    }
    seed.versions = settings;
    if (totalRows > limits.totalRows || metadataBytes > limits.metadataBytes)
      throw new Error('Owner hydration exceeds derived metadata limit');
  }
  const [logHead] = await transaction
    .select({ at: sql<string | null>`MAX(${schema.logs.createdAt})` })
    .from(schema.logs);
  if (logHead?.at) {
    const row = { name: 'owner_latest_log_at', version: logHead.at, updatedAt: logHead.at };
    seed.versions = [
      ...(seed.versions ?? []).filter((row) => (row as { name: string }).name !== 'owner_latest_log_at'),
      row,
    ];
    totalRows++;
    metadataBytes += Buffer.byteLength(JSON.stringify(row));
    counts.versions = (counts.versions ?? 0) + 1;
  }
  const [latestAudit] = await transaction
    .select({ id: schema.adminEvents.id, createdAt: schema.adminEvents.createdAt })
    .from(schema.adminEvents)
    .orderBy(desc(schema.adminEvents.id))
    .limit(1);
  if (latestAudit) {
    const pointer = {
      name: 'owner_admin_event_id',
      version: String(Math.max(Number(latestAudit.id), Number((seed.versions as Array<{ name: string; version: string }> | undefined)?.find(row => row.name === 'owner_admin_event_id')?.version ?? 0))),
      updatedAt: latestAudit.createdAt,
    };
    seed.versions = [
      ...(seed.versions ?? []).filter((row) => (row as { name: string }).name !== pointer.name),
      pointer,
    ];
    totalRows++;
    metadataBytes += Buffer.byteLength(JSON.stringify(pointer));
    counts.versions = (counts.versions ?? 0) + 1;
    if (totalRows > limits.totalRows || metadataBytes > limits.metadataBytes)
      throw new Error('Owner hydration exceeds derived metadata limit');
  }
  const messagingTotals = await hydrateMessagingTotals(transaction);
  metadataBytes += Buffer.byteLength(JSON.stringify(messagingTotals));
  totalRows += messagingTotals.bus.length + messagingTotals.portal.length + messagingTotals.responses.length;
  if (metadataBytes > limits.metadataBytes || totalRows > limits.totalRows)
    throw new Error('Owner hydration exceeds aggregate metadata limit');
  return {
    store: new OwnerStateStore(
      new OwnerStateSnapshot(revision, seed as StateSeed, undefined, undefined, messagingTotals),
      limits,
    ),
    stats: Object.freeze({ rows: totalRows, metadataBytes, tables: Object.freeze(counts) }),
  };
}

/** Explicit selection for tests and maintenance inspection; never includes payload bodies. */
export function ownerHydrationTables(): readonly OwnedTableName[] {
  return OWNED_TABLE_NAMES;
}
