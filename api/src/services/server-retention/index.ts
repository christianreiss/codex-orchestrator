import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { wsPublisher } from '../../ws/publisher.js';
import { addressActiveSince, protectedAddress, RETENTION_BATCH_SIZE, SERVER_RETENTION_SECONDS } from './guards.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Row = { id: string };

async function rows(tx: Tx, query: SQL): Promise<Row[]> {
  const [result] = await tx.execute(query);
  return result as unknown as Row[];
}

async function remove(tx: Tx, query: SQL): Promise<number> {
  const [result] = await tx.execute(query);
  return Number((result as unknown as { affectedRows: number }).affectedRows);
}

/** Lock current heartbeat evidence, so a concurrent reconnect wins or follows
 * the purge transaction; an earlier consistent-read snapshot is insufficient. */
async function contactsActive(tx: Tx, addresses: SQL, cutoff: string): Promise<boolean> {
  const [result] = await tx.execute(sql`SELECT heartbeat_at FROM agent_sessions
    WHERE agent_bus_address_id IN (${addresses}) FOR UPDATE`);
  return (result as unknown as Array<{ heartbeat_at: string }>).some(s => Date.parse(s.heartbeat_at) > Date.parse(cutoff));
}

/** Bounded, periodic cleanup; independent of feature switches and host traffic. */
export class ServerRetentionService {
  constructor(private readonly db: Database) {}

  async purge(now = new Date()): Promise<Record<string, number>> {
    const cutoff = new Date(now.getTime() - SERVER_RETENTION_SECONDS * 1000).toISOString();
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
    return this.db.transaction(async tx => {
      let count = 0;
      for (const table of ['mcp_session_tokens', 'admin_sessions', 'provider_account_sessions'] as const) {
        const ids = await rows(tx, sql`SELECT id FROM ${sql.identifier(table)} WHERE expires_at <= ${now} ORDER BY expires_at LIMIT 1000 FOR UPDATE`);
        if (ids.length) await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE id IN (${sql.join(ids.map(r => sql`${r.id}`), sql`,`)})`);
        count += ids.length;
      }
      return count;
    });
  }

  private async relays(cutoff: string, now: string) {
    return this.db.transaction(async tx => {
      const expired = await rows(tx, sql`SELECT r.id FROM agent_bus_relays r WHERE r.heartbeat_at <= ${cutoff}
        AND (r.token_expires_at IS NULL OR r.token_expires_at <= ${now})
        AND NOT EXISTS (SELECT 1 FROM agent_bus_messages m WHERE m.lease_owner LIKE CONCAT('relay:',r.id,':%')
          AND m.status IN ('leased','accepted','reboot_hold'))
        ORDER BY r.heartbeat_at LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`);
      if (expired.length) await tx.execute(sql`DELETE FROM agent_bus_relays WHERE id IN (${sql.join(expired.map(r => sql`${r.id}`), sql`,`)})`);
      return expired.length;
    });
  }

  private async bus(cutoff: string) {
    return this.db.transaction(async tx => {
      // All send/register/conference/schedule paths take this gate first.
      await tx.execute(sql`SELECT name FROM versions WHERE name = 'agent_messaging_enabled' FOR UPDATE`);
      const candidates = await rows(tx, sql`SELECT c.id FROM agent_bus_conversations c
        WHERE c.last_activity_at <= ${cutoff}
        AND NOT ${protectedAddress(sql`c.address_a_id`)} AND NOT ${protectedAddress(sql`c.address_b_id`)}
        AND NOT ${addressActiveSince(sql`c.address_a_id`, cutoff)} AND NOT ${addressActiveSince(sql`c.address_b_id`, cutoff)}
        AND NOT EXISTS (SELECT 1 FROM advisor_sessions v WHERE v.conversation_id = c.id AND v.status = 'open')
        AND NOT EXISTS (SELECT 1 FROM agent_bus_conference_members m JOIN agent_bus_conferences f ON f.id = m.conference_id
          WHERE m.conversation_id = c.id AND f.status <> 'adjourned')
        ORDER BY c.last_activity_at LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`);
      let conversations = 0, deletedMessages = 0;
      for (const { id } of candidates) {
        if (await contactsActive(tx, sql`SELECT address_a_id FROM agent_bus_conversations WHERE id = ${id}
          UNION SELECT address_b_id FROM agent_bus_conversations WHERE id = ${id}`, cutoff)) continue;
        // Large threads drain a bounded message batch before their parent goes.
        const messages = await rows(tx, sql`SELECT id FROM agent_bus_messages WHERE conversation_id = ${id} LIMIT 500 FOR UPDATE`);
        if (messages.length) {
          const ids = sql.join(messages.map(r => sql`${r.id}`), sql`,`);
          await tx.execute(sql`DELETE FROM agent_task_results WHERE message_id IN (${ids})`);
          await tx.execute(sql`DELETE FROM agent_fresh_start_grants WHERE message_id IN (${ids})`);
          await tx.execute(sql`DELETE FROM agent_schedule_runs WHERE message_id IN (${ids})`);
          await tx.execute(sql`DELETE FROM agent_room_deliveries WHERE message_id IN (${ids})`);
          await tx.execute(sql`UPDATE agent_bus_conference_members SET dispatch_message_id = NULL WHERE dispatch_message_id IN (${ids})`);
          deletedMessages += await remove(tx, sql`DELETE FROM agent_bus_messages WHERE id IN (${ids})`);
        }
        await tx.execute(sql`UPDATE agent_bus_conference_members SET conversation_id = NULL WHERE conversation_id = ${id}
          AND NOT EXISTS (SELECT 1 FROM agent_bus_messages WHERE conversation_id = ${id})`);
        await tx.execute(sql`UPDATE advisor_sessions SET conversation_id = NULL WHERE conversation_id = ${id}
          AND NOT EXISTS (SELECT 1 FROM agent_bus_messages WHERE conversation_id = ${id})`);
        conversations += await remove(tx, sql`DELETE FROM agent_bus_conversations WHERE id = ${id}
          AND NOT EXISTS (SELECT 1 FROM agent_bus_messages WHERE conversation_id = ${id})`);
      }
      return { conversations, messages: deletedMessages };
    });
  }

  private async daemons(cutoff: string) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT name FROM versions WHERE name = 'agent_messaging_enabled' FOR UPDATE`);
      const disconnected = await rows(tx, sql`SELECT d.id FROM host_daemon_sessions d
        WHERE d.last_activity_at <= ${cutoff} AND d.status IN ('queued','running','idle','waiting')
        AND NOT ${protectedAddress(sql`d.address_id`)} AND NOT ${addressActiveSince(sql`d.address_id`, cutoff)}
        AND NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = d.session_id AND s.heartbeat_at > ${cutoff})
        LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`);
      for (const { id } of disconnected) {
        if (await contactsActive(tx, sql`SELECT address_id FROM host_daemon_sessions WHERE id = ${id}`, cutoff)) continue;
        // Loss of contact cannot prove a result. Never requeue accepted effects.
        await tx.execute(sql`UPDATE host_daemon_operations SET status = 'unknown', claim_id = NULL
          WHERE session_id = ${id} AND status IN ('accepted','running')`);
        await tx.execute(sql`UPDATE host_daemon_operations SET status = 'expired', claim_id = NULL
          WHERE session_id = ${id} AND status IN ('queued','offered')`);
        await tx.execute(sql`UPDATE host_daemon_sessions SET status = 'unknown' WHERE id = ${id}`);
      }
      const candidates = await rows(tx, sql`SELECT d.id FROM host_daemon_sessions d WHERE d.last_activity_at <= ${cutoff}
        AND d.status IN ('closed','failed','unknown') AND NOT ${protectedAddress(sql`d.address_id`)}
        AND NOT ${addressActiveSince(sql`d.address_id`, cutoff)}
        AND NOT EXISTS (SELECT 1 FROM host_daemon_operations o WHERE o.session_id = d.id AND o.status IN ('queued','offered','accepted','running'))
        ORDER BY d.last_activity_at LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`);
      let purged = 0;
      for (const { id } of candidates) {
        if (await contactsActive(tx, sql`SELECT address_id FROM host_daemon_sessions WHERE id = ${id}`, cutoff)) continue;
        await tx.execute(sql`UPDATE agent_chat_attachments SET status = 'retired' WHERE session_id = ${id}`);
        await tx.execute(sql`DELETE FROM advisor_sessions WHERE daemon_session_id = ${id}`);
        await tx.execute(sql`DELETE FROM companion_daemon_follows WHERE daemon_session_id = ${id}`);
        await tx.execute(sql`DELETE FROM host_daemon_portal_bindings WHERE daemon_session_id = ${id}`);
        await tx.execute(sql`DELETE FROM host_daemon_operations WHERE session_id = ${id}`);
        purged += await remove(tx, sql`DELETE FROM host_daemon_sessions WHERE id = ${id}`);
      }
      return purged;
    });
  }

  private async chatty(cutoff: string) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT name FROM versions WHERE name = 'chatty_scheduler' FOR UPDATE`);
      // The scheduler uses the same unknown-on-lost-lease rule. This runs even
      // with Chatty disabled and keeps old claims from pinning history forever.
      await tx.execute(sql`UPDATE chatty_runs SET status = 'unknown', claim_id = NULL, lease_until = NULL
        WHERE status = 'running' AND updated_at <= ${cutoff} AND (lease_until IS NULL OR lease_until <= ${cutoff}) LIMIT ${RETENTION_BATCH_SIZE}`);
      await tx.execute(sql`UPDATE chatty_runs SET status = 'cancelled' WHERE status = 'queued' AND updated_at <= ${cutoff} LIMIT ${RETENTION_BATCH_SIZE}`);
      const sessions = await rows(tx, sql`SELECT user_id AS id FROM chatty_sessions s WHERE s.updated_at <= ${cutoff}
        AND (s.summary_enc IS NOT NULL OR EXISTS (SELECT 1 FROM chatty_runs x WHERE x.user_id = s.user_id) OR EXISTS (SELECT 1 FROM chatty_events x WHERE x.user_id = s.user_id))
        AND NOT EXISTS (SELECT 1 FROM chatty_runs r WHERE r.user_id = s.user_id AND (r.updated_at > ${cutoff} OR r.status IN ('queued','running')))
        AND NOT EXISTS (SELECT 1 FROM chatty_events e WHERE e.user_id = s.user_id AND e.created_at > ${cutoff})
        LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`);
      for (const { id } of sessions) {
        // Keep the user's selection and advance generation to invalidate old forms.
        await tx.execute(sql`DELETE FROM chatty_actions WHERE user_id = ${id}`);
        await tx.execute(sql`DELETE FROM chatty_events WHERE user_id = ${id}`);
        await tx.execute(sql`DELETE FROM chatty_runs WHERE user_id = ${id}`);
        await tx.execute(sql`UPDATE chatty_sessions SET generation = generation + 1, summary_enc = NULL WHERE user_id = ${id}`);
      }
      return sessions.length;
    });
  }

  private async rooms(cutoff: string) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT name FROM versions WHERE name = 'agent_messaging_enabled' FOR UPDATE`);
      const candidates = await rows(tx, sql`SELECT e.id FROM agent_room_events e WHERE e.created_at <= ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM agent_room_events n WHERE n.room_id = e.room_id AND n.created_at > ${cutoff})
        AND NOT EXISTS (SELECT 1 FROM agent_bus_subscriptions b WHERE b.topic = (SELECT CONCAT('group:', g.slug) FROM agent_bus_groups g WHERE g.id = e.room_id)
          AND (${protectedAddress(sql`b.subscriber_address_id`)} OR ${addressActiveSince(sql`b.subscriber_address_id`, cutoff)}))
        AND NOT EXISTS (SELECT 1 FROM agent_bus_conference_members b WHERE b.conference_id = e.room_id
          AND (${protectedAddress(sql`b.address_id`)} OR ${addressActiveSince(sql`b.address_id`, cutoff)}))
        AND NOT EXISTS (SELECT 1 FROM agent_scope_members b JOIN agent_sessions s ON s.id = b.session_id WHERE b.scope_id = e.room_id AND s.heartbeat_at > ${cutoff})
        AND NOT EXISTS (SELECT 1 FROM agent_room_deliveries d JOIN agent_bus_messages m ON m.id = d.message_id
          WHERE d.event_id = e.id AND m.status IN ('queued','leased','accepted','reboot_hold','batched'))
        ORDER BY e.created_at LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`);
      const events: Row[] = [];
      for (const event of candidates) {
        const active = await contactsActive(tx, sql`
          SELECT b.subscriber_address_id FROM agent_bus_subscriptions b JOIN agent_bus_groups g ON b.topic = CONCAT('group:', g.slug)
            JOIN agent_room_events e ON e.room_id = g.id WHERE e.id = ${event.id}
          UNION SELECT b.address_id FROM agent_bus_conference_members b JOIN agent_room_events e ON e.room_id = b.conference_id WHERE e.id = ${event.id}
          UNION SELECT s.agent_bus_address_id FROM agent_scope_members m JOIN agent_sessions s ON s.id = m.session_id
            JOIN agent_room_events e ON e.room_id = m.scope_id WHERE e.id = ${event.id}`, cutoff);
        if (!active) events.push(event);
      }
      if (events.length) {
        const ids = sql.join(events.map(r => sql`${r.id}`), sql`,`);
        await tx.execute(sql`DELETE FROM agent_room_deliveries WHERE event_id IN (${ids})`);
        await tx.execute(sql`DELETE FROM agent_room_events WHERE id IN (${ids})`);
      }
      const conferences = await rows(tx, sql`SELECT f.id FROM agent_bus_conferences f WHERE f.status = 'adjourned'
        AND COALESCE(f.adjourned_at, f.created_at) <= ${cutoff}
        AND NOT ${protectedAddress(sql`f.owner_address_id`)} AND NOT ${addressActiveSince(sql`f.owner_address_id`, cutoff)}
        AND NOT EXISTS (SELECT 1 FROM agent_bus_conference_members m WHERE m.conference_id = f.id
          AND (${protectedAddress(sql`m.address_id`)} OR ${addressActiveSince(sql`m.address_id`, cutoff)}))
        AND NOT EXISTS (SELECT 1 FROM agent_room_events e WHERE e.room_id = f.id)
        LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`);
      let purgedConferences = 0;
      for (const { id } of conferences) {
        if (await contactsActive(tx, sql`SELECT owner_address_id FROM agent_bus_conferences WHERE id = ${id}
          UNION SELECT address_id FROM agent_bus_conference_members WHERE conference_id = ${id}`, cutoff)) continue;
        await tx.execute(sql`UPDATE agent_chat_attachments SET status = 'retired' WHERE session_id = ${id}`);
        await tx.execute(sql`DELETE FROM agent_room_reads WHERE room_id = ${id}`);
        await tx.execute(sql`DELETE FROM agent_bus_conference_members WHERE conference_id = ${id}`);
        purgedConferences += await remove(tx, sql`DELETE FROM agent_bus_conferences WHERE id = ${id}`);
      }
      // Persistent room definitions remain; only their empty history loses files/read markers.
      await tx.execute(sql`UPDATE agent_chat_attachments a SET status = 'retired' WHERE a.updated_at <= ${cutoff}
        AND (EXISTS (SELECT 1 FROM agent_bus_groups g WHERE g.id = a.session_id) OR EXISTS (SELECT 1 FROM agent_scopes s WHERE s.id = a.session_id))
        AND NOT EXISTS (SELECT 1 FROM agent_room_events e WHERE e.room_id = a.session_id)`);
      await tx.execute(sql`DELETE FROM agent_scope_events WHERE created_at <= ${cutoff} AND dispatched = 1
        AND NOT EXISTS (SELECT 1 FROM agent_scope_members m JOIN agent_sessions s ON s.id = m.session_id
          WHERE m.scope_id = agent_scope_events.scope_id AND (s.heartbeat_at > ${cutoff} OR ${protectedAddress(sql`s.agent_bus_address_id`)}))
        LIMIT ${RETENTION_BATCH_SIZE}`);
      await tx.execute(sql`DELETE FROM agent_room_reads WHERE read_at <= ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM agent_room_events e WHERE e.room_id = agent_room_reads.room_id) LIMIT ${RETENTION_BATCH_SIZE}`);
      await tx.execute(sql`DELETE FROM agent_room_operations WHERE created_at <= ${cutoff} LIMIT ${RETENTION_BATCH_SIZE}`);
      return events.length + purgedConferences;
    });
  }

  private async addresses(cutoff: string) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT name FROM versions WHERE name = 'agent_messaging_enabled' FOR UPDATE`);
      const candidates = await rows(tx, sql`SELECT a.id FROM agent_bus_addresses a WHERE a.last_seen_at <= ${cutoff}
        AND NOT ${protectedAddress(sql`a.id`)} AND NOT ${addressActiveSince(sql`a.id`, cutoff)}
        AND NOT EXISTS (SELECT 1 FROM hosts h WHERE h.id = a.host_id AND h.internal_role IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.agent_bus_address_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM agent_bus_conversations c WHERE c.address_a_id = a.id OR c.address_b_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM agent_bus_conferences f WHERE f.owner_address_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM agent_bus_conference_members m WHERE m.address_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM host_daemon_sessions d WHERE d.address_id = a.id)
        ORDER BY a.last_seen_at LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE`);
      for (const { id } of candidates) {
        await tx.execute(sql`DELETE FROM agent_bus_subscriptions WHERE subscriber_address_id = ${id} OR topic = CONCAT('agent:', ${id})`);
        await tx.execute(sql`DELETE FROM agent_bus_publications WHERE sender_address_id = ${id}`);
        await tx.execute(sql`DELETE FROM agent_name_leases WHERE address_id = ${id}`);
        await tx.execute(sql`UPDATE agent_role_assignments SET status = 'ended', active_address_id = NULL, ended_at = ${cutoff}, end_reason = 'retention' WHERE address_id = ${id} AND status = 'active'`);
        await tx.execute(sql`UPDATE git_worktrees SET agent_bus_address_id = NULL WHERE agent_bus_address_id = ${id}`);
        await tx.execute(sql`DELETE FROM agent_bus_addresses WHERE id = ${id}`);
      }
      await tx.execute(sql`DELETE FROM agent_bus_publications WHERE created_at <= ${cutoff} LIMIT ${RETENTION_BATCH_SIZE}`);
      return candidates.length;
    });
  }
}
