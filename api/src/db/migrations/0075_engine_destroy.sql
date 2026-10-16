-- Fleet-wide "destroy engine": per-host progress of a destroy request.
CREATE TABLE IF NOT EXISTS engine_destroy_hosts (
  request_id CHAR(36) NOT NULL,
  host_id BIGINT UNSIGNED NOT NULL,
  engine VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  residue_json TEXT NULL,
  reported_at VARCHAR(100) NULL,
  created_at VARCHAR(100) NOT NULL,
  PRIMARY KEY (request_id, host_id),
  KEY idx_engine_destroy_engine (engine, status),
  CONSTRAINT fk_engine_destroy_host FOREIGN KEY (host_id) REFERENCES hosts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
