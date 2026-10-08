-- Additive execution contract: existing in-flight deliveries remain legacy.
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_bus_messages' AND COLUMN_NAME='execution_contract_version')=0, 'ALTER TABLE agent_bus_messages ADD COLUMN execution_contract_version INT UNSIGNED NOT NULL DEFAULT 1', 'SELECT 1');
PREPARE change_contract FROM @ddl; EXECUTE change_contract; DEALLOCATE PREPARE change_contract;
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_bus_messages' AND COLUMN_NAME='work_kind')=0, 'ALTER TABLE agent_bus_messages ADD COLUMN work_kind VARCHAR(16) NULL', 'SELECT 1');
PREPARE change_contract FROM @ddl; EXECUTE change_contract; DEALLOCATE PREPARE change_contract;
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_bus_messages' AND COLUMN_NAME='task_result_status')=0, 'ALTER TABLE agent_bus_messages ADD COLUMN task_result_status VARCHAR(16) NULL', 'SELECT 1');
PREPARE change_contract FROM @ddl; EXECUTE change_contract; DEALLOCATE PREPARE change_contract;
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_bus_messages' AND COLUMN_NAME='execution_version')=0, 'ALTER TABLE agent_bus_messages ADD COLUMN execution_version INT UNSIGNED NOT NULL DEFAULT 1', 'SELECT 1');
PREPARE change_contract FROM @ddl; EXECUTE change_contract; DEALLOCATE PREPARE change_contract;
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_schedules' AND COLUMN_NAME='max_recovery_attempts')=0, 'ALTER TABLE agent_schedules ADD COLUMN max_recovery_attempts INT UNSIGNED NULL', 'SELECT 1');
PREPARE change_contract FROM @ddl; EXECUTE change_contract; DEALLOCATE PREPARE change_contract;
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_schedules' AND COLUMN_NAME='pause_reason')=0, 'ALTER TABLE agent_schedules ADD COLUMN pause_reason VARCHAR(100) NULL', 'SELECT 1');
PREPARE change_contract FROM @ddl; EXECUTE change_contract; DEALLOCATE PREPARE change_contract;
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_schedule_runs' AND COLUMN_NAME='max_recovery_attempts')=0, 'ALTER TABLE agent_schedule_runs ADD COLUMN max_recovery_attempts INT UNSIGNED NULL', 'SELECT 1');
PREPARE change_contract FROM @ddl; EXECUTE change_contract; DEALLOCATE PREPARE change_contract;
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_schedule_runs' AND COLUMN_NAME='warning_at')=0, 'ALTER TABLE agent_schedule_runs ADD COLUMN warning_at VARCHAR(100) NULL', 'SELECT 1');
PREPARE change_contract FROM @ddl; EXECUTE change_contract; DEALLOCATE PREPARE change_contract;
CREATE TABLE IF NOT EXISTS agent_task_results (
 id CHAR(36) NOT NULL PRIMARY KEY,
 message_id CHAR(36) NOT NULL,
 claim_id CHAR(36) NOT NULL,
 status VARCHAR(16) NOT NULL,
 body_enc LONGTEXT NOT NULL,
 body_sha256 CHAR(64) NOT NULL,
 created_at VARCHAR(100) NOT NULL,
 UNIQUE KEY uq_agent_task_result_claim (message_id, claim_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS agent_fresh_start_grants (
 message_id CHAR(36) NOT NULL PRIMARY KEY,
 target_address_id CHAR(36) NOT NULL,
 binding_generation INT UNSIGNED NOT NULL,
 execution_version INT UNSIGNED NOT NULL,
 reason VARCHAR(500) NOT NULL,
 approved_by VARCHAR(191) NOT NULL,
 consumed_claim_id CHAR(36) NULL,
 created_at VARCHAR(100) NOT NULL,
 consumed_at VARCHAR(100) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
SET @bus_collation := (SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_bus_addresses');
SET @ddl := CONCAT('ALTER TABLE agent_task_results CONVERT TO CHARACTER SET utf8mb4 COLLATE ', @bus_collation);
PREPARE align_contract FROM @ddl; EXECUTE align_contract; DEALLOCATE PREPARE align_contract;
SET @ddl := CONCAT('ALTER TABLE agent_fresh_start_grants CONVERT TO CHARACTER SET utf8mb4 COLLATE ', @bus_collation);
PREPARE align_contract FROM @ddl; EXECUTE align_contract; DEALLOCATE PREPARE align_contract;

-- Upgrade only unclaimed work. Already executing old adapters finish unchanged.
UPDATE agent_bus_messages SET execution_contract_version=2, work_kind=kind WHERE execution_contract_version=1 AND status='queued' AND kind IN ('request','schedule','task');
UPDATE agent_bus_messages AS message INNER JOIN agent_bus_conference_members AS member ON member.dispatch_message_id=message.id SET message.execution_contract_version=2, message.work_kind='task' WHERE message.execution_contract_version=1 AND message.status='queued';
