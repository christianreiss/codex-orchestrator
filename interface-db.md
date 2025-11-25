# Database Interface (Source of Truth)

All tables are migrated on boot (MySQL only).

- **hosts** — `id`, `fqdn`, `api_key`, `status`, `allow_roaming_ips`, `last_refresh`, `auth_digest`, `ip`, `client_version`, `wrapper_version`, `api_calls`, `created_at`, `updated_at`.
- **auth_payloads** — canonical auth snapshots (`id`, `last_refresh`, `sha256`, `source_host_id`, `body` canonical `auth.json`, `created_at`).
- **auth_entries** — per-target tokens for each payload (`payload_id` FK, `target`, `token`, `token_type`, `organization`, `project`, `api_base`, `meta` JSON, `created_at`).
- **host_auth_states** — last canonical payload served per host (`host_id` FK, `payload_id`, `seen_digest`, `seen_at`).
- **host_auth_digests** — up to three recent digests per host (`host_id` FK, `digest`, `last_seen`, `created_at`; unique per host/digest).
- **token_usages** — per-host token usage rows from `/usage` (`host_id` FK nullable, `total`, `input_tokens`, `output_tokens`, `cached_tokens`, `reasoning_tokens`, `model`, `line`, `created_at`). `/usage` can submit multiple rows at once; admin aggregations surface these as `total`/`input`/`output`/`cached`/`reasoning`.
- **chatgpt_usage_snapshots** — account-level ChatGPT `/wham/usage` snapshots (`host_id` nullable, `status`, `plan_type`, `rate_allowed`/`rate_limit_reached`, primary/secondary window usage + limits/reset timing, credit flags/balance, `approx_local_messages`/`approx_cloud_messages`, `raw` body, `error`, `fetched_at`, `next_eligible_at`, `created_at`).
- **pricing_snapshots** — model pricing (`model`, `currency`, `input_price_per_1k`, `output_price_per_1k`, `cached_price_per_1k`, `source_url`, `raw` body, `fetched_at`, `created_at`).
- **install_tokens** — single-use installer tokens (`token` UUID, `host_id` FK, `fqdn`, `api_key`, `base_url`, `expires_at`, `used_at`, `created_at`).
- **versions** — key/value version store (`name`, `version`, `updated_at`) used for published client/wrapper versions, canonical payload pointer, runner metadata, and flags such as `api_disabled`.
- **logs** — audit events (`id`, `host_id` nullable FK, `action`, `details` JSON, `created_at`).
