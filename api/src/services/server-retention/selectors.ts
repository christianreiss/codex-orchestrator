import { sql, type SQL } from 'drizzle-orm';
import { addressActiveSince, protectedAddress, protectedSession } from './guards.js';

/** Shared by read-only previews and the serialized deletion commands. */
export function activeHistoryAddress(id: SQL, cutoff: string, liveAddresses: readonly string[] = []): SQL {
  return liveAddresses.length ? sql`(${addressActiveSince(id, cutoff)} OR ${id} IN (${sql.join(liveAddresses.map(id=>sql`${id}`),sql`, `)}))` : addressActiveSince(id, cutoff);
}
export function conversationHistoryWhere(cutoff: string, liveAddresses: readonly string[] = []): SQL {
  return sql`c.last_activity_at <= ${cutoff}
    AND NOT ${protectedAddress(sql`c.address_a_id`)} AND NOT ${protectedAddress(sql`c.address_b_id`)}
    AND NOT ${activeHistoryAddress(sql`c.address_a_id`,cutoff,liveAddresses)} AND NOT ${activeHistoryAddress(sql`c.address_b_id`,cutoff,liveAddresses)}
    AND NOT EXISTS (SELECT 1 FROM advisor_sessions v WHERE v.conversation_id = BINARY c.id AND v.status = 'open')
    AND NOT EXISTS (SELECT 1 FROM agent_bus_conference_members m JOIN agent_bus_conferences f ON f.id = BINARY m.conference_id WHERE m.conversation_id = BINARY c.id AND f.status <> 'adjourned')`;
}
export function portalHistoryWhere(now: string, cutoff: string, liveSessions: readonly string[] = []): SQL {
  return sql`expires_at <= ${now} AND ended_at IS NOT NULL
    AND NOT ${protectedSession(sql`agent_sessions.id`,sql`agent_sessions.agent_bus_address_id`)}
    AND NOT EXISTS (SELECT 1 FROM agent_chat_notices n WHERE n.session_id = agent_sessions.id COLLATE utf8mb4_unicode_ci AND n.resolved_at IS NULL AND n.created_at > ${cutoff})
    ${liveSessions.length ? sql`AND agent_sessions.id NOT IN (${sql.join(liveSessions.map(id=>sql`${id}`),sql`,`)})` : sql``}`;
}
