import { and, sql } from 'drizzle-orm';
import { agentBusMessages } from '../../db/schema.js';

/** Shared by the advisory relay peek and the authoritative strict FIFO claim. */
export function strictFifoDeliveryReady() {
  return and(
    sql`NOT EXISTS (
      SELECT 1
        FROM agent_bus_messages AS earlier
       WHERE earlier.target_address_id = ${agentBusMessages.targetAddressId}
         AND earlier.status IN ('queued', 'leased', 'accepted', 'reboot_hold')
         AND earlier.dispatch_order < ${agentBusMessages.dispatchOrder}
    )`,
    sql`NOT EXISTS (
      SELECT 1
        FROM agent_bus_messages AS in_flight
       WHERE in_flight.target_address_id = ${agentBusMessages.targetAddressId}
         AND in_flight.status IN ('leased', 'accepted', 'reboot_hold')
         AND in_flight.id <> ${agentBusMessages.id}
    )`,
  );
}
