-- Short-lived rendezvous PINs for `#call`.
--
-- A PIN is a fleet-unique, single-use, 4-digit token bound to one agent address.
-- It exists so two agents can find each other through a human reading four
-- digits off one terminal and typing them into another, instead of an agent
-- guessing which `agent:<uuid>` in `agent_list` is the peer it wants.
--
-- It lives on the address rather than in its own table because it is 1:1 with an
-- address and must die with it: every code path that releases a binding or
-- disables an address is already editing this row, so the PIN cannot outlive its
-- rendezvous by being forgotten in a table nobody joins against.
--
-- CHAR(4), never an integer: `0042` is a valid PIN and has to round-trip with its
-- leading zeros. `call_pin_expires_at` is VARCHAR(100) ISO text like every other
-- timestamp on this table (`receive_heartbeat_at`, `last_seen_at`), so the
-- service compares it as a string exactly the way it compares those.
--
-- The UNIQUE index is plain, not partial. MySQL permits any number of NULLs in a
-- unique index, so "no live PIN" costs nothing, and the index is what makes the
-- mint-from-complement scan in `mintCallPinLocked` cheap.
--
-- Additive and inert on its own: nothing reads these columns until the service
-- change ships.

SET @needs_call_pin := (
  SELECT COUNT(*) = 0
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'agent_bus_addresses'
     AND COLUMN_NAME = 'call_pin'
);
SET @ddl := IF(
  @needs_call_pin,
  'ALTER TABLE agent_bus_addresses ADD COLUMN call_pin CHAR(4) NULL AFTER receive_heartbeat_at',
  'DO 0'
);
PREPARE add_call_pin FROM @ddl;
EXECUTE add_call_pin;
DEALLOCATE PREPARE add_call_pin;

SET @needs_call_pin_expires := (
  SELECT COUNT(*) = 0
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'agent_bus_addresses'
     AND COLUMN_NAME = 'call_pin_expires_at'
);
SET @ddl := IF(
  @needs_call_pin_expires,
  'ALTER TABLE agent_bus_addresses ADD COLUMN call_pin_expires_at VARCHAR(100) NULL AFTER call_pin',
  'DO 0'
);
PREPARE add_call_pin_expires FROM @ddl;
EXECUTE add_call_pin_expires;
DEALLOCATE PREPARE add_call_pin_expires;

SET @needs_call_pin_index := (
  SELECT COUNT(*) = 0
    FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'agent_bus_addresses'
     AND INDEX_NAME = 'uq_agent_bus_addresses_call_pin'
);
SET @ddl := IF(
  @needs_call_pin_index,
  'ALTER TABLE agent_bus_addresses ADD UNIQUE INDEX uq_agent_bus_addresses_call_pin (call_pin)',
  'DO 0'
);
PREPARE add_call_pin_index FROM @ddl;
EXECUTE add_call_pin_index;
DEALLOCATE PREPARE add_call_pin_index;
