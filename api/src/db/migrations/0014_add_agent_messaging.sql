-- Agent Messaging: encrypted, ordered agent-to-agent delivery through
-- outbound-only host relays. The feature is additive and ships disabled.

SET @needs_host_messaging := (
  SELECT COUNT(*) = 0
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'hosts'
     AND COLUMN_NAME = 'agent_messaging_enabled'
);
SET @ddl := IF(
  @needs_host_messaging,
  'ALTER TABLE hosts ADD COLUMN agent_messaging_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER browseros_mcp_enabled',
  'DO 0'
);
PREPARE add_host_messaging FROM @ddl;
EXECUTE add_host_messaging;
DEALLOCATE PREPARE add_host_messaging;

CREATE TABLE IF NOT EXISTS agent_bus_addresses (
    id CHAR(36) NOT NULL,
    address VARCHAR(48) NOT NULL,
    display_alias VARCHAR(96) NULL,
    host_id BIGINT UNSIGNED NOT NULL,
    engine VARCHAR(16) NOT NULL,
    username VARCHAR(255) NOT NULL,
    cwd VARCHAR(1024) NOT NULL,
    cwd_hash CHAR(64) NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    current_session_id CHAR(36) NULL,
    last_upstream_session_id VARCHAR(255) NULL,
    binding_generation INT UNSIGNED NOT NULL DEFAULT 1,
    continuity VARCHAR(16) NOT NULL DEFAULT 'native',
    adapter_protocol VARCHAR(32) NULL,
    adapter_capabilities JSON NULL,
    readiness VARCHAR(24) NOT NULL DEFAULT 'offline',
    receive_heartbeat_at VARCHAR(100) NULL,
    last_seen_at VARCHAR(100) NOT NULL,
    archived_at VARCHAR(100) NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_agent_bus_addresses_address (address),
    UNIQUE KEY uq_agent_bus_addresses_alias (display_alias),
    UNIQUE KEY uq_agent_bus_addresses_session (current_session_id),
    INDEX idx_agent_bus_addresses_discovery (enabled, archived_at, engine, host_id),
    INDEX idx_agent_bus_addresses_native (host_id, engine, username, last_upstream_session_id),
    INDEX idx_agent_bus_addresses_cwd (host_id, engine, username, cwd_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_bus_conversations (
    id CHAR(36) NOT NULL,
    address_a_id CHAR(36) NOT NULL,
    address_b_id CHAR(36) NOT NULL,
    created_by_address_id CHAR(36) NOT NULL,
    next_sequence BIGINT UNSIGNED NOT NULL DEFAULT 1,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    last_activity_at VARCHAR(100) NOT NULL,
    canceled_by VARCHAR(191) NULL,
    cancel_reason VARCHAR(255) NULL,
    canceled_at VARCHAR(100) NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    PRIMARY KEY (id),
    INDEX idx_agent_bus_conversations_a (address_a_id, status, last_activity_at),
    INDEX idx_agent_bus_conversations_b (address_b_id, status, last_activity_at),
    INDEX idx_agent_bus_conversations_status (status, last_activity_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_bus_messages (
    id CHAR(36) NOT NULL,
    dispatch_order BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    conversation_id CHAR(36) NOT NULL,
    sequence BIGINT UNSIGNED NOT NULL,
    reply_to_message_id CHAR(36) NULL,
    redrive_of_message_id CHAR(36) NULL,
    sender_address_id CHAR(36) NOT NULL,
    sender_session_id CHAR(36) NULL,
    target_address_id CHAR(36) NOT NULL,
    source_engine VARCHAR(16) NOT NULL,
    target_engine VARCHAR(16) NOT NULL,
    kind VARCHAR(16) NOT NULL DEFAULT 'message',
    content_enc LONGTEXT NOT NULL,
    content_bytes INT UNSIGNED NOT NULL,
    client_message_id CHAR(36) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'queued',
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    next_attempt_at VARCHAR(100) NOT NULL,
    lease_owner VARCHAR(191) NULL,
    lease_until VARCHAR(100) NULL,
    claim_id CHAR(36) NULL,
    relay_generation INT UNSIGNED NULL,
    target_binding_generation INT UNSIGNED NULL,
    delivery_session_id CHAR(36) NULL,
    delivery_upstream_session_id VARCHAR(255) NULL,
    expires_at VARCHAR(100) NOT NULL,
    last_error_code VARCHAR(64) NULL,
    last_error_enc LONGTEXT NULL,
    cancel_requested_at VARCHAR(100) NULL,
    accepted_at VARCHAR(100) NULL,
    completed_at VARCHAR(100) NULL,
    ambiguous_at VARCHAR(100) NULL,
    dead_at VARCHAR(100) NULL,
    expired_at VARCHAR(100) NULL,
    canceled_at VARCHAR(100) NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_agent_bus_messages_dispatch_order (dispatch_order),
    UNIQUE KEY uq_agent_bus_messages_sender_client (sender_address_id, client_message_id),
    UNIQUE KEY uq_agent_bus_messages_conversation_sequence (conversation_id, sequence),
    INDEX idx_agent_bus_messages_dispatch (target_address_id, status, next_attempt_at, dispatch_order),
    INDEX idx_agent_bus_messages_conversation (conversation_id, sequence),
    INDEX idx_agent_bus_messages_status (status, updated_at),
    INDEX idx_agent_bus_messages_expiry (status, expires_at),
    INDEX idx_agent_bus_messages_reply (reply_to_message_id),
    INDEX idx_agent_bus_messages_redrive (redrive_of_message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Recover safely if a previous interrupted run created the table before the
-- monotonic dispatch key was added. MySQL assigns existing rows unique values
-- while adding an AUTO_INCREMENT column, preserving their current row order as
-- the best available one-time baseline.
SET @needs_message_dispatch := (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_bus_messages'
     AND COLUMN_NAME = 'dispatch_order'
);
SET @ddl := IF(
  @needs_message_dispatch,
  'ALTER TABLE agent_bus_messages ADD COLUMN dispatch_order BIGINT UNSIGNED NOT NULL AUTO_INCREMENT AFTER id, ADD UNIQUE KEY uq_agent_bus_messages_dispatch_order (dispatch_order)',
  'DO 0'
);
PREPARE add_message_dispatch FROM @ddl;
EXECUTE add_message_dispatch;
DEALLOCATE PREPARE add_message_dispatch;

SET @needs_message_dispatch_idx := (
  SELECT COUNT(*) = 0 FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_bus_messages'
     AND INDEX_NAME = 'uq_agent_bus_messages_dispatch_order'
);
SET @ddl := IF(
  @needs_message_dispatch_idx,
  'ALTER TABLE agent_bus_messages ADD UNIQUE KEY uq_agent_bus_messages_dispatch_order (dispatch_order)',
  'DO 0'
);
PREPARE add_message_dispatch_idx FROM @ddl;
EXECUTE add_message_dispatch_idx;
DEALLOCATE PREPARE add_message_dispatch_idx;

CREATE TABLE IF NOT EXISTS agent_bus_relays (
    id CHAR(36) NOT NULL,
    host_id BIGINT UNSIGNED NOT NULL,
    username VARCHAR(255) NOT NULL,
    instance_id CHAR(36) NOT NULL,
    generation INT UNSIGNED NOT NULL DEFAULT 1,
    token_hash CHAR(64) NULL,
    token_expires_at VARCHAR(100) NULL,
    host_auth_fingerprint CHAR(64) NOT NULL,
    wrapper_version VARCHAR(64) NOT NULL,
    capabilities JSON NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    heartbeat_at VARCHAR(100) NOT NULL,
    stop_requested_at VARCHAR(100) NULL,
    stopped_at VARCHAR(100) NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_agent_bus_relays_host_user (host_id, username),
    INDEX idx_agent_bus_relays_status (status, heartbeat_at),
    INDEX idx_agent_bus_relays_expiry (token_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @needs_session_address := (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_sessions'
     AND COLUMN_NAME = 'agent_bus_address_id'
);
SET @ddl := IF(
  @needs_session_address,
  'ALTER TABLE agent_sessions ADD COLUMN agent_bus_address_id CHAR(36) NULL AFTER upstream_session_id',
  'DO 0'
);
PREPARE add_session_address FROM @ddl;
EXECUTE add_session_address;
DEALLOCATE PREPARE add_session_address;

SET @needs_session_adapter := (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_sessions'
     AND COLUMN_NAME = 'adapter_protocol'
);
SET @ddl := IF(
  @needs_session_adapter,
  'ALTER TABLE agent_sessions ADD COLUMN adapter_protocol VARCHAR(32) NULL AFTER active_turn_id',
  'DO 0'
);
PREPARE add_session_adapter FROM @ddl;
EXECUTE add_session_adapter;
DEALLOCATE PREPARE add_session_adapter;

SET @needs_session_caps := (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_sessions'
     AND COLUMN_NAME = 'adapter_capabilities'
);
SET @ddl := IF(
  @needs_session_caps,
  'ALTER TABLE agent_sessions ADD COLUMN adapter_capabilities JSON NULL AFTER adapter_protocol',
  'DO 0'
);
PREPARE add_session_caps FROM @ddl;
EXECUTE add_session_caps;
DEALLOCATE PREPARE add_session_caps;

SET @needs_session_receive := (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_sessions'
     AND COLUMN_NAME = 'receive_heartbeat_at'
);
SET @ddl := IF(
  @needs_session_receive,
  'ALTER TABLE agent_sessions ADD COLUMN receive_heartbeat_at VARCHAR(100) NULL AFTER adapter_capabilities',
  'DO 0'
);
PREPARE add_session_receive FROM @ddl;
EXECUTE add_session_receive;
DEALLOCATE PREPARE add_session_receive;

SET @needs_session_binding := (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_sessions'
     AND COLUMN_NAME = 'binding_generation'
);
SET @ddl := IF(
  @needs_session_binding,
  'ALTER TABLE agent_sessions ADD COLUMN binding_generation INT UNSIGNED NOT NULL DEFAULT 0 AFTER receive_heartbeat_at',
  'DO 0'
);
PREPARE add_session_binding FROM @ddl;
EXECUTE add_session_binding;
DEALLOCATE PREPARE add_session_binding;

SET @needs_session_address_idx := (
  SELECT COUNT(*) = 0 FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_sessions'
     AND INDEX_NAME = 'idx_agent_sessions_address'
);
SET @ddl := IF(
  @needs_session_address_idx,
  'ALTER TABLE agent_sessions ADD INDEX idx_agent_sessions_address (agent_bus_address_id, status, heartbeat_at)',
  'DO 0'
);
PREPARE add_session_address_idx FROM @ddl;
EXECUTE add_session_address_idx;
DEALLOCATE PREPARE add_session_address_idx;

INSERT IGNORE INTO versions (name, version, updated_at)
VALUES ('agent_messaging_enabled', '0', '1970-01-01T00:00:00.000Z');
