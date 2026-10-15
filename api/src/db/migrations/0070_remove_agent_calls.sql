-- Direct messaging supersedes two-agent call rendezvous. Keep conversation history.
SET @drop_call_pin_index = IF(EXISTS (
  SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'agent_bus_addresses' AND INDEX_NAME = 'uq_agent_bus_addresses_call_pin'
), 'ALTER TABLE agent_bus_addresses DROP INDEX uq_agent_bus_addresses_call_pin', 'SELECT 1');
PREPARE stmt FROM @drop_call_pin_index;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @drop_call_pin = IF(EXISTS (
  SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'agent_bus_addresses' AND COLUMN_NAME = 'call_pin'
), 'ALTER TABLE agent_bus_addresses DROP COLUMN call_pin', 'SELECT 1');
PREPARE stmt FROM @drop_call_pin;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @drop_call_pin_expiry = IF(EXISTS (
  SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'agent_bus_addresses' AND COLUMN_NAME = 'call_pin_expires_at'
), 'ALTER TABLE agent_bus_addresses DROP COLUMN call_pin_expires_at', 'SELECT 1');
PREPARE stmt FROM @drop_call_pin_expiry;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Retire canonical copies on existing installations; normal Skill sync prunes native copies.
UPDATE skills SET deleted_at = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.000Z'),
  updated_at = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.000Z')
WHERE slug = 'call' AND deleted_at IS NULL;
