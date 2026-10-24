import { sql, type SQL } from 'drizzle-orm';

export const SERVER_RETENTION_SECONDS = 86400;
export const RETENTION_BATCH_SIZE = 100;

/** Only an explicit future/paused job or unfinished delivery can pin an identity. */
export function protectedAddress(id: SQL): SQL {
  id = sql`${id} COLLATE utf8mb4_unicode_ci`;
  return sql`(
    EXISTS (SELECT 1 FROM agent_schedules j WHERE j.target_address_id = ${id} AND j.deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM agent_watchdogs w WHERE w.target_address_id = ${id} AND w.status IN ('watching','recovering','capacity_wait'))
    OR EXISTS (SELECT 1 FROM agent_reboot_handoffs r WHERE r.address_id = ${id} AND r.status IN ('prepared','armed','resuming'))
    OR EXISTS (SELECT 1 FROM agent_role_proposals p WHERE (p.author_address_id = ${id} OR p.reviewer_address_id = ${id}) AND p.status NOT IN ('applied','rejected','withdrawn','superseded'))
    OR EXISTS (SELECT 1 FROM agent_bus_messages m WHERE (m.target_address_id = ${id} OR m.sender_address_id = ${id}) AND m.status IN ('queued','leased','accepted','reboot_hold','batched'))
  )`;
}

/** Use contact history, not updated_at: retention itself writes updated_at. */
export function addressActiveSince(id: SQL, cutoff: string): SQL {
  id = sql`${id} COLLATE utf8mb4_unicode_ci`;
  return sql`EXISTS (SELECT 1 FROM agent_bus_addresses retention_contact WHERE retention_contact.id = ${id} AND (
    retention_contact.last_seen_at > ${cutoff}
    OR EXISTS (SELECT 1 FROM agent_sessions s WHERE s.agent_bus_address_id = retention_contact.id COLLATE utf8mb4_unicode_ci AND s.heartbeat_at > ${cutoff})
  ))`;
}

export function protectedSession(id: SQL, addressId: SQL): SQL {
  id = sql`${id} COLLATE utf8mb4_unicode_ci`;
  return sql`(${protectedAddress(addressId)}
    OR EXISTS (SELECT 1 FROM agent_reboot_handoffs r WHERE (r.old_session_id = ${id} OR r.new_session_id = ${id}) AND r.status IN ('prepared','armed','resuming'))
    OR EXISTS (SELECT 1 FROM agent_messages m WHERE m.session_id = ${id} AND m.status IN ('queued','leased','accepted','reboot_hold'))
    OR EXISTS (SELECT 1 FROM agent_resource_claims c WHERE c.session_id = ${id} AND c.state IN ('active','waiting','uncertain'))
  )`;
}
