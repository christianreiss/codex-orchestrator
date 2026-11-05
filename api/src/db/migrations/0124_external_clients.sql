-- External clients (docs/external-clients.md): bots and bridges that take part in
-- agent messaging through the REST Communication Interface instead of a cdx/clx/cgx
-- wrapper. One row per client; the bearer key is stored only as a SHA-256 hash.
-- Sessions and addresses of these clients live under one server-owned host
-- (hosts.internal_role = 'external', created at boot), never a fleet host.
-- Idempotent: CREATE TABLE IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS external_clients (
 id char(36) NOT NULL,
 name varchar(96) NOT NULL,
 name_key varchar(96) NOT NULL,
 description varchar(160) NOT NULL DEFAULT '',
 trust varchar(16) NOT NULL DEFAULT 'untrusted',
 enabled tinyint NOT NULL DEFAULT 0,
 key_hash char(64) NOT NULL,
 key_prefix varchar(16) NOT NULL,
 bridge_secret char(64) NOT NULL,
 session_id char(36) NULL,
 address_id char(36) NULL,
 last_poll_at varchar(100) NULL,
 created_by_admin_id int unsigned NULL,
 created_at varchar(100) NOT NULL,
 updated_at varchar(100) NOT NULL,
 disabled_at varchar(100) NULL,
 PRIMARY KEY (id),
 UNIQUE KEY uq_external_clients_name (name_key),
 UNIQUE KEY uq_external_clients_key (key_hash)
);
