CREATE TABLE IF NOT EXISTS session_housekeeping_reservations (
 host_id BIGINT UNSIGNED NOT NULL, engine VARCHAR(16) NOT NULL,
 token CHAR(36) NOT NULL, created_at VARCHAR(100) NOT NULL,
 UNIQUE KEY uq_housekeeping_host_engine (host_id, engine),
 CONSTRAINT fk_housekeeping_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
