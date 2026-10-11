CREATE TABLE IF NOT EXISTS host_spawns (
 id CHAR(36) NOT NULL PRIMARY KEY,
 source_host_id BIGINT UNSIGNED NOT NULL, target_host_id BIGINT UNSIGNED NOT NULL,
 client_message_id CHAR(36) NOT NULL, request_hash CHAR(64) NOT NULL,
 request JSON NOT NULL, installer_enc LONGTEXT NOT NULL,
 installer_revision INT NOT NULL DEFAULT 0, renewal_receipts JSON NOT NULL, renewal_client_message_id CHAR(36) NULL,
 setup_completed_at VARCHAR(100) NULL, created_at VARCHAR(100) NOT NULL, updated_at VARCHAR(100) NOT NULL,
 UNIQUE KEY uq_host_spawn_client(source_host_id,client_message_id),
 UNIQUE KEY uq_host_spawn_target(target_host_id),
 FOREIGN KEY (target_host_id) REFERENCES hosts(id) ON DELETE CASCADE
) ENGINE=InnoDB;
