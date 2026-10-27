-- Durable supervisor state; disabled until explicitly enabled by an operator.
CREATE TABLE IF NOT EXISTS agent_work_states (
 address_id CHAR(36) NOT NULL PRIMARY KEY, session_id CHAR(36) NOT NULL,
 binding_generation INT NOT NULL, native_session_id VARCHAR(255) NOT NULL,
 task_key VARCHAR(255) NOT NULL, model VARCHAR(255) NULL, turn_id VARCHAR(255) NULL, state VARCHAR(24) NOT NULL, reason VARCHAR(1000) NULL,
 waiting_for_address_id CHAR(36) NULL, waiting_for_message_id CHAR(36) NULL,
 coordinator_address_id CHAR(36) NULL, last_progress_at VARCHAR(100) NOT NULL,
 reminder_at VARCHAR(100) NULL, incident_at VARCHAR(100) NULL, deadline_at VARCHAR(100) NULL,
 paused TINYINT NOT NULL DEFAULT 0, escalation VARCHAR(100) NULL, watchdog_id CHAR(36) NULL,
 version INT NOT NULL DEFAULT 1, updated_at VARCHAR(100) NOT NULL,
 INDEX idx_agent_work_session (session_id), INDEX idx_agent_work_wait (waiting_for_address_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_work_dependencies (
 id CHAR(36) NOT NULL PRIMARY KEY, waiter_address_id CHAR(36) NOT NULL,
 dependency_address_id CHAR(36) NOT NULL, message_id CHAR(36) NULL, workflow_task_id CHAR(36) NULL,
 status VARCHAR(24) NOT NULL DEFAULT 'waiting', reminder_at VARCHAR(100) NULL,
 created_at VARCHAR(100) NOT NULL, updated_at VARCHAR(100) NOT NULL,
 INDEX idx_agent_work_deps_waiter (waiter_address_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
