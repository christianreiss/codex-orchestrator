import { and, sql } from 'drizzle-orm';
import { conferenceAdmissionOpenSql } from './conference-protocol.js';
import { nowIso } from '../../util/timestamp.js';
import { agentBusMessages } from '../../db/schema.js';

/** Shared by the advisory relay peek and the authoritative strict FIFO claim. */
export function strictFifoDeliveryReady(now = nowIso(), deliveryTimingEnabled = false) {
  return and(
    sql`NOT EXISTS (
      SELECT 1
        FROM agent_bus_messages AS earlier
       WHERE earlier.target_address_id = ${agentBusMessages.targetAddressId}
         AND earlier.status IN ('queued', 'leased', 'accepted', 'reboot_hold')
         AND (earlier.status <> 'queued' OR earlier.delivery_timing <> 'immediate' OR ${deliveryTimingEnabled ? 1 : 0}=1)
         AND (earlier.status IN ('accepted', 'reboot_hold') OR ${conferenceAdmissionOpenSql(now, 'earlier')})
         AND earlier.dispatch_order < ${agentBusMessages.dispatchOrder}
    )`,
    sql`NOT EXISTS (
      SELECT 1
        FROM agent_bus_messages AS in_flight
       WHERE in_flight.target_address_id = ${agentBusMessages.targetAddressId}
         AND in_flight.status IN ('leased', 'accepted', 'reboot_hold')
         AND (in_flight.status IN ('accepted', 'reboot_hold') OR ${conferenceAdmissionOpenSql(now, 'in_flight')})
         AND in_flight.id <> ${agentBusMessages.id}
    )`,
  );
}
