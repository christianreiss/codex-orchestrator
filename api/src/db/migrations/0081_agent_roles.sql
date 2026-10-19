-- Agent roles: versioned role packages, per-address assignments and the
-- self-mutating proposal pipeline. Additive and idempotent; no data is seeded.
CREATE TABLE IF NOT EXISTS agent_roles (
 id CHAR(36) NOT NULL PRIMARY KEY,
 slug VARCHAR(64) NOT NULL,
 display_name VARCHAR(255) NOT NULL,
 summary VARCHAR(600) NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'active',
 current_version_id CHAR(36) NULL,
 policy JSON NOT NULL,
 version INT NOT NULL DEFAULT 1,
 created_at VARCHAR(100) NOT NULL,
 updated_at VARCHAR(100) NOT NULL,
 UNIQUE INDEX uq_agent_roles_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_role_versions (
 id CHAR(36) NOT NULL PRIMARY KEY,
 role_id CHAR(36) NOT NULL,
 version INT NULL,
 state VARCHAR(16) NOT NULL,
 manifest LONGTEXT NOT NULL,
 manifest_sha256 CHAR(64) NOT NULL,
 bundle_sha256 CHAR(64) NOT NULL,
 changelog TEXT NULL,
 created_by JSON NOT NULL,
 published_by JSON NULL,
 published_at VARCHAR(100) NULL,
 withdrawn_at VARCHAR(100) NULL,
 source_proposal_id CHAR(36) NULL,
 reverted_from_version INT NULL,
 created_at VARCHAR(100) NOT NULL,
 updated_at VARCHAR(100) NOT NULL,
 UNIQUE INDEX uq_agent_role_versions_number (role_id, version),
 INDEX idx_agent_role_versions_state (role_id, state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_role_blobs (
 sha256 CHAR(64) NOT NULL PRIMARY KEY,
 encoding VARCHAR(8) NOT NULL,
 content LONGTEXT NOT NULL,
 size_bytes INT NOT NULL,
 created_at VARCHAR(100) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_role_version_files (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 version_id CHAR(36) NOT NULL,
 path VARCHAR(512) NOT NULL,
 blob_sha256 CHAR(64) NOT NULL,
 mime_type VARCHAR(127) NOT NULL,
 load_mode VARCHAR(16) NOT NULL,
 description VARCHAR(300) NULL,
 introduced_in_version INT NULL,
 source_proposal_id CHAR(36) NULL,
 UNIQUE INDEX uq_agent_role_version_files_path (version_id, path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_role_assignments (
 id CHAR(36) NOT NULL PRIMARY KEY,
 address_id CHAR(36) NOT NULL,
 active_address_id CHAR(36) NULL,
 role_id CHAR(36) NOT NULL,
 version_id CHAR(36) NOT NULL,
 status VARCHAR(16) NOT NULL,
 binding_generation INT NOT NULL,
 activated_by JSON NOT NULL,
 reason TEXT NOT NULL,
 client_request_id CHAR(36) NOT NULL,
 previous_assignment_id CHAR(36) NULL,
 ended_at VARCHAR(100) NULL,
 end_reason VARCHAR(32) NULL,
 created_at VARCHAR(100) NOT NULL,
 updated_at VARCHAR(100) NOT NULL,
 UNIQUE INDEX uq_agent_role_assignments_active (active_address_id),
 UNIQUE INDEX uq_agent_role_assignments_request (address_id, client_request_id),
 INDEX idx_agent_role_assignments_role (role_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_role_proposals (
 id CHAR(36) NOT NULL PRIMARY KEY,
 role_id CHAR(36) NOT NULL,
 author_address_id CHAR(36) NOT NULL,
 client_request_id CHAR(36) NOT NULL,
 base_version_id CHAR(36) NOT NULL,
 kind VARCHAR(24) NOT NULL,
 risk VARCHAR(16) NOT NULL,
 title VARCHAR(255) NOT NULL,
 rationale TEXT NOT NULL,
 evidence JSON NOT NULL,
 ops JSON NOT NULL,
 author JSON NOT NULL,
 status VARCHAR(16) NOT NULL,
 version INT NOT NULL DEFAULT 1,
 gate_results JSON NULL,
 judge JSON NULL,
 reviews JSON NOT NULL,
 reviewer_address_id CHAR(36) NULL,
 review_requested_at VARCHAR(100) NULL,
 attempts INT NOT NULL DEFAULT 0,
 next_attempt_at VARCHAR(100) NULL,
 decision_note TEXT NULL,
 result_version_id CHAR(36) NULL,
 created_at VARCHAR(100) NOT NULL,
 updated_at VARCHAR(100) NOT NULL,
 UNIQUE INDEX uq_agent_role_proposals_request (author_address_id, client_request_id),
 INDEX idx_agent_role_proposals_role (role_id, status),
 INDEX idx_agent_role_proposals_due (status, next_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_role_proposal_events (
 id CHAR(36) NOT NULL PRIMARY KEY,
 proposal_id CHAR(36) NOT NULL,
 seq INT NOT NULL,
 action VARCHAR(32) NOT NULL,
 actor JSON NOT NULL,
 detail JSON NOT NULL,
 created_at VARCHAR(100) NOT NULL,
 UNIQUE INDEX uq_agent_role_proposal_events_seq (proposal_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
