-- Existing instances remain developer installations. Fresh baselines seed user mode.
INSERT INTO versions (name, version, updated_at) VALUES ('feedback_mode', 'source_developer', '2026-10-20T00:00:00.000Z')
ON DUPLICATE KEY UPDATE name = VALUES(name);
CREATE TABLE IF NOT EXISTS feedback_pipeline (
 feedback_id CHAR(36) NOT NULL PRIMARY KEY,
 version_state VARCHAR(24) NOT NULL DEFAULT 'unknown',
 review_state VARCHAR(24) NOT NULL DEFAULT 'pending',
 delivery_state VARCHAR(24) NOT NULL DEFAULT 'local',
 created_commit CHAR(40) NULL,
 tested_commit CHAR(40) NULL,
 upstream_commit CHAR(40) NULL,
 evidence JSON NOT NULL,
 github_issue_number INT NULL,
 github_url VARCHAR(1000) NULL,
 reason VARCHAR(2000) NULL,
 lease_token CHAR(36) NULL,
 lease_expires_at VARCHAR(100) NULL,
 next_attempt_at VARCHAR(100) NULL,
 attempts INT NOT NULL DEFAULT 0,
 updated_at VARCHAR(100) NOT NULL,
 INDEX idx_feedback_pipeline_due (next_attempt_at, lease_expires_at),
 CONSTRAINT fk_feedback_pipeline_item FOREIGN KEY (feedback_id) REFERENCES feedback_items(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
