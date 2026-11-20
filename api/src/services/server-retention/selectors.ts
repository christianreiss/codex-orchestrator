import { sql, type SQL } from 'drizzle-orm';
import { addressActiveSince, protectedAddress } from './guards.js';

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
