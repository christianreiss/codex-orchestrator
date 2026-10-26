import { activeHistoryAddress, conversationHistoryWhere } from './selectors.js';
import { DEFAULT_SERVER_RETENTION, type ServerRetentionPolicy } from './policy.js';
import { projectRoomEventDeletion } from '../../control-plane/state/room-heads.js';
import { sql, type SQL } from 'drizzle-orm';
import type { RetentionProjection } from './projection.js';
import type { ConnectionPresence } from '../../control-plane/presence.js';
import type { RetentionFamily } from './deadlines.js';
import type { Database } from '../../db/client.js';
import { wsPublisher } from '../../ws/publisher.js';
import { protectedAddress, RETENTION_BATCH_SIZE } from './guards.js';
import { retentionFacts, scopeHistoryCandidates, ownerHistoryCandidates } from './ram.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Row = { id: string };

async function rows<R extends Row = Row>(tx: Tx, query: SQL): Promise<R[]> {
  const [result] = await tx.execute(query);
  return result as unknown as R[];
}

async function remove(tx: Tx, query: SQL): Promise<number> {
  const [result] = await tx.execute(query);
  return Number((result as unknown as { affectedRows: number }).affectedRows);
}

/** Lock current heartbeat evidence, so a concurrent reconnect wins or follows
 * the purge transaction; an earlier consistent-read snapshot is insufficient. */
async function contactsActive(
  tx: Tx,
  addresses: SQL,
  cutoff: string,
  presence?: ConnectionPresence,
): Promise<boolean> {
  const [result] = await tx.execute(sql`SELECT id, binding_generation, heartbeat_at FROM agent_sessions
    WHERE agent_bus_address_id IN (${addresses}) FOR UPDATE`);
  return (result as unknown as Array<{ id: string; binding_generation: number; heartbeat_at: string }>).some(
    (s) =>
      presence?.hasSession(s.id, s.binding_generation) || Date.parse(s.heartbeat_at) > Date.parse(cutoff),
  );
}

/** Bounded, periodic cleanup; independent of feature switches and host traffic. */
export class ServerRetentionService {
  constructor(
    private readonly db: Database,
    private readonly projection?: RetentionProjection,
    private readonly ownerTx?: Tx,
    private readonly presence?: ConnectionPresence,
    private readonly policy: ServerRetentionPolicy = { ...DEFAULT_SERVER_RETENTION },
  ) {}
  private activeAddress(id: SQL, cutoff: string): SQL {
    const addresses =
      this.projection?.draft
        .table('agentSessions')
        .all()
        .filter((session) => this.presence?.hasSession(session.id, session.bindingGeneration))
        .map((session) => session.agentBusAddressId)
        .filter((value): value is string => !!value) ?? [];
    return activeHistoryAddress(id, cutoff, addresses);
  }
  private transaction<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
    return this.ownerTx ? run(this.ownerTx) : this.db.transaction(run);
  }
  /** Called inside one serialized owner transaction; publication is caller-owned. */
  async purgeFamily(family: RetentionFamily, now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.policy.history_hours * 3600000).toISOString();
    switch (family) {
      case 'credentials':
        return this.credentials(now.toISOString());
      case 'relays':
        return this.relays(cutoff, now.toISOString());
      case 'conversations': {
        const result = await this.bus(cutoff);
        return result.conversations + result.messages;
      }
      case 'daemons':
        return this.daemons(cutoff);
      case 'chatty':
        return this.chatty(cutoff);
      case 'rooms':
        return this.rooms(cutoff);
      case 'addresses':
        return this.addresses(cutoff);
      default:
        throw new Error(`Portal retention family ${family} requires its portal handler`);
    }
  }

  async purge(now = new Date()): Promise<Record<string, number>> {
    const cutoff = new Date(now.getTime() - this.policy.history_hours * 3600000).toISOString();
    const timestamp = now.toISOString();
    const changed: Record<string, number> = {};
    // Each family commits separately. A crash retries only unfinished batches.
    changed.credentials = await this.credentials(timestamp);
    changed.relays = await this.relays(cutoff, timestamp);
    Object.assign(changed, await this.bus(cutoff));
    changed.daemon_sessions = await this.daemons(cutoff);
    changed.chatty = await this.chatty(cutoff);
    changed.rooms = await this.rooms(cutoff);
    changed.addresses = await this.addresses(cutoff);
    if (Object.values(changed).some(Boolean)) {
      wsPublisher.publish('agent_messaging.queue.changed', changed);
      if (changed.relays) wsPublisher.publish('agent_messaging.relay.changed', changed);
      wsPublisher.publish('agent_room_chat.changed', changed);
      wsPublisher.publish('agent_messaging.conference.changed', changed);
      wsPublisher.publish('host.daemon.changed', changed);
      wsPublisher.publish('chatty.changed', changed);
      wsPublisher.publish('agent_portal.sessions.changed', changed);
    }
    return changed;
  }

  private async credentials(now: string) {
    return this.transaction(async (tx) => {
      let count = 0;
      const state = this.projection?.draft.view();
      for (const table of ['mcp_session_tokens', 'admin_sessions', 'provider_account_sessions'] as const) {
        if (state && count >= 100) break;
        const ownership = table === 'provider_account_sessions' ? sql`AND ownership_mode = 'timed'` : sql``;
        const name = (
          {
            mcp_session_tokens: 'mcpSessionTokens',
            admin_sessions: 'adminSessions',
            provider_account_sessions: 'providerAccountSessions',
          } as const
        )[table];
        const ids = state
          ? state
              .table(name)
              .all()
              .filter((r) => r.expiresAt <= now && (!('ownershipMode' in r) || r.ownershipMode === 'timed'))
              .slice(0, 100 - count)
          : await rows(
              tx,
              sql`SELECT id FROM ${sql.identifier(table)} WHERE expires_at <= ${now} ${ownership} ORDER BY expires_at LIMIT 100 FOR UPDATE`,
            );
        if (ids.length)
          await tx.execute(
            sql`DELETE FROM ${sql.identifier(table)} WHERE id IN (${sql.join(
              ids.map((r) => sql`${r.id}`),
              sql`,`,
            )})`,
          );
        const names = {
          mcp_session_tokens: 'mcpSessionTokens',
          admin_sessions: 'adminSessions',
          provider_account_sessions: 'providerAccountSessions',
        } as const;
        const removed = new Set(ids.map((row) => String(row.id)));
        this.projection?.removeWhere(names[table], (row) => removed.has(String(row.id)));
        count += ids.length;
      }
      return count;
    });
  }

  private async relays(cutoff: string, now: string) {
    return this.transaction(async (tx) => {
      const state = this.projection?.draft.view();
      const expired = state
        ? ownerHistoryCandidates(state, cutoff, now, this.presence).relays()
        : await rows(
            tx,
            sql`SELECT r.id FROM agent_bus_relays r WHERE r.heartbeat_at <= ${cutoff}
        AND (r.token_expires_at IS NULL OR r.token_expires_at <= ${now})
        AND NOT EXISTS (SELECT 1 FROM agent_bus_messages m WHERE m.lease_owner LIKE CONCAT('relay:',r.id,':%')
          AND m.status IN ('leased','accepted','reboot_hold'))
        ORDER BY r.heartbeat_at LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`,
          );
      const deletable = expired.filter((row) => !this.presence?.hasRelay(row.id));
      if (deletable.length)
        await tx.execute(
          sql`DELETE FROM agent_bus_relays WHERE id IN (${sql.join(
            deletable.map((r) => sql`${r.id}`),
            sql`,`,
          )})`,
        );
      const removed = new Set(deletable.map((row) => row.id));
      this.projection?.removeWhere('agentBusRelays', (row) => removed.has(row.id));
      return deletable.length;
    });
  }

  private async bus(cutoff: string) {
    return this.transaction(async (tx) => {
      // All send/register/conference/schedule paths take this gate first.
      if (!this.projection)
        await tx.execute(sql`SELECT name FROM versions WHERE name = 'agent_messaging_enabled' FOR UPDATE`);
      const state = this.projection?.draft.view();
      const candidates = state
        ? ownerHistoryCandidates(state, cutoff, new Date().toISOString(), this.presence).conversations()
        : await rows(
            tx,
            sql`SELECT c.id FROM agent_bus_conversations c
        WHERE ${conversationHistoryWhere(
          cutoff,
          this.projection?.draft
            .table('agentSessions')
            .all()
            .filter((s) => this.presence?.hasSession(s.id, s.bindingGeneration))
            .map((s) => s.agentBusAddressId)
            .filter((id): id is string => !!id) ?? [],
        )}
        ORDER BY c.last_activity_at LIMIT 1 FOR UPDATE`,
          );
      let conversations = 0,
        deletedMessages = 0;
      for (const { id } of candidates) {
        if (
          !state &&
          (await contactsActive(
            tx,
            sql`SELECT address_a_id FROM agent_bus_conversations WHERE id = ${id}
          UNION SELECT address_b_id FROM agent_bus_conversations WHERE id = ${id}`,
            cutoff,
            this.presence,
          ))
        )
          continue;
        // Large threads drain a bounded message batch before their parent goes.
        const messages = await rows<{
          id: string;
          source_engine: string;
          target_engine: string;
          status: string;
        }>(
          tx,
          sql`SELECT id,source_engine,target_engine,status FROM agent_bus_messages WHERE conversation_id = ${id} LIMIT 100 FOR UPDATE`,
        );
        if (messages.length) {
          const ids = sql.join(
            messages.map((r) => sql`${r.id}`),
            sql`,`,
          );
          await tx.execute(sql`DELETE FROM agent_task_results WHERE message_id IN (${ids})`);
          await tx.execute(sql`DELETE FROM agent_fresh_start_grants WHERE message_id IN (${ids})`);
          await tx.execute(sql`DELETE FROM agent_schedule_runs WHERE message_id IN (${ids})`);
          await tx.execute(sql`DELETE FROM agent_room_deliveries WHERE message_id IN (${ids})`);
          await tx.execute(
            sql`UPDATE agent_bus_conference_members SET dispatch_message_id = NULL WHERE dispatch_message_id IN (${ids})`,
          );
          const removedIds = new Set(messages.map((row) => row.id));
          this.projection?.removeWhere('agentTaskResults', (row) => removedIds.has(row.messageId));
          this.projection?.removeWhere('agentFreshStartGrants', (row) => removedIds.has(row.messageId));
          this.projection?.removeWhere(
            'agentScheduleRuns',
            (row) => !!row.messageId && removedIds.has(row.messageId),
          );
          this.projection?.removeWhere(
            'agentRoomDeliveries',
            (row) => !!row.messageId && removedIds.has(row.messageId),
          );
          this.projection?.patchWhere(
            'agentBusConferenceMembers',
            (row) => !!row.dispatchMessageId && removedIds.has(row.dispatchMessageId),
            { dispatchMessageId: null },
          );
          this.projection?.draft.adjustMessagingTotals({
            bus: messages.map((row) => ({
              sourceEngine: row.source_engine,
              targetEngine: row.target_engine,
              status: row.status,
              count: -1,
            })),
          });
          this.projection?.removeWhere('agentBusMessages', (row) => removedIds.has(row.id));
          deletedMessages += await remove(tx, sql`DELETE FROM agent_bus_messages WHERE id IN (${ids})`);
        }
        if (state && messages.length >= 100) continue;
        await tx.execute(sql`UPDATE agent_bus_conference_members SET conversation_id = NULL WHERE conversation_id = ${id}
          AND NOT EXISTS (SELECT 1 FROM agent_bus_messages WHERE conversation_id = ${id})`);
        await tx.execute(sql`UPDATE advisor_sessions SET conversation_id = NULL WHERE conversation_id = ${id}
          AND NOT EXISTS (SELECT 1 FROM agent_bus_messages WHERE conversation_id = ${id})`);
        const removedConversation = await remove(
          tx,
          sql`DELETE FROM agent_bus_conversations WHERE id = ${id}
          AND NOT EXISTS (SELECT 1 FROM agent_bus_messages WHERE conversation_id = ${id})`,
        );
        conversations += removedConversation;
        if (removedConversation) {
          this.projection?.patchWhere('agentBusConferenceMembers', (row) => row.conversationId === id, {
            conversationId: null,
          });
          this.projection?.patchWhere('advisorSessions', (row) => row.conversationId === id, {
            conversationId: null,
          });
          this.projection?.removeWhere('agentBusConversations', (row) => row.id === id);
        }
      }
      return { conversations, messages: deletedMessages };
    });
  }

  private async daemons(cutoff: string) {
    return this.transaction(async (tx) => {
      if (!this.projection)
        await tx.execute(sql`SELECT name FROM versions WHERE name = 'agent_messaging_enabled' FOR UPDATE`);
      const state = this.projection?.draft.view();
      const disconnected = state
        ? []
        : await rows(
            tx,
            sql`SELECT d.id FROM host_daemon_sessions d
        WHERE ${!this.projection} AND d.last_activity_at <= ${cutoff} AND d.status IN ('queued','running','idle','waiting')
        AND NOT ${protectedAddress(sql`d.address_id`)} AND NOT ${this.activeAddress(sql`d.address_id`, cutoff)}
        AND NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = BINARY d.session_id AND s.heartbeat_at > ${cutoff})
        LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`,
          );
      for (const { id } of disconnected) {
        if (
          !state &&
          (await contactsActive(
            tx,
            sql`SELECT address_id FROM host_daemon_sessions WHERE id = ${id}`,
            cutoff,
            this.presence,
          ))
        )
          continue;
        // Loss of contact cannot prove a result. Never requeue accepted effects.
        await tx.execute(sql`UPDATE host_daemon_operations SET status = 'unknown', claim_id = NULL
          WHERE session_id = ${id} AND status IN ('accepted','running')`);
        await tx.execute(sql`UPDATE host_daemon_operations SET status = 'expired', claim_id = NULL
          WHERE session_id = ${id} AND status IN ('queued','offered')`);
        await tx.execute(sql`UPDATE host_daemon_sessions SET status = 'unknown' WHERE id = ${id}`);
        this.projection?.patchWhere(
          'hostDaemonOperations',
          (row) => row.sessionId === id && ['accepted', 'running'].includes(row.status),
          { status: 'unknown', claimId: null },
        );
        this.projection?.patchWhere(
          'hostDaemonOperations',
          (row) => row.sessionId === id && ['queued', 'offered'].includes(row.status),
          { status: 'expired', claimId: null },
        );
        this.projection?.patchWhere('hostDaemonSessions', (row) => row.id === id, { status: 'unknown' });
      }
      const candidates = state
        ? ownerHistoryCandidates(state, cutoff, new Date().toISOString(), this.presence).daemons()
        : await rows(
            tx,
            sql`SELECT d.id FROM host_daemon_sessions d WHERE d.last_activity_at <= ${cutoff}
        AND d.status IN ('closed','failed') AND NOT ${protectedAddress(sql`d.address_id`)}
        AND NOT ${this.activeAddress(sql`d.address_id`, cutoff)}
        AND NOT EXISTS (SELECT 1 FROM host_daemon_operations o WHERE o.session_id = BINARY d.id AND o.status IN ('queued','offered','accepted','running','unknown'))
        ORDER BY d.last_activity_at LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`,
          );
      let purged = 0;
      for (const { id } of candidates) {
        if (
          !state &&
          (await contactsActive(
            tx,
            sql`SELECT address_id FROM host_daemon_sessions WHERE id = ${id}`,
            cutoff,
            this.presence,
          ))
        )
          continue;
        await tx.execute(sql`UPDATE agent_chat_attachments SET status = 'retired' WHERE session_id = ${id}`);
        await tx.execute(sql`DELETE FROM advisor_sessions WHERE daemon_session_id = ${id}`);
        await tx.execute(sql`DELETE FROM companion_daemon_follows WHERE daemon_session_id = ${id}`);
        await tx.execute(sql`DELETE FROM host_daemon_portal_bindings WHERE daemon_session_id = ${id}`);
        await tx.execute(sql`DELETE FROM host_daemon_operations WHERE session_id = ${id}`);
        purged += await remove(tx, sql`DELETE FROM host_daemon_sessions WHERE id = ${id}`);
        this.projection?.patchWhere('agentChatAttachments', (row) => row.sessionId === id, {
          status: 'retired',
        });
        this.projection?.removeWhere('advisorSessions', (row) => row.daemonSessionId === id);
        this.projection?.removeWhere('companionDaemonFollows', (row) => row.daemonSessionId === id);
        this.projection?.removeWhere('hostDaemonPortalBindings', (row) => row.daemonSessionId === id);
        this.projection?.removeWhere('hostDaemonOperations', (row) => row.sessionId === id);
        this.projection?.removeWhere('hostDaemonSessions', (row) => row.id === id);
      }
      return purged;
    });
  }

  private async chatty(cutoff: string) {
    return this.transaction(async (tx) => {
      if (!this.projection)
        await tx.execute(sql`SELECT name FROM versions WHERE name = 'chatty_scheduler' FOR UPDATE`);
      const state = this.projection?.draft.view();
      // The scheduler uses the same unknown-on-lost-lease rule. This runs even
      // with Chatty disabled and keeps old claims from pinning history forever.
      let changed = 0;
      for (const [oldStatus, status] of (this.projection
        ? []
        : [
            ['running', 'unknown'],
            ['queued', 'cancelled'],
          ]) as Array<[string, string]>) {
        const candidates = await rows(
          tx,
          sql`SELECT id FROM chatty_runs WHERE status = ${oldStatus} AND updated_at <= ${cutoff}
          AND (${oldStatus} <> 'running' OR lease_until IS NULL OR lease_until <= ${cutoff}) LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`,
        );
        if (!candidates.length) continue;
        const ids = sql.join(
          candidates.map((row) => sql`${row.id}`),
          sql`,`,
        );
        await tx.execute(
          sql`UPDATE chatty_runs SET status = ${status}, claim_id = NULL, lease_until = NULL WHERE id IN (${ids})`,
        );
        const removed = new Set(candidates.map((row) => row.id));
        this.projection?.patchWhere('chattyRuns', (row) => removed.has(row.id), {
          status,
          claimId: null,
          leaseUntil: null,
        });
        changed += candidates.length;
      }
      const sessions = state
        ? ownerHistoryCandidates(state, cutoff, new Date().toISOString(), this.presence)
            .chatty()
            .map((s) => ({ id: String(s.userId) }))
        : await rows(
            tx,
            sql`SELECT user_id AS id FROM chatty_sessions s WHERE s.updated_at <= ${cutoff}
        AND (s.summary_enc IS NOT NULL OR EXISTS (SELECT 1 FROM chatty_runs x WHERE x.user_id = s.user_id) OR EXISTS (SELECT 1 FROM chatty_events x WHERE x.user_id = s.user_id))
        AND NOT EXISTS (SELECT 1 FROM chatty_runs r WHERE r.user_id = s.user_id AND (r.updated_at > ${cutoff} OR r.status IN ('queued','running','unknown')))
        AND NOT EXISTS (SELECT 1 FROM chatty_actions a WHERE a.user_id = s.user_id AND a.status IN ('executing','unknown'))
        AND NOT EXISTS (SELECT 1 FROM chatty_events e WHERE e.user_id = s.user_id AND e.created_at > ${cutoff})
        LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`,
          );
      for (const { id } of sessions) {
        // Keep the user's selection and advance generation to invalidate old forms.
        await tx.execute(sql`DELETE FROM chatty_actions WHERE user_id = ${id}`);
        await tx.execute(sql`DELETE FROM chatty_events WHERE user_id = ${id}`);
        await tx.execute(sql`DELETE FROM chatty_runs WHERE user_id = ${id}`);
        await tx.execute(
          sql`UPDATE chatty_sessions SET generation = generation + 1, summary_enc = NULL WHERE user_id = ${id}`,
        );
        this.projection?.removeWhere('chattyActions', (row) => String(row.userId) === String(id));
        this.projection?.removeWhere('chattyRuns', (row) => String(row.userId) === String(id));
        this.projection?.patchWhere(
          'chattySessions',
          (row) => String(row.userId) === String(id),
          (row) => ({ generation: row.generation + 1, eventCursor: 0 }),
        );
      }
      return sessions.length + changed;
    });
  }

  private async rooms(cutoff: string) {
    return this.transaction(async (tx) => {
      const state = this.projection?.draft.view(),
        facts = state ? retentionFacts(state, cutoff, this.presence) : undefined;
      if (!state)
        await tx.execute(sql`SELECT name FROM versions WHERE name = 'agent_messaging_enabled' FOR UPDATE`);
      const candidates =
        state && facts
          ? state
              .table('agentRoomEvents')
              .all()
              .filter((e) => e.createdAt <= cutoff && !facts.protectedRooms.has(e.roomId))
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
              .slice(0, 100)
          : await rows<Row & { roomId: string; actor: string; createdAt: string }>(
              tx,
              sql`SELECT e.id, e.room_id AS roomId, e.actor, e.created_at AS createdAt FROM agent_room_events e WHERE e.created_at <= ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM agent_room_events n WHERE n.room_id = e.room_id AND n.created_at > ${cutoff})
        AND NOT EXISTS (SELECT 1 FROM agent_bus_subscriptions b WHERE b.topic COLLATE utf8mb4_unicode_ci = (SELECT CONCAT('group:', g.slug) FROM agent_bus_groups g WHERE g.id = BINARY e.room_id)
          AND (${protectedAddress(sql`b.subscriber_address_id`)} OR ${this.activeAddress(sql`b.subscriber_address_id`, cutoff)}))
        AND NOT EXISTS (SELECT 1 FROM agent_bus_conference_members b WHERE b.conference_id = BINARY e.room_id
          AND (${protectedAddress(sql`b.address_id`)} OR ${this.activeAddress(sql`b.address_id`, cutoff)}))
        AND NOT EXISTS (SELECT 1 FROM agent_scope_members b JOIN agent_sessions s ON s.id = BINARY b.session_id WHERE b.scope_id = BINARY e.room_id AND s.heartbeat_at > ${cutoff})
        AND NOT EXISTS (SELECT 1 FROM agent_room_deliveries d JOIN agent_bus_messages m ON m.id = BINARY d.message_id
          WHERE d.event_id = BINARY e.id AND (m.status IN ('queued','leased','accepted','reboot_hold','batched','ambiguous') OR m.task_result_status='unknown'))
        ORDER BY e.created_at LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`,
            );
      const events: Array<Row & { roomId: string; actor: string; createdAt: string }> = [];
      for (const event of candidates) {
        if (state) {
          events.push(event);
          continue;
        }
        const active = await contactsActive(
          tx,
          sql`
          SELECT BINARY b.subscriber_address_id FROM agent_bus_subscriptions b JOIN agent_bus_groups g ON b.topic COLLATE utf8mb4_unicode_ci = CONCAT('group:', g.slug)
            JOIN agent_room_events e ON e.room_id = BINARY g.id WHERE e.id = ${event.id}
          UNION SELECT BINARY b.address_id FROM agent_bus_conference_members b JOIN agent_room_events e ON e.room_id = BINARY b.conference_id WHERE e.id = ${event.id}
          UNION SELECT BINARY s.agent_bus_address_id FROM agent_scope_members m JOIN agent_sessions s ON s.id = BINARY m.session_id
            JOIN agent_room_events e ON e.room_id = BINARY m.scope_id WHERE e.id = ${event.id}`,
          cutoff,
          this.presence,
        );
        if (!active) events.push(event);
      }
      if (events.length) {
        const ids = sql.join(
          events.map((r) => sql`${r.id}`),
          sql`,`,
        );
        await tx.execute(sql`DELETE FROM agent_room_deliveries WHERE event_id IN (${ids})`);
        await tx.execute(sql`DELETE FROM agent_room_events WHERE id IN (${ids})`);
        const removed = new Set(events.map((row) => String(row.id)));
        this.projection?.removeWhere('agentRoomDeliveries', (row) => removed.has(String(row.eventId)));
        if (this.projection) {
          const roomIds = sql.join(
            [...new Set(events.map((event) => event.roomId))].map((id) => sql`${id}`),
            sql`,`,
          );
          const remaining = state
            ? [...new Set(events.map((e) => e.roomId))].map((roomId) => ({
                roomId,
                lastAt: state
                  .table('agentRoomEvents')
                  .by('roomId', roomId)
                  .filter((e) => !removed.has(e.id))
                  .reduce<string | null>(
                    (last, e) => (last === null || e.createdAt > last ? e.createdAt : last),
                    null,
                  ),
              }))
            : ((
                await tx.execute(
                  sql`SELECT room_id AS roomId, MAX(created_at) AS lastAt FROM agent_room_events WHERE room_id IN (${roomIds}) GROUP BY room_id`,
                )
              )[0] as unknown as Array<{ roomId: string; lastAt: string | null }>);
          const last = new Map(remaining.map((row) => [row.roomId, row.lastAt]));
          for (const event of events)
            projectRoomEventDeletion(this.projection.draft, event, last.get(event.roomId) ?? null);
        }
      }
      const conferences =
        state && facts
          ? state
              .table('agentBusConferences')
              .all()
              .filter(
                (f) =>
                  f.status === 'adjourned' &&
                  (f.adjournedAt ?? f.createdAt) <= cutoff &&
                  !facts.blockedAddress(f.ownerAddressId) &&
                  !facts.protectedRooms.has(f.id) &&
                  !this.projection!.draft.table('agentRoomEvents').by('roomId', f.id).length,
              )
              .slice(0, Math.max(0, 100 - events.length))
          : await rows(
              tx,
              sql`SELECT f.id FROM agent_bus_conferences f WHERE f.status = 'adjourned'
        AND COALESCE(f.adjourned_at, f.created_at) <= ${cutoff}
        AND NOT ${protectedAddress(sql`f.owner_address_id`)} AND NOT ${this.activeAddress(sql`f.owner_address_id`, cutoff)}
        AND NOT EXISTS (SELECT 1 FROM agent_bus_conference_members m WHERE m.conference_id = BINARY f.id
          AND (${protectedAddress(sql`m.address_id`)} OR ${this.activeAddress(sql`m.address_id`, cutoff)}))
        AND NOT EXISTS (SELECT 1 FROM agent_room_events e WHERE e.room_id = BINARY f.id)
        LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`,
            );
      let purgedConferences = 0;
      for (const { id } of conferences) {
        if (
          !state &&
          (await contactsActive(
            tx,
            sql`SELECT owner_address_id FROM agent_bus_conferences WHERE id = ${id}
          UNION SELECT address_id FROM agent_bus_conference_members WHERE conference_id = ${id}`,
            cutoff,
            this.presence,
          ))
        )
          continue;
        await tx.execute(sql`UPDATE agent_chat_attachments SET status = 'retired' WHERE session_id = ${id}`);
        await tx.execute(sql`DELETE FROM agent_room_reads WHERE room_id = ${id}`);
        await tx.execute(sql`DELETE FROM agent_room_agent_reads WHERE room_id = ${id}`);
        await tx.execute(sql`DELETE FROM agent_bus_conference_members WHERE conference_id = ${id}`);
        purgedConferences += await remove(tx, sql`DELETE FROM agent_bus_conferences WHERE id = ${id}`);
        this.projection?.patchWhere('agentChatAttachments', (row) => row.sessionId === id, {
          status: 'retired',
        });
        this.projection?.removeWhere('agentRoomReads', (row) => row.roomId === id);
        this.projection?.removeWhere('agentBusConferenceMembers', (row) => row.conferenceId === id);
        this.projection?.removeWhere('agentBusConferences', (row) => row.id === id);
      }
      // Persistent room definitions remain; only their empty history loses files/read markers.
      const attachments = state
        ? state
            .table('agentChatAttachments')
            .all()
            .filter(
              (a) =>
                a.status !== 'retired' &&
                a.updatedAt <= cutoff &&
                (state.table('agentBusGroups').has(a.sessionId) ||
                  state.table('agentScopes').has(a.sessionId)) &&
                !this.projection!.draft.table('agentRoomEvents').by('roomId', a.sessionId).length,
            )
            .slice(0, Math.max(0, 100 - events.length - purgedConferences))
        : await rows(
            tx,
            sql`SELECT a.id FROM agent_chat_attachments a WHERE a.status <> 'retired' AND a.updated_at <= ${cutoff}
        AND (EXISTS (SELECT 1 FROM agent_bus_groups g WHERE g.id = BINARY a.session_id) OR EXISTS (SELECT 1 FROM agent_scopes s WHERE s.id = BINARY a.session_id))
        AND NOT EXISTS (SELECT 1 FROM agent_room_events e WHERE e.room_id = BINARY a.session_id) LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`,
          );
      if (attachments.length) {
        await tx.execute(
          sql`UPDATE agent_chat_attachments SET status = 'retired' WHERE id IN (${sql.join(
            attachments.map((row) => sql`${row.id}`),
            sql`,`,
          )})`,
        );
        const ids = new Set(attachments.map((row) => row.id));
        this.projection?.patchWhere('agentChatAttachments', (row) => ids.has(row.id), { status: 'retired' });
      }
      const scopeCandidates = state
        ? scopeHistoryCandidates(state, cutoff, this.presence).slice(
            0,
            Math.max(0, 100 - events.length - purgedConferences - attachments.length),
          )
        : await rows(
            tx,
            sql`SELECT id FROM agent_scope_events WHERE created_at <= ${cutoff} AND dispatched = 1
        AND NOT EXISTS (SELECT 1 FROM agent_scope_members m JOIN agent_sessions s ON s.id = BINARY m.session_id
          WHERE m.scope_id = BINARY agent_scope_events.scope_id AND (${this.activeAddress(sql`s.agent_bus_address_id`, cutoff)} OR s.heartbeat_at > ${cutoff} OR ${protectedAddress(sql`s.agent_bus_address_id`)}))
        LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`,
          );
      if (scopeCandidates.length) {
        await tx.execute(
          sql`DELETE FROM agent_scope_events WHERE id IN (${sql.join(
            scopeCandidates.map((row) => sql`${row.id}`),
            sql`,`,
          )})`,
        );
        const ids = new Set(scopeCandidates.map((row) => String(row.id)));
        this.projection?.removeWhere('agentScopeEvents', (row) => ids.has(String(row.id)));
      }
      const scopeEvents = scopeCandidates.length;
      const reads = state
        ? state
            .table('agentRoomReads')
            .all()
            .filter(
              (r) =>
                r.readAt <= cutoff &&
                !this.projection!.draft.table('agentRoomEvents').by('roomId', r.roomId).length,
            )
            .slice(0, Math.max(0, 100 - events.length - purgedConferences - attachments.length - scopeEvents))
            .map((r) => ({ id: r.roomId, admin_id: r.adminId }))
        : await rows(
            tx,
            sql`SELECT room_id AS id, admin_id FROM agent_room_reads WHERE read_at <= ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM agent_room_events e WHERE e.room_id = BINARY agent_room_reads.room_id) LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`,
          );
      for (const row of reads as Array<Row & { admin_id: number }>) {
        await tx.execute(
          sql`DELETE FROM agent_room_reads WHERE room_id = ${row.id} AND admin_id = ${row.admin_id}`,
        );
        this.projection?.removeWhere(
          'agentRoomReads',
          (item) => item.roomId === row.id && item.adminId === row.admin_id,
        );
      }
      const operations = state
        ? state
            .table('agentRoomOperations')
            .all()
            .filter((r) => r.createdAt <= cutoff)
            .slice(
              0,
              Math.max(
                0,
                100 - events.length - purgedConferences - attachments.length - scopeEvents - reads.length,
              ),
            )
        : await rows(
            tx,
            sql`SELECT id FROM agent_room_operations WHERE created_at <= ${cutoff} LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`,
          );
      if (operations.length) {
        await tx.execute(
          sql`DELETE FROM agent_room_operations WHERE id IN (${sql.join(
            operations.map((row) => sql`${row.id}`),
            sql`,`,
          )})`,
        );
        const ids = new Set(operations.map((row) => row.id));
        this.projection?.removeWhere('agentRoomOperations', (row) => ids.has(row.id));
      }
      return (
        events.length +
        purgedConferences +
        attachments.length +
        scopeEvents +
        reads.length +
        operations.length
      );
    });
  }

  private async addresses(cutoff: string) {
    return this.transaction(async (tx) => {
      if (!this.projection)
        await tx.execute(sql`SELECT name FROM versions WHERE name = 'agent_messaging_enabled' FOR UPDATE`);
      const state = this.projection?.draft.view();
      const candidates = state
        ? ownerHistoryCandidates(state, cutoff, new Date().toISOString(), this.presence).addresses()
        : await rows(
            tx,
            sql`SELECT a.id FROM agent_bus_addresses a WHERE a.last_seen_at <= ${cutoff}
        AND NOT ${protectedAddress(sql`a.id`)} AND NOT ${this.activeAddress(sql`a.id`, cutoff)}
        AND NOT EXISTS (SELECT 1 FROM hosts h WHERE h.id = a.host_id AND h.internal_role IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.agent_bus_address_id = BINARY a.id)
        AND NOT EXISTS (SELECT 1 FROM agent_bus_conversations c WHERE c.address_a_id = BINARY a.id OR c.address_b_id = BINARY a.id)
        AND NOT EXISTS (SELECT 1 FROM agent_bus_conferences f WHERE f.owner_address_id = BINARY a.id)
        AND NOT EXISTS (SELECT 1 FROM agent_bus_conference_members m WHERE m.address_id = BINARY a.id)
        AND NOT EXISTS (SELECT 1 FROM host_daemon_sessions d WHERE d.address_id = BINARY a.id)
        ORDER BY a.last_seen_at LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`,
          );
      for (const { id } of candidates) {
        await tx.execute(
          sql`DELETE FROM agent_bus_subscriptions WHERE subscriber_address_id = ${id} OR topic = CONCAT('agent:', ${id})`,
        );
        await tx.execute(sql`DELETE FROM agent_bus_publications WHERE sender_address_id = ${id}`);
        await tx.execute(sql`DELETE FROM agent_name_leases WHERE address_id = ${id}`);
        await tx.execute(
          sql`UPDATE agent_role_assignments SET status = 'ended', active_address_id = NULL, ended_at = ${cutoff}, end_reason = 'retention' WHERE address_id = ${id} AND status = 'active'`,
        );
        await tx.execute(
          sql`UPDATE git_worktrees SET agent_bus_address_id = NULL WHERE agent_bus_address_id = ${id}`,
        );
        await tx.execute(sql`DELETE FROM agent_bus_addresses WHERE id = ${id}`);
        this.projection?.removeWhere(
          'agentBusSubscriptions',
          (row) => row.subscriberAddressId === id || row.topic === `agent:${id}`,
        );
        this.projection?.removeWhere('agentBusPublications', (row) => row.senderAddressId === id);
        this.projection?.removeWhere('agentNameLeases', (row) => row.addressId === id);
        this.projection?.patchWhere(
          'agentRoleAssignments',
          (row) => row.addressId === id && row.status === 'active',
          { status: 'ended', activeAddressId: null, endedAt: cutoff, endReason: 'retention' },
        );
        this.projection?.patchWhere('gitWorktrees', (row) => row.agentBusAddressId === id, {
          agentBusAddressId: null,
        });
        this.projection?.removeWhere('agentBusAddresses', (row) => row.id === id);
      }
      const publications = state
        ? this.projection!.draft.table('agentBusPublications')
            .all()
            .filter((r) => r.createdAt <= cutoff)
            .slice(0, Math.max(0, 100 - candidates.length))
        : await rows(
            tx,
            sql`SELECT id FROM agent_bus_publications WHERE created_at <= ${cutoff} LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`,
          );
      if (publications.length) {
        await tx.execute(
          sql`DELETE FROM agent_bus_publications WHERE id IN (${sql.join(
            publications.map((row) => sql`${row.id}`),
            sql`,`,
          )})`,
        );
        const ids = new Set(publications.map((row) => row.id));
        this.projection?.removeWhere('agentBusPublications', (row) => ids.has(row.id));
      }
      return candidates.length + publications.length;
    });
  }
}
