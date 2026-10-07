-- Persistent opt-in subscriptions. Publications never copy private traffic.
CREATE TABLE IF NOT EXISTS agent_bus_groups (
  id CHAR(36) NOT NULL PRIMARY KEY,
  slug VARCHAR(64) NOT NULL,
  title VARCHAR(120) NOT NULL,
  description VARCHAR(1024) NULL,
  created_by_address_id CHAR(36) NOT NULL,
  created_at VARCHAR(100) NOT NULL,
  updated_at VARCHAR(100) NOT NULL,
  UNIQUE KEY uq_agent_bus_groups_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The generated fresh-install baseline inherits the database collation;
-- legacy installs created addresses explicitly as unicode_ci. UUID joins
-- must match that authoritative table on either supported installation.
SET @agent_bus_collation := (SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_bus_addresses');
SET @ddl := IF((SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_bus_groups') <> @agent_bus_collation,
  CONCAT('ALTER TABLE agent_bus_groups CONVERT TO CHARACTER SET utf8mb4 COLLATE ', @agent_bus_collation), 'DO 0');
PREPARE align_group_collation FROM @ddl;
EXECUTE align_group_collation;
DEALLOCATE PREPARE align_group_collation;

CREATE TABLE IF NOT EXISTS agent_bus_subscriptions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  topic VARCHAR(80) NOT NULL,
  subscriber_address_id CHAR(36) NOT NULL,
  created_at VARCHAR(100) NOT NULL,
  UNIQUE KEY uq_agent_bus_subscriptions_topic_address (topic, subscriber_address_id),
  INDEX idx_agent_bus_subscriptions_address (subscriber_address_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @ddl := IF((SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_bus_subscriptions') <> @agent_bus_collation,
  CONCAT('ALTER TABLE agent_bus_subscriptions CONVERT TO CHARACTER SET utf8mb4 COLLATE ', @agent_bus_collation), 'DO 0');
PREPARE align_subscription_collation FROM @ddl;
EXECUTE align_subscription_collation;
DEALLOCATE PREPARE align_subscription_collation;

-- Immutable metadata and delivery receipt snapshots make retries independent
-- of subsequent membership changes; message bodies remain secretbox encrypted
-- in the existing durable agent_bus_messages queue.
CREATE TABLE IF NOT EXISTS agent_bus_publications (
  id CHAR(36) NOT NULL PRIMARY KEY,
  topic VARCHAR(80) NOT NULL,
  sender_address_id CHAR(36) NOT NULL,
  client_message_id CHAR(36) NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  content_bytes INT UNSIGNED NOT NULL,
  ttl_seconds INT UNSIGNED NOT NULL,
  receipts JSON NOT NULL,
  created_at VARCHAR(100) NOT NULL,
  UNIQUE KEY uq_agent_bus_publications_sender_client (sender_address_id, client_message_id),
  INDEX idx_agent_bus_publications_rate (sender_address_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @ddl := IF((SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_bus_publications') <> @agent_bus_collation,
  CONCAT('ALTER TABLE agent_bus_publications CONVERT TO CHARACTER SET utf8mb4 COLLATE ', @agent_bus_collation), 'DO 0');
PREPARE align_publication_collation FROM @ddl;
EXECUTE align_publication_collation;
DEALLOCATE PREPARE align_publication_collation;
