## Shared Header (reuse in agent prompts)
You are a coding agent (Codex) working **inside the project source tree**.

- Your working directory is the repository root.
- You are allowed to read and modify files in this repo, but you must keep changes focused, consistent and justified.
- Before changing anything, **read the existing docs**: `README.md`, `API.md`, `AGENTS.md`, `.env.example`, `docker-compose.yml`, and the relevant PHP/CLI files in `public/`, `src/`, and `bin/`.

Coordination rules with other agents:

- **Single source of truth**: Prefer *actual behavior in code* over outdated docs. If docs are wrong, fix the docs, don’t silently “fix” the behavior.
- **Assumptions are explicit**: Whenever you have to guess something, add an `## Assumptions` section to your Markdown output and list them clearly.
- **No unilateral breaking changes**: Do not change public HTTP routes, DB schema, or CLI flags/env names unless the task explicitly tells you to propose a change. If you see a mismatch, document it under `## Mismatches & Proposed Fixes`.
- **Contracts over prose**: Your primary deliverable is a precise machine‑or‑human‑readable contract (Markdown with tables, JSON examples, schemas, etc.), plus minimal code/test changes necessary to enforce or verify that contract.

Style rules:

- Be precise: list field names, types, nullability, allowed values, invariants, and edge‑case behavior.
- Add concrete examples (SQL snippets, HTTP examples, CLI examples) wherever they clarify the contract.
- Prefer incremental commits / local changes over massive refactors.

When you finish, ensure your files are self‑contained and can be read without having to open your prompt.

---

# Database Contract (Codex Auth Orchestrator)

## Engines & Configuration
- Runtime driver: **MySQL only**. `App\Database` throws if `DB_DRIVER` is not `mysql` (src/Database.php).
- Env keys (see `.env.example`, `docker-compose.yml`): `DB_DRIVER` (default `mysql`), `DB_HOST` (`mysql`), `DB_PORT` (`3306`), `DB_DATABASE` (`codex_auth`), `DB_USERNAME` (`codex`), `DB_PASSWORD` (`codex-pass`), `DB_CHARSET` (`utf8mb4`). Loaded via `App\Config` and dotenv; passed to PDO with `mysql:host={host};port={port};dbname={db};charset={charset}`.
- Collation: tables created with `DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`.
- Timestamps: stored as RFC3339 strings in `VARCHAR(100)` (keeps fractional seconds; compared lexically in queries such as pruning).
- Docker: `docker-compose.yml` runs MySQL 8.0 with a bind mount at `/var/docker_data/codex-auth.uggs.io/mysql_data`. API container mounts `/var/docker_data/codex-auth.uggs.io/store` to persist wrapper + SQL exports.
- Legacy SQLite: PDO sqlite extension exists only for migration. `bin/migrate-sqlite-to-mysql.php` copies data from an old SQLite file into MySQL; runtime API will not start with a SQLite driver.

## Schema at a Glance
- `hosts` — Host registry, API keys, IP binding, version metadata, sync stats.
- `auth_payloads` — Canonical auth snapshots (`last_refresh`, `sha256`, raw JSON body, source host).
- `auth_entries` — Normalized per-target auth tokens for a payload.
- `host_auth_states` — Last canonical payload + digest seen by each host (admin view).
- `host_auth_digests` — Recent digests per host (rolling cache, max 3).
- `logs` — Audit entries for register/auth/version/admin actions (includes runner events: `auth.validate`, `auth.runner_store` with triggers `daily_preflight` or `store`).
- `token_usages` — Token usage events reported via `/usage`.
- `versions` — Key/value store for published/observed versions and canonical payload pointer.

## Table Contracts

### hosts
Primary key: `id BIGINT UNSIGNED AUTO_INCREMENT`

| column | type | null/default | notes / usage |
| --- | --- | --- | --- |
| id | BIGINT UNSIGNED | PK | FK target for `auth_payloads.source_host_id`, `host_auth_states.host_id`, `host_auth_digests.host_id`, `logs.host_id`, `token_usages.host_id` |
| fqdn | VARCHAR(255) | NOT NULL, UNIQUE | Host identity; looked up on `/register` re-registrations |
| api_key | CHAR(64) | NOT NULL, UNIQUE | Per-host secret; rotated on re-register; required for all non-register endpoints |
| status | VARCHAR(32) | NOT NULL DEFAULT 'active' | `/auth` rejects when not `'active'` |
| allow_roaming_ips | TINYINT(1) | NOT NULL DEFAULT 0 | If 0, IP binding enforced; toggled by `POST /admin/hosts/{id}/roaming` |
| last_refresh | VARCHAR(100) | NULL | Server’s canonical `last_refresh` for the host; set in `HostRepository::updateSyncState` during `/auth` flows |
| auth_digest | VARCHAR(128) | NULL | Canonical digest snapshot; set alongside `last_refresh` |
| ip | VARCHAR(64) | NULL | First caller IP; updated on auth (or roaming/admin overrides); cleared by `POST /admin/hosts/{id}/clear` |
| client_version | VARCHAR(64) | NULL | Last reported Codex client version; refreshed every `/auth` |
| wrapper_version | VARCHAR(64) | NULL | Last reported cdx wrapper version; refreshed every `/auth` |
| api_calls | BIGINT UNSIGNED | NOT NULL DEFAULT 0 | Incremented once per `/auth` call |
| created_at | VARCHAR(100) | NOT NULL | RFC3339 string |
| updated_at | VARCHAR(100) | NOT NULL | RFC3339 string; used for inactivity pruning (30 days) |

Indexes / constraints:
- UNIQUE `fqdn`, UNIQUE `api_key`, INDEX `idx_hosts_updated_at (updated_at)`.
- No ON DELETE actions because this is the parent table.

### auth_payloads
Primary key: `id BIGINT UNSIGNED AUTO_INCREMENT`

| column | type | null/default | notes / usage |
| --- | --- | --- | --- |
| id | BIGINT UNSIGNED | PK | Referenced by `auth_entries.payload_id`, `host_auth_states.payload_id` |
| last_refresh | VARCHAR(100) | NOT NULL | Canonical `last_refresh` from the stored auth |
| sha256 | CHAR(64) | NOT NULL | Digest of the canonical auth JSON (as stored in `body`) |
| source_host_id | BIGINT UNSIGNED | NULL, FK → hosts(id) ON DELETE SET NULL | Host that uploaded this payload (not exposed in API responses) |
| body | LONGTEXT | NULL | Exact canonical auth JSON (compact, auths normalized); added via `ensureColumnExists` for legacy DBs |
| created_at | VARCHAR(100) | NOT NULL | Insert time |

Indexes / constraints:
- INDEX `idx_auth_payloads_last_refresh (last_refresh)`, INDEX `idx_auth_payloads_created_at (created_at)`.
- FK `source_host_id` ON DELETE SET NULL (payloads are retained if a host is deleted).

### auth_entries
Primary key: `id BIGINT UNSIGNED AUTO_INCREMENT`

| column | type | null/default | notes / usage |
| --- | --- | --- | --- |
| id | BIGINT UNSIGNED | PK |  |
| payload_id | BIGINT UNSIGNED | NOT NULL, FK → auth_payloads(id) ON DELETE CASCADE | Denormalized auth map for payload reconstruction |
| target | VARCHAR(255) | NOT NULL | Auth target key (e.g., API hostname) |
| token | TEXT | NOT NULL | Token value (stored verbatim) |
| token_type | VARCHAR(32) | DEFAULT 'bearer' | Normalized token type |
| organization | VARCHAR(255) | NULL | Optional org |
| project | VARCHAR(255) | NULL | Optional project |
| api_base | VARCHAR(255) | NULL | Optional base URL override |
| meta | JSON | NULL | Arbitrary extra scalar fields kept from incoming auth entry |
| created_at | VARCHAR(100) | NOT NULL | Insert time |

Indexes / constraints:
- UNIQUE (`payload_id`, `target`) to avoid duplicate targets per payload.
- INDEX `idx_entries_payload (payload_id)`.
- FK ON DELETE CASCADE ensures entries are removed when payload is deleted.

### host_auth_states
Primary key: `host_id BIGINT UNSIGNED`

| column | type | null/default | notes / usage |
| --- | --- | --- | --- |
| host_id | BIGINT UNSIGNED | PK, FK → hosts(id) ON DELETE CASCADE | One row per host |
| payload_id | BIGINT UNSIGNED | NOT NULL, FK → auth_payloads(id) ON DELETE CASCADE | Canonical payload last seen by this host |
| seen_digest | CHAR(64) | NOT NULL | Digest corresponding to `payload_id` |
| seen_at | VARCHAR(100) | NOT NULL | Timestamp of last sync that saw this payload |

Used in admin views to show whether a host is “authed” (matches canonical digest).

### host_auth_digests
Primary key: `id BIGINT UNSIGNED AUTO_INCREMENT`

| column | type | null/default | notes / usage |
| --- | --- | --- | --- |
| id | BIGINT UNSIGNED | PK |  |
| host_id | BIGINT UNSIGNED | NOT NULL, FK → hosts(id) ON DELETE CASCADE |  |
| digest | VARCHAR(128) | NOT NULL | Known digest for this host |
| last_seen | VARCHAR(100) | NOT NULL | Updated whenever digest observed |
| created_at | VARCHAR(100) | NOT NULL | Insert time |

Indexes / constraints:
- UNIQUE (`host_id`, `digest`); INDEX `idx_auth_digest_host (host_id)`.
- `HostAuthDigestRepository::rememberDigests` prunes to the latest 3 per host.

### logs
Primary key: `id BIGINT UNSIGNED AUTO_INCREMENT`

| column | type | null/default | notes / usage |
| --- | --- | --- | --- |
| id | BIGINT UNSIGNED | PK |  |
| host_id | BIGINT UNSIGNED | NULL, FK → hosts(id) ON DELETE SET NULL | Null when action isn’t host-specific |
| action | VARCHAR(64) | NOT NULL | e.g., `register`, `auth.retrieve`, `auth.store`, `auth.validate`, `auth.runner_store`, `token.usage`, `admin.host.clear` |
| details | LONGTEXT | NULL | JSON string blob (not validated by DB) |
| created_at | VARCHAR(100) | NOT NULL | Insert time |

Indexes / constraints:
- INDEX `idx_logs_host (host_id)`, INDEX `idx_logs_created_at (created_at)`.

### token_usages
Primary key: `id BIGINT UNSIGNED AUTO_INCREMENT`

| column | type | null/default | notes / usage |
| --- | --- | --- | --- |
| id | BIGINT UNSIGNED | PK |  |
| host_id | BIGINT UNSIGNED | NULL, FK → hosts(id) ON DELETE SET NULL | Set when API key is valid |
| total | BIGINT UNSIGNED | NULL | Optional aggregate tokens |
| input_tokens | BIGINT UNSIGNED | NULL | Optional input tokens |
| output_tokens | BIGINT UNSIGNED | NULL | Optional output tokens |
| cached_tokens | BIGINT UNSIGNED | NULL | Optional cached tokens |
| model | VARCHAR(128) | NULL | Optional model string |
| line | TEXT | NULL | Raw usage line if provided |
| created_at | VARCHAR(100) | NOT NULL | Insert time |

Indexes / constraints:
- INDEX `idx_token_usage_host (host_id)`, INDEX `idx_token_usage_created_at (created_at)`.
- Aggregated for admin overview and per-host totals.

### versions
Primary key: `name VARCHAR(191)`

| column | type | null/default | notes / usage |
| --- | --- | --- | --- |
| name | VARCHAR(191) | PK | Acts as KV key |
| version | VARCHAR(191) | NOT NULL | Value (string or boolean-like) |
| updated_at | VARCHAR(100) | NOT NULL | Insert/update time |

Known keys:
- `canonical_payload_id` — points to `auth_payloads.id` chosen as canonical (stringified).
- `client_available` — cached latest client version from GitHub with 3h TTL.
- `client` — operator-published client version (`POST /versions`).
- `wrapper` — operator/seeded wrapper version.
- `api_disabled` — `'1'`/`'0'`; when `'1'` `/auth` returns 503.

## API ↔ DB Mapping
- `POST /register`: inserts or rotates row in `hosts` (api_key, status, timestamps); logs `register`; returns host payload (includes api_key).
- `POST /auth` (retrieve/store):
  - Authenticates host via `hosts.api_key` + `ip` binding (`hosts.ip`, `allow_roaming_ips`).
  - Updates `hosts.client_version`, `hosts.wrapper_version`, increments `hosts.api_calls`.
  - Maintains digest cache in `host_auth_digests` (max 3) and host state in `host_auth_states`.
  - On `store` when newer: inserts into `auth_payloads` (+ `auth_entries`), sets `versions.canonical_payload_id`, updates `hosts.last_refresh`/`auth_digest`, logs `auth.store`.
  - On `retrieve`: uses canonical payload/digests to decide status; may update `host_auth_states` and `hosts` sync fields; logs `auth.retrieve`.
- `DELETE /auth`: authenticates then deletes host row; cascades remove `host_auth_states`/`host_auth_digests`; `auth_payloads` remain but `source_host_id` FKs are nulled; logs `host.delete`.
- `POST /usage`: inserts into `token_usages`, logs `token.usage`; uses `host_id` FK if API key valid.
- `GET/POST /versions`: reads/writes `versions` keys (`client`, `wrapper`, `client_available`, `api_disabled`); `POST` also logs `version.publish`.
- `GET /wrapper`, `/wrapper/download`, `POST /wrapper`: wrapper metadata/version read from or written to `versions.wrapper`; file stored on disk, not DB.
- Admin endpoints:
  - `/admin/overview` aggregates from `hosts`, `token_usages`, `logs`, `versions`.
  - `/admin/hosts` joins `hosts` with `host_auth_states` and `host_auth_digests`, adds token usage totals.
  - `/admin/hosts/{id}/auth` fetches latest canonical payload (`auth_payloads` + `auth_entries`) and host state.
  - `/admin/hosts/{id}/clear` clears `hosts.ip` and `host_auth_digests` rows.
  - `/admin/hosts/{id}/roaming` toggles `hosts.allow_roaming_ips`.
  - `/admin/api/state` toggles `versions.api_disabled`.
- Housekeeping: `AuthService::pruneInactiveHosts` removes `hosts` where `updated_at` is >30 days old; cascade removes `host_auth_states`/`host_auth_digests`, FKs set NULL on dependent tables.

## Migration & Compatibility Notes
- `Database::migrate()` (src/Database.php) creates all tables above and then backfills columns via `ensureColumnExists`:
  - `hosts`: `ip`, `client_version`, `wrapper_version`, `auth_digest`, `api_calls`, `allow_roaming_ips`.
  - `auth_payloads`: `body` (LONGTEXT).
  - No automatic backfill for indexes beyond those in the CREATE statements.
- Legacy SQLite migration: `bin/migrate-sqlite-to-mysql.php` copies `hosts`, `logs`, `host_auth_digests`, `versions` only; it does **not** migrate canonical payload bodies/entries or token usage data (older SQLite schema stored inline auth). After migration, a fresh `/auth store` should reseed canonical payloads.
- Runtime driver guard: even if `DB_DRIVER` is set, only `mysql` is accepted; PDO SQLite is unused after migration.
- Timestamps must stay RFC3339 (with optional fractional seconds) so lexical comparisons (`updated_at < cutoff`) remain valid; malformed timestamps can break pruning/order guarantees.
- `auth_payloads.body` is added via ALTER; first boot on a new DB will run an extra `ALTER TABLE auth_payloads ADD COLUMN body LONGTEXT NULL`.

## Assumptions & Mismatches
- Undocumented tables: `auth_entries`, `host_auth_states`, and `token_usages` are part of the live schema but are not described in `README.md`/`API.md`; this document treats the code as the source of truth.
- `/admin/hosts/{id}/auth` uses the global canonical payload (from `versions.canonical_payload_id` or latest) rather than a host-specific snapshot; assume canonical auth is global.
- `auth_payloads.source_host_id` is stored but never surfaced in API responses; assumed audit-only.
- All date/time strings are expected to be ISO/RFC3339 with `Z`; behavior is undefined if other formats are inserted manually.

## Potential Deletions / Technical Debt
- Timestamps stored as `VARCHAR` rather than `DATETIME` rely on consistent formatting for ordering and pruning.
- Older databases that predate `body`/`api_calls`/`allow_roaming_ips` rely on `information_schema` access for backfill; deployments without that privilege would miss columns.
- Migration script omits `auth_payloads`/`auth_entries`/`host_auth_states`/`token_usages`; operators must reseed canonical auth after migrating from SQLite.
- `hosts.auth_digest` duplicates `host_auth_states.seen_digest`; both are kept for backward compatibility/admin display. No code path prunes stale `auth_payloads`.

## References
- Schema DDL and backfill: `src/Database.php`
- Repositories driving each table: `src/Repositories/*.php`
- API routes touching the DB: `public/index.php`
- Migration helper: `bin/migrate-sqlite-to-mysql.php`
