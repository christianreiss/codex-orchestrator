# Database Interface (Source of Truth)

All tables are migrated on boot (MySQL only).

- **hosts** — `id`, `fqdn`, `api_key` (sha256 hash), `api_key_hash` (same hash for legacy lookups), `api_key_enc` (secretbox-encrypted plaintext API key for baking wrappers), `status`, `secure` (default `1`), `allow_roaming_ips`, **`insecure_enabled_until`**, **`insecure_grace_until`**, **`insecure_window_minutes`** (desired sliding window length), `last_refresh`, `auth_digest`, `ip`, `client_version`, `wrapper_version` (legacy/unused), `api_calls`, `created_at`, `updated_at`.
- **auth_payloads** — canonical auth snapshots (`id`, `last_refresh`, `sha256`, `source_host_id`, `body` canonical `auth.json`, `created_at`); `body` is stored as a libsodium `secretbox` ciphertext (`sbox:v1:{base64}`) using `AUTH_ENCRYPTION_KEY`.
- **auth_entries** — per-target tokens for each payload (`payload_id` FK, `target`, `token`, `token_type`, `organization`, `project`, `api_base`, `meta` JSON, `created_at`); `token` is encrypted with the same `sbox:v1` secretbox key.
- **host_auth_states** — last canonical payload served per host (`host_id` FK, `payload_id`, `seen_digest`, `seen_at`).
- **host_auth_digests** — up to three recent digests per host (`host_id` FK, `digest`, `last_seen`, `created_at`; unique per host/digest).
- **host_users** — usernames per host for uninstall cleanup (`host_id` FK, `username`, optional `hostname`, `first_seen`, `last_seen`; unique per host/username).
- **token_usage_ingests** — one row per `/usage` POST for audit (`host_id` FK nullable, `entries` count, aggregated `total`/`input_tokens`/`output_tokens`/`cached_tokens`/`reasoning_tokens`, computed `cost` (DECIMAL 18,6), optional `client_ip`, normalized `payload`, `created_at`).
- **token_usages** — per-host token usage rows from `/usage` (`host_id` FK nullable, optional `ingest_id` FK into `token_usage_ingests`, `total`, `input_tokens`, `output_tokens`, `cached_tokens`, `reasoning_tokens`, computed `cost` (DECIMAL 18,6), `model`, `line`, `created_at`). `/usage` can submit multiple rows at once; admin aggregations surface these as `total`/`input`/`output`/`cached`/`reasoning` plus `cost`.
- **slash_commands** — server-side slash command prompts (`id`, `filename` unique, `sha256`, `description`, `argument_hint`, `prompt` body, `source_host_id` FK nullable, `created_at`, `updated_at`, `deleted_at` for retired prompts).
- **agents_documents** — canonical AGENTS.md (`id` always 1, `sha256`, `body`, optional `source_host_id` FK, `created_at`, `updated_at`; indexed by `updated_at`).
- **chatgpt_usage_snapshots** — account-level ChatGPT `/wham/usage` snapshots (`host_id` nullable, `status`, `plan_type`, `rate_allowed`/`rate_limit_reached`, primary/secondary window usage + limits/reset timing, credit flags/balance, `approx_local_messages`/`approx_cloud_messages`, `raw` body, `error`, `fetched_at`, `next_eligible_at`, `created_at`).
- **pricing_snapshots** — model pricing (`model`, `currency`, `input_price_per_1k`, `output_price_per_1k`, `cached_price_per_1k`, `source_url`, `raw` body, `fetched_at`, `created_at`).
- **install_tokens** — single-use installer tokens (`token` UUID, `host_id` FK, `fqdn`, `api_key`, `base_url`, `expires_at`, `used_at`, `created_at`); creation wipes prior pending tokens for the host so only one is active.
- **versions** — key/value version store (`name`, `version`, `updated_at`) used for the cached client version from GitHub (`client_available`), canonical payload pointer (`canonical_payload_id`), runner metadata (`runner_state`, `runner_last_ok`, `runner_last_fail`, `runner_last_check`, `runner_boot_id`, `daily_preflight` last preflight ISO timestamp), and flags such as `api_disabled` and `quota_hard_fail`.
- **logs** — audit events (`id`, `host_id` nullable FK, `action`, `details` JSON, `created_at`).
- **ip_rate_limits** — per-IP buckets for request throttling (`ip`, `bucket`, `count`, `reset_at`, `last_hit`, `created_at`; unique by `ip` + `bucket`, opportunistically pruned once expired). Used for the `global` and `auth-fail` buckets.

Encryption: `AUTH_ENCRYPTION_KEY` (libsodium secretbox) is generated into `.env` on first boot if missing. `api_key_enc`, `auth_payloads.body`, and `auth_entries.token` are stored as `sbox:v1` ciphertexts; `AuthEncryptionMigrator` backfills any legacy plaintext rows at startup.
