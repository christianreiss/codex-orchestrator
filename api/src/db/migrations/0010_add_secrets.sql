-- Fleet secrets store: the WORKING credentials agents use once they are running.
--
-- This is deliberately NOT engine-boot auth. `auth_payloads` /
-- `auth_canonical_heads` / `openai_api_keys` hold the Anthropic and OpenAI login
-- material that gets an agent *started*, behind a live runner-verification gate.
-- This table holds the GitHub PATs, database passwords, Bookstack and Checkmk
-- tokens, SSH keys and third-party API keys an agent needs to do its job.
-- Different lifecycle, different consumers, different blast radius; the two are
-- never merged, and nothing here is ever promoted into a canonical auth head.
--
-- Delivery is MCP-only. Nothing in this table is ever written to a host
-- filesystem, so there is no ownership ledger to maintain, no
-- strip-on-trust-loss pass in the wrapper, and revocation is one UPDATE that
-- takes effect on the next `secret_get`.
--
-- `value_enc` is the only copy of the value and always holds an `sbox:v1:`
-- envelope (api/src/security/secret-box.ts). There is no plaintext column, and
-- there is deliberately no `value_sha256`: a digest of a human-chosen password
-- or token is offline-crackable, so storing one beside the ciphertext would hand
-- a database-dump attacker exactly what the envelope exists to deny them.
-- "Did the value change?" is answered by decrypt-and-compare on update, where
-- the keyring is already in hand.
--
-- Idempotency: the whole file is one `CREATE TABLE IF NOT EXISTS`. Unlike 0003
-- and 0006 it needs no `information_schema` guard behind `PREPARE`/`EXECUTE`,
-- because every index it declares is inline in that statement and expressible in
-- schema.ts — so a database built by `drizzle-kit push` or from
-- test/fixtures/schema-baseline.sql already has all of them. Those files carry
-- guards only for FULLTEXT indexes and foreign keys, which drizzle-orm's
-- mysql-core cannot express; this table declares neither.
--
-- `slug` is VARCHAR(96) rather than the 160 used by `shared_memories` because
-- the MCP audit trail writes `secret_get:<slug>` into `mcp_access_logs.name`,
-- which is VARCHAR(128). 11 + 96 fits with headroom; a longer slug would
-- silently truncate the audit row.
--
-- The utf8mb4_unicode_ci collation makes `uniq_secrets_slug` case-insensitive.
-- SecretsService lower-cases every slug on write so the constraint and the
-- lookup agree rather than diverging on the first mixed-case entry.

CREATE TABLE IF NOT EXISTS secrets (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    slug VARCHAR(96) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT NULL,
    value_enc LONGTEXT NOT NULL,
    engine VARCHAR(16) NULL,
    tags JSON NULL,
    tags_text TEXT NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    last_rotated_at VARCHAR(100) NULL,
    deleted_at VARCHAR(100) NULL,
    UNIQUE KEY uniq_secrets_slug (slug),
    INDEX idx_secrets_engine (engine),
    INDEX idx_secrets_updated_at (updated_at),
    INDEX idx_secrets_deleted_at (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
