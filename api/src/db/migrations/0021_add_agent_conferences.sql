-- Multi-party calls: a conference is an owner, a roster, and a set of roles.
--
-- The transport is deliberately NOT a new kind of conversation. Every member
-- gets one ordinary two-party `agent_bus_conversations` row with the owner, and
-- the owner relays. That keeps `assert_conversation_participants`, the delivery
-- leases, the per-conversation sequence and the one-in-flight-per-address rule
-- in `claimDelivery` exactly as they are -- none of which survive contact with
-- an N-party conversation row. These two tables add the membership and the
-- authority that the star topology cannot express on its own, and nothing else.
--
-- What is NOT stored here is as deliberate as what is. There is no `fqdn` and no
-- `engine` column: both are already reachable by joining `agent_bus_addresses`
-- to `hosts`, exactly as `publicAddress` does when it renders a peer. Copying
-- them here would let a member's recorded host drift from the host it is
-- actually on, and would let a joiner assert an identity instead of merely
-- declaring a `purpose`. Role is likewise assigned by open-vs-join, never sent.
--
-- `pin` mirrors `agent_bus_addresses.call_pin`: CHAR(4) so `0042` keeps its
-- leading zeros, a plain (not partial) UNIQUE index because MySQL permits any
-- number of NULLs and that is what makes the mint-from-complement scan cheap.
-- The two PIN spaces must not collide -- a human carrying four digits between
-- terminals cannot be expected to also carry which *kind* of thing they open --
-- so `mintCallPinLocked` scans the union of both columns. A cross-table UNIQUE
-- is not expressible in MySQL, so that invariant lives in the mint, not here.
--
-- Additive and inert on its own: nothing reads these tables until the service
-- change ships.

CREATE TABLE IF NOT EXISTS agent_bus_conferences (
    id CHAR(36) NOT NULL,
    owner_address_id CHAR(36) NOT NULL,
    topic VARCHAR(255) NULL,
    purpose VARCHAR(1024) NULL,
    pin CHAR(4) NULL,
    pin_expires_at VARCHAR(100) NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    max_members INT UNSIGNED NOT NULL DEFAULT 8,
    deadline_at VARCHAR(100) NOT NULL,
    adjourn_reason VARCHAR(255) NULL,
    adjourned_at VARCHAR(100) NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE INDEX uq_agent_bus_conferences_pin (pin),
    INDEX idx_agent_bus_conferences_owner (owner_address_id, status),
    INDEX idx_agent_bus_conferences_status (status, deadline_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- `mode` records how a member is reached, because the owner has to phrase a
-- dispatch differently for each and the difference is not cosmetic. An
-- `attached` member is a live wrapper sitting in `agent_listen`. A `headless`
-- member is an idle host the relay boots per delivery, resumed through
-- `last_upstream_session_id` so it keeps its transcript across rounds -- there
-- is no process between rounds, which is precisely why "stay in the room and
-- rejoin after tasks" costs nothing.
--
-- `state` is the floor: `seated` is in the room, `dispatched` is away on a task
-- and excluded from broadcast, `left` has gone. A `dispatched` member is swept
-- back to `seated` if its report never lands, because a headless run that dies
-- burns its delivery attempts silently and would otherwise strand the owner
-- waiting forever on a report that is never coming.
CREATE TABLE IF NOT EXISTS agent_bus_conference_members (
    id CHAR(36) NOT NULL,
    conference_id CHAR(36) NOT NULL,
    address_id CHAR(36) NOT NULL,
    conversation_id CHAR(36) NULL,
    role VARCHAR(16) NOT NULL DEFAULT 'participant',
    purpose VARCHAR(1024) NULL,
    mode VARCHAR(16) NOT NULL DEFAULT 'attached',
    state VARCHAR(16) NOT NULL DEFAULT 'seated',
    dispatch_message_id CHAR(36) NULL,
    dispatch_deadline_at VARCHAR(100) NULL,
    dispatched_at VARCHAR(100) NULL,
    last_report_at VARCHAR(100) NULL,
    message_count INT UNSIGNED NOT NULL DEFAULT 0,
    joined_at VARCHAR(100) NOT NULL,
    left_at VARCHAR(100) NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE INDEX uq_agent_bus_conference_members (conference_id, address_id),
    INDEX idx_agent_bus_conference_members_address (address_id, state),
    INDEX idx_agent_bus_conference_members_dispatch (state, dispatch_deadline_at),
    INDEX idx_agent_bus_conference_members_conversation (conversation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
