-- Permanent per-user agent portal and durable host bridge.
--
-- All user-visible conversation text and reusable bearer material is stored in
-- secretbox envelopes. Hashes are the only searchable token representation.

CREATE TABLE IF NOT EXISTS agent_portal_users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    display_name VARCHAR(255) NOT NULL,
    matrix_room VARCHAR(255) NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    public_id CHAR(32) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    token_enc LONGTEXT NOT NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    last_used_at VARCHAR(100) NULL,
    disabled_at VARCHAR(100) NULL,
    rotated_at VARCHAR(100) NULL,
    deleted_at VARCHAR(100) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_agent_portal_users_public_id (public_id),
    UNIQUE KEY uq_agent_portal_users_token_hash (token_hash),
    INDEX idx_agent_portal_users_enabled (enabled),
    INDEX idx_agent_portal_users_deleted (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_portal_browser_sessions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NOT NULL,
    token_hash CHAR(64) NOT NULL,
    ip VARCHAR(64) NULL,
    user_agent VARCHAR(255) NULL,
    expires_at VARCHAR(100) NOT NULL,
    last_seen_at VARCHAR(100) NOT NULL,
    created_at VARCHAR(100) NOT NULL,
    revoked_at VARCHAR(100) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_agent_portal_browser_sessions_token (token_hash),
    INDEX idx_agent_portal_browser_sessions_user (user_id),
    INDEX idx_agent_portal_browser_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_sessions (
    id CHAR(36) NOT NULL,
    host_id BIGINT UNSIGNED NOT NULL,
    engine VARCHAR(16) NOT NULL,
    username VARCHAR(255) NOT NULL,
    cwd VARCHAR(1024) NOT NULL,
    upstream_session_id VARCHAR(255) NULL,
    invocation_kind VARCHAR(24) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'starting',
    relay_enabled TINYINT(1) NOT NULL DEFAULT 0,
    relay_heartbeat_at VARCHAR(100) NULL,
    active_turn_id VARCHAR(255) NULL,
    host_auth_fingerprint CHAR(64) NOT NULL,
    bridge_token_hash CHAR(64) NOT NULL,
    bridge_expires_at VARCHAR(100) NOT NULL,
    started_at VARCHAR(100) NOT NULL,
    heartbeat_at VARCHAR(100) NOT NULL,
    ended_at VARCHAR(100) NULL,
    expires_at VARCHAR(100) NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    PRIMARY KEY (id),
    INDEX idx_agent_sessions_status (status, heartbeat_at),
    INDEX idx_agent_sessions_host (host_id, engine),
    INDEX idx_agent_sessions_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    session_id CHAR(36) NOT NULL,
    client_event_id VARCHAR(64) NOT NULL,
    event_type VARCHAR(32) NOT NULL,
    source VARCHAR(24) NOT NULL,
    payload_enc LONGTEXT NOT NULL,
    created_at VARCHAR(100) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_agent_events_session_client (session_id, client_event_id),
    INDEX idx_agent_events_session_cursor (session_id, id),
    INDEX idx_agent_events_type (event_type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_prompts (
    id CHAR(36) NOT NULL,
    session_id CHAR(36) NOT NULL,
    event_id BIGINT UNSIGNED NULL,
    question_enc LONGTEXT NOT NULL,
    options_enc LONGTEXT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    answered_by_user_id BIGINT UNSIGNED NULL,
    answer_message_id CHAR(36) NULL,
    version INT UNSIGNED NOT NULL DEFAULT 1,
    created_at VARCHAR(100) NOT NULL,
    answered_at VARCHAR(100) NULL,
    expires_at VARCHAR(100) NULL,
    PRIMARY KEY (id),
    INDEX idx_agent_prompts_session_status (session_id, status),
    INDEX idx_agent_prompts_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_messages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    message_id CHAR(36) NOT NULL,
    session_id CHAR(36) NOT NULL,
    portal_user_id BIGINT UNSIGNED NOT NULL,
    kind VARCHAR(16) NOT NULL DEFAULT 'message',
    prompt_id CHAR(36) NULL,
    client_message_id CHAR(36) NOT NULL,
    content_enc LONGTEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'queued',
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    next_attempt_at VARCHAR(100) NOT NULL,
    lease_owner VARCHAR(191) NULL,
    lease_until VARCHAR(100) NULL,
    upstream_id VARCHAR(255) NULL,
    last_error TEXT NULL,
    accepted_at VARCHAR(100) NULL,
    canceled_at VARCHAR(100) NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_agent_messages_message_id (message_id),
    UNIQUE KEY uq_agent_messages_session_client (session_id, client_message_id),
    INDEX idx_agent_messages_dispatch (session_id, status, next_attempt_at, id),
    INDEX idx_agent_messages_user (portal_user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_matrix_outbox (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    portal_user_id BIGINT UNSIGNED NOT NULL,
    session_id CHAR(36) NULL,
    event_id BIGINT UNSIGNED NULL,
    event_key VARCHAR(191) NOT NULL,
    kind VARCHAR(32) NOT NULL,
    payload_enc LONGTEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'queued',
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    next_attempt_at VARCHAR(100) NOT NULL,
    lease_owner VARCHAR(191) NULL,
    lease_until VARCHAR(100) NULL,
    last_error TEXT NULL,
    delivered_at VARCHAR(100) NULL,
    canceled_at VARCHAR(100) NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_agent_matrix_outbox_user_event (portal_user_id, event_key),
    INDEX idx_agent_matrix_outbox_dispatch (status, next_attempt_at, id),
    INDEX idx_agent_matrix_outbox_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- First rollout is inert until Matrix delivery and both engine adapters have
-- passed their end-to-end smoke tests. New portal users still default on.
INSERT IGNORE INTO versions (name, version, updated_at)
VALUES ('agent_portal_enabled', '0', '1970-01-01T00:00:00.000Z');
