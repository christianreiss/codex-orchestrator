# Overview

## What it is

Small Node 22 + Fastify + Drizzle + MySQL service that keeps canonical Codex and Claude credentials for every host in your fleet. Hosts talk to `/auth` (retrieve/store) with per-host API keys baked into their `cdx`/`clx` wrappers. The same API also ships Skills, shared project coordination, token-usage telemetry, ChatGPT/Claude usage snapshots,.

## Primary use cases

- Centralize `auth.json` instead of managing per-host logins.
- Bake a one-time installer per host (API key + base URL) and keep hosts in sync automatically.
- Audit who synced/rotated auth, what versions they run, and how many tokens they burn.
- Run Codex in environments that require IP binding, mTLS, and rate limits.

## Contract guardrails

- Critical host-facing response contracts are machine-readable under `docs/contracts/`:
  - `auth-retrieve.schema.json`
  - `auth-store.schema.json`
  - `versions.schema.json`
  - `sync-status.schema.json`
  - `sync-bootstrap.schema.json`
- CI validates contract coverage by replaying the recorded fixtures under `api/test/contract/fixtures/` (one per schema above) through the host-api app on the in-memory db-fake (`api/test/contract/contract.test.ts`) and through the integration suites under `api/test/integration/`. The host-facing ones (`api/test/integration/host-api/`) run on the same fake, so a plain `npm test` covers them without a database.

## Why teams use it

- One `/auth` call decides whether to accept a client upload or return the canonical copy and always includes versions + quota metadata.
- Per-host API keys are hashed/encrypted at rest, IP-bound on first use, and rotated when a host is re-registered.
- Canonical auth + per-target tokens are encrypted with libsodium `secretbox`; the key is bootstrapped into `.env` on first boot. Optional keyring mode (`AUTH_ENCRYPTION_KEYS` + `AUTH_ENCRYPTION_ACTIVE_KID`) supports rotation with `kid`-tagged ciphertext.
- Safety rails: global/auth-fail rate limits, API kill switch, token quality checks, RFC3339 timestamp bounds, optional IP roaming, and opt-in insecure-host gates.
- Runner sidecar validates canonical auth from a background worker (default every 5m, TTL 15m) and synchronously validates every store. Only a positive live verdict can advance canonical auth or make bytes distributable; unavailable/inconclusive runner results leave existing verified auth readable but block host, admin, seed, and bootstrap uploads.
- Extras ride the same API: canonical Skill distribution (including an optional,
  provenance-tracked Matt Pocock source), native project coordination
  (notes/todos/files/feedback/activity), host-scoped MCP memories,
  project-scoped memory facts, the fleet-wide shared memory corpus
  (`shared_memory_*`), encrypted Agent Messaging across Codex and Claude, and
  ChatGPT `/wham/usage` snapshots.

## Key components (code map)

- **`api/src/server.ts` boot** — boots env, key manager + secretbox, Drizzle client, services, the auth-verification worker, global rate limiting, and registers all routes under `api/src/routes/*` (host/admin/installer/seed/auth/sync/skills/projects/agents/config/MCP/chatgpt/versions). Drizzle mirrors the schema (`api/src/db/schema.ts`), but it cannot express FULLTEXT indexes or foreign keys, so the hand-written SQL under `api/src/db/migrations/` is the DDL source of truth and is applied manually before traffic — see `docs/interface-db.md` for why `drizzle:push` is not the mechanism.
- **`api/src/services/host-auth.ts`** — orchestrates `/auth`, host registration, IP binding/roaming, insecure-host windows, digest caching, canonicalization (auths synthesized from `tokens.access_token`/`OPENAI_API_KEY` when missing), token quality checks, version snapshotting, host pruning (inactive 30d or never-provisioned >30m), and runner integration with recovery/backoff.
- **`api/src/services/runner-client.ts` + `runner-validation.ts` + `api/src/ops/auth-verification-worker.ts`** — HTTP client to the auth-runner; probes readiness, posts canonical auth, keeps Codex/Claude canonical payloads verified in the background, requests skill summaries, requests memory summaries, requests admin skill drafts, requests admin project metadata drafts, and returns runner telemetry.
- **Wrapper bakery v2** — `api/src/services/wrapper-config.ts` composes the typed per-engine host JSON configs and signs them with Ed25519 via `wrapper-signing-key.ts`; `wrapper-bin-registry.ts` discovers the common per-platform `cxx` artifacts under `storage/wrapper/v2/bin/`; `wrapper-meta.ts` and `wrapper-download.ts` back `/wrapper/v2/meta` and `/wrapper/v2/download`, while `wrapper-transition.ts` builds the legacy POSIX transition launcher served from `/wrapper/download`. One static Go binary is built from `wrappers/cxx/`; enabled `cdx`/`clx` paths are relative aliases that select the Codex/Claude persona.
- **`api/src/services/projects.ts`** — tracks whether native shared-project coordination is enabled and derives the managed `coco` skill manifest published through MCP `skill://coco`, with the CoCo toolkit/help embedded in the skill itself and explicitly constrained to project-only shared state. Also owns `/projects*` and `/admin/projects*`: project creation, about/roster edits, shared notes/todos/files/feedback, project resource exports for MCP, and append-only event history.
- **`api/src/services/host-sync.ts`** — computes combined startup diffs/payloads for the engine agent document and config (`/sync/status`, `/sync/bootstrap`) so wrappers can reduce pre-run API fan-out. The agent portion uses the effective served document, so host/engine-specific managed feature guidance participates in startup diffing; sync payloads expose `base_sha256`, `managed_sha256`, and stable per-feature presence/reason/digest diagnostics without copying Skill or memory inventories.
- **`api/src/services/agents.ts` + `host-agents.ts`** — store versioned canonical base editions, serve either the latest/pinned fleet version or a per-host pin, expose read-only history fetches for the admin UI, and can revert an older edition by cloning it into a fresh latest version while returning fleet serving to `latest`. Canonical history can enforce a configurable historical-backup cap (`versions.agents_backup_limit`): the newest latest draft is always kept, while currently served or host-pinned versions are protected from automatic pruning. At host render time, one marker-managed block adds only the applicable Skills, MCP Memory, Projects, and Codex-only BrowserOS usage hints; Codex Skill guidance makes MCP authoritative, requires `skill_list` first, and routes management to `skill://skill-manager`. The base document remains unchanged.
- **`api/src/services/shared-memories.ts` + `shared-memory-chunker.ts`** — the fleet-wide shared memory corpus: slug-addressed documents up to 1 MiB, chunked on markdown structure and FULLTEXT-indexed per chunk, with `shared_memory_list` (no query — the discovery entry point), `shared_memory_search` (ranked passages, `degraded: true` when the index is missing), `shared_memory_read` (bounded windows with `next_offset`), `shared_memory_write` (sha-guarded replace), `shared_memory_append` (multi-writer safe), and `shared://{slug}` resources. Scoped to neither host nor project — `source_host_id`/`source_engine` are provenance only, never read filters.
- **`api/src/services/secrets.ts`** — the fleet secrets store: the *working* credentials agents need once they are running (GitHub PATs, database passwords, Bookstack/Checkmk tokens, SSH keys, third-party service keys), as distinct from the engine-boot auth in `canonical-auth-store.ts` that gets an agent started. Values are held only as `sbox:v1:` envelopes with no plaintext column and deliberately no digest column; every metadata read enumerates its columns so ciphertext cannot ride along, and only `revealById` (admin, role-gated `POST`) and `getForHost` (MCP) decrypt. Delivery is MCP-only via `secret_list` / `secret_search` / `secret_get` — nothing is written to a host filesystem, so a soft delete revokes on the next read with no wrapper involvement. `getForHost` writes its own `mcp_access_logs` row carrying the slug before returning a value and does not swallow a failed write. Gated fleet-wide by `secrets_module_enabled`, which also controls whether the managed AGENTS.md/CLAUDE.md `## Secrets` block is rendered.
- **`api/src/services/agent-messaging.ts` + `api/src/ops/agent-messaging-worker.ts`** — the default-off Codex/Claude agent-to-agent bus. It owns stable `agent:<uuid>` addresses, two-party conversations, encrypted message bodies, generation-fenced session/relay delivery, metadata-only admin reads, and explicit audited reveal/redrive. Delivery is per-target FIFO and ordered at least once with one in-flight item, 60-second leases, at most 12 attempts, a 32 KiB body ceiling, and bounded TTL. The worker only advances queue state (expiry/retry/dead/ambiguous and stale binding/relay cleanup); it does not push to hosts or purge terminal v1 history.
- **`api/src/services/memories.ts` + `mcp-server.ts` + `host-skills.ts`** — MCP memory storage per host (content, tags, optional metadata, optional runner-generated summary), host-safe resource helpers, `skill://{slug}` reads, and host Skill CRUD. `skill_store` creates/replaces/revives shared manifest-only Skills, `skill_delete` soft-deletes them, and the managed `skill-manager` Skill explains and executes the list/retrieve/mutate/verify flow; code-managed and source-owned Skills stay immutable. Project-aware MCP tools/resources use `project_*` / `project://{slug}`. Coordinator filesystem helpers remain operator-only.
- **`api/src/services/mattpocock-skills.ts` +
  `api/src/ops/mattpocock-skills-worker.ts`** — a deliberately opt-in adapter
  into the existing `skills` table, not a second Skill system. It resolves
  upstream `main` to an immutable SHA, imports only the exact
  `.claude-plugin/plugin.json` allowlist, stores complete directory bundles in
  `skill_files`, and records repository/path/revision/license provenance. The
  worker polls state every 30 minutes but performs an upstream check only when
  the enabled, auto-updating source is at least six hours stale; promotion is
  atomic and a failed fetch/validation retains the last-known-good revision.
  Inclusion defaults off and makes no outbound request while off. A later
  re-enable validates and restores a complete cached revision without contacting
  GitHub; a missing, incomplete, or damaged cache falls back to a fresh fetch at
  the immutable upstream SHA. Admin state/config/manual-refresh routes live under
  `api/src/routes/admin/skill-sources/`.
- **Memory Atlas admin control plane** — `/admin/memories/*` normalizes host,
  project, and shared rows into stable `memory:{scope}:{record_id}` nodes. Its
  graph endpoint is full-body-free and emits only explicit scope, owner, project,
  tag, host-provenance, and engine-provenance edges; detail is lazy-loaded for
  the inspector. The UI bounds graph layout to the newest 150 memories from a
  loaded page and retains the complete page in its synchronized list. The same
  surface owns scope-aware create/update/delete,
  serialized shared append, full-state ETag conflict checks, and a normalized
  view of the existing operational logs/events/revision metadata. It adds no
  memory schema and does not turn that retention-bound activity into immutable
  body history.
- **`api/src/services/client-config.ts`** — renders/stores engine-scoped canonical client config from structured settings. Codex uses native `config.toml` `model` / `model_reasoning_effort`; Claude uses native `settings.json` `model` / `effortLevel` and deep-merges the fleet-owned paths. `/config/retrieve` bakes a per-host Codex copy using either the host API key (secure hosts) or a short-lived MCP bearer (insecure hosts) for the managed HTTP MCP entry, plus a Codex-only BrowserOS MCP entry when the host toggle is enabled. A successfully injected Codex MCP entry also adds a `[[skills.config]]` entry selecting `skill-creator` with `enabled = false`, removing the built-in local workflow that would otherwise outrank fleet discovery.
- **`api/src/services/chatgpt-usage.ts` + `api/src/ops/chatgpt-usage-worker.ts`** — uses canonical auth to poll ChatGPT quotas and capture normal plus Spark quota lanes. The `quota-cron` Compose sidecar polls immediately at startup and then on `CHATGPT_USAGE_CRON_INTERVAL` (default 15 minutes); its healthcheck follows a successful-refresh heartbeat rather than only process liveness.
- Admin dashboard charts use local Chart.js assets (with zoom plugin) for inline quota and usage analytics on the main dashboard; history APIs now support richer range/interval filters for those graphs.
- Admin dashboard supports login + role-based access once at least one active admin user exists; userless installs behave as before until the first admin is created. Login now uses a dedicated `/admin/login` page with server-side redirects (`/admin/` -> `/admin/login` when unauthenticated) and a username-first flow that requires passkeys for passkey-enabled admins; when exactly one active admin user exists and that user has a passkey, the page opens the passkey prompt directly without username/password or an extra authenticate click. Password recovery starts from login and completes on `/admin/password/reset`; successful recovery expires sessions, reset tokens, and passkeys. Personal session controls live in the desktop sidebar account menu and the mobile navigation sheet: theme selection is always available, while authenticated users also get self-service password change (`/admin/account/password`), personal passkey management (`/admin/account/passkeys`), and logout. Admin users and roles stay under Settings > Users & access; personal passkeys no longer live there.
- Host management now uses dedicated host detail pages at `/admin/hosts/{id}` (Action Items, Features, Stats, Infos) instead of the legacy host detail modal.
- **Drizzle storage + `api/src/security/secret-box.ts`** — MySQL storage with encrypted auth payload bodies and tokens; API keys stored as sha256 + secretbox ciphertext; supports legacy `sbox:v1` plus key-id ciphertext for rotation via `api/src/security/keyring.ts`.
- **Admin websocket server (optional)** — registered in-process by `api/src/ws/server.ts` and fed by `api/src/ws/publisher.ts`, which streams `admin_events` to connected `/admin` clients; `/admin/ws/info` advertises the public `ws/wss` URL and the latest event id. The admin SPA maps `log.created` actions and host/project/shared memory mutations to targeted query invalidations (overview/hosts/settings/skills/projects/agents/memories/users/config/profiles) and falls back to overview+hosts for unknown actions.

## How the flow works

1) **Provision a host (admin)**
   - `POST /admin/hosts/register` creates or rotates a host, hashes + encrypts the API key, and mints a single-use installer token. Optional `vip=true` marks the host as VIP immediately (quota hard-fail disabled). Insecure hosts get a provisioning window (default 30 minutes, or `duration_minutes` from register when provided); secure hosts expect long-lived local auth. The returned installer metadata includes `mode`/`label` so callers know whether the command will install Codex, Claude, or both. `POST /admin/hosts/quick-register` is the throwaway path: it auto-generates a short `tmp-*` host, marks it insecure + temporary, and returns the same installer metadata.
   - `GET /install/{token}` emits a POSIX shell script that fetches every enabled signed config first, refuses a dual-engine install unless wrapper version/SHA metadata is identical, downloads one `cxx`, atomically replaces legacy regular wrappers with relative enabled aliases, prepares Node.js/npm when Claude is requested, and bootstraps each matching CLI. The compact setup view ends in `READY` only when all requested components verify; partial installs end in `INCOMPLETE` with a non-zero exit and direct retry commands. Tokens expire after a TTL fixed at 1800s in the API and are marked used on first fetch.

2) **Every `/auth` call**
   - The auth-verification worker runs on boot and then every `AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS` (default 300s), refreshing stale Codex/Claude canonical payloads according to `AUTH_RUNNER_VERIFY_TTL_SECONDS` (default 900s). Successful stale probes also refresh per-engine runner telemetry, so the runner card reflects auth readiness for `cdx`/`clx` startup. `/auth retrieve` reads that stored verdict and does not run runner probes inline.
   - API key auth: resolves client IP, enforces per-IP binding unless `allow_roaming_ips` or `?force=1` on `DELETE /auth`; insecure-host window gating applies to `/auth` retrieve (and other window-gated routes), while `/auth` store submissions are still evaluated as candidates when the window is closed.
- Versions: reports the effective fleet Codex target (GitHub latest with stale fallback plus an internal minimum floor of `0.125.0`), `client_version_enforce_exact` downgrade policy, common wrapper version/sha from server disk, runner state, quota policy (`quota_hard_fail`, `quota_limit_percent`, and optional `quota_week_partition` pacing), `auto_update_enabled` for managed update hosts, and the fleet-wide `cdx_silent` quiet flag. When auto-update is enabled, normal `cdx`/`clx` startup updates the shared `cxx` artifact and re-execs as explicit `cxx codex|claude` so the original persona and argv survive, then repairs a locally stale Codex or Claude CLI; `--cron` is only an optional scheduled trigger. When Codex self-management is skipped, the summary note still distinguishes active-run, unsupported-platform, and true privilege-skip cases; privilege skips still include the wrapper-detected UID to expose root/user-namespace mismatches directly in the output. VIP hosts force warn-only (`quota_hard_fail=false`) regardless of the global policy.
- Wrapper self-update decisions are edge-triggered: matching wrapper version plus matching baked SHA stay `current`, so hosts do not redownload and restart into the same wrapper just because the decision helper returned the wrong shell status.
   - Retrieve path: compares client `last_refresh`/`digest` to canonical. Returns `valid`, `upload_required`, `outdated`, or `missing`, plus host stats (API calls, monthly token totals) and recent digests (remembered per host).
   - Store path: validates RFC3339 `last_refresh` (>= 2000‑01‑01, <= now+300s), enforces token entropy/length, normalizes/sorts auths, and synthesizes entries from native engine tokens when needed. Every host, admin, seed, and bootstrap candidate requires a configured runner and a positive live verdict before promotion; definitive credential rejection returns 422, while absent/transient runner failures return 503 without changing canonical auth. Store submissions remain candidates regardless of insecure-window state, but still require normal API-key/IP/reverse-DNS/installation checks. A runner `updated_auth` must remain runnable, preserve credential kind, and retain any OAuth refresh token. Inconclusive/failed readbacks may be kept as quarantined history, but never become a canonical head or response. On success, the encrypted body, per-target entries, host sync state, and digest cache commit together.

   - Canonical ordering is monotonic per engine. RFC3339 values are compared by
     instant; only live-verified rows advance the explicit head. Quarantined
     pending/failed descendants never become distributable, while a failed
     explicit head is withheld instead of falling back to older history. Store
     and worker operations serialize runner work and re-resolve before commit.
     Every accepted canonical digest
     change advances `last_refresh` by at least 1 ms, including same-stamp
     uploads and runner rotations, so delayed wrapper responses have a strict
     ordering key. An older client can repair a
     failed lineage only through a definitive live verification. Transient
     runner/provider/CLI failures remain retryable and cannot poison canonical
     credentials.
   - Seed tokens are reserved only for the store attempt and released on store
     failure. First host-auth state writes use an atomic upsert. Engine-aware
     wrapper uninstall calls `DELETE /auth?engine=...`, preserving the other
     engine and revoking the removed engine's pending installer credentials.

3) **Runner validation**
   - Enabled when `AUTH_RUNNER_URL` is set (default in compose). The background worker keeps the latest Codex/Claude canonical payloads verified/refreshed; store paths still validate synchronously before accepting new auth. Claude OAuth probes project the server envelope onto the native `claudeAiOauth`-only `.credentials.json` shape and compare readback against that same projection, so server metadata cannot trigger a false credential rotation. A provider-expired OAuth session that makes Claude clear the temporary file is a definitive rejection (canonical repair/login), not an unsafe replacement; inconclusive readbacks remain fail-closed. Runner failures are logged (`auth.validate`/`auth.runner_store`), do not block `/auth` retrieve, but **do** block canonical-auth-changing uploads, including admin uploads and seed uploads.

4) **Wrapper distribution**
   - `/wrapper/v2/meta` (and the legacy `/wrapper` alias) returns an engine-scoped projection of the common per-platform binary matrix. `/wrapper/v2/download` returns the raw Go binary for v2-aware clients, and `/wrapper/download` remains the legacy shell-transition path for date-versioned wrappers. New wrapper versions roll out as one complete four-platform matrix under `storage/wrapper/v2/bin/cxx/<os>-<arch>/v<version>/cxx`; both signed engine configs resolve to those same bytes and hosts converge on the next run.
   - The wrapper exposes a short Spark-lane alias: `cdx ls` rewrites to `cdx lane spark` before normal lane/profile parsing. Every explicit lane selection is a server-side preference and therefore persists; the old `--persist` spelling remains accepted as a compatibility no-op.
   - Help-only invocations (`cdx --help`, `cdx -h`, `cdx help`, and Codex subcommand help such as `cdx exec --help`) bypass wrapper startup noise and print only upstream Codex help text. They skip the managed run lock, sync, update, MOTD, and footer, but remain supervised so the native child inherits both auth-session and active-child descriptors until it exits.
- Wrapper startup pull sync is batched: it probes `POST /sync/status` and, when updates exist, pulls content via `POST /sync/bootstrap` (agent document/config in one flow). The server combines the canonical base with one deterministic managed-feature block tailored to the engine and host; feature-state changes affect the final digest without creating a new canonical version. When local auth is already valid, that same bundle path also carries auth metadata/refresh inline (`include_auth=true`), and `auth_candidate` is processed before canonical auth is returned so fresh local logins upload to canonical storage before launch. Native Claude credentials without `last_refresh` are compared against canonical form first and only stored when they actually differ, preventing a server copy from overwriting a fresh local OAuth credential. Older servers automatically fall back to legacy per-resource pull endpoints, but transient bundle failures do not trigger extra per-resource retries during startup. For Claude, cxx 0.7.3 consumes complete `claude_skills` bundles and atomically replaces each fleet-owned native directory; for Codex, manifests and support files remain live MCP resources at `skill://<slug>` and `skill://<slug>/<path>`.
- Wrapper Codex updates now key off `/auth` `client_version_enforce_exact`: floor-only targets only trigger upgrades, while explicit above-floor pins can still downgrade to match.
  - When the Projects module is enabled, the managed `coco` skill is published through MCP `skill://coco`; there is no separate wrapper-side project bootstrap pass. When the module turns off again, the managed skill disappears from the MCP resource list, and wrapper cleanup removes stale local skill directories so old CoCo docs cannot shadow the project-only skill.
- `POST /sync/bootstrap` can also process auth in the same request when `include_auth=true`: when `auth_candidate` is provided, the server uses the same live-runner-validated canonical store path as `/auth store`, reports `auth_stored` on success, and returns store metadata including `runner_applied` / skipped-reason fields. Only `verification_state:verified` may include auth bytes. A deterministic malformed/unusable/provider-rejected candidate sets `candidate_credential_rejected:true`; if an older verified replacement is also returned, only `candidate_rejected_definitive:true` authorizes overwriting the newer local generation. Transient failures omit both signals and preserve local auth.
- Wrapper boot health markers distinguish successful unchanged checks, actual
  local updates, best-effort resource failures, and deliberately skipped
  checks. The updated caret is reserved for a proven write; resource failures
  warn and skipped/concurrent checks are dim instead of being painted green.
  Claude-native `claude_skills` writes feed the skills marker (not config).
  Failed writes/prunes preserve the last-good manifest; trust-loss cleanup
  retains ownership sidecars for anything it could not remove so later runs
  retry the residue.
   - On Linux hosts where wrapper-managed dependency installs are allowed (`root` or passwordless `sudo -n`), `cdx` now hard-checks a compatible Python 3 interpreter plus `curl` and `unzip` before update/sync work, and tries `bwrap` best-effort via `apt-get`, `dnf`, `yum`, `pacman`, `zypper`, or `apk` (RHEL-family prefers `dnf` with `yum` fallback for legacy CentOS 7/8/9 compatibility, and legacy YUM retries `python36` when `python3` is not packaged). If Bubblewrap installation fails, launch still continues because Codex can fall back to its vendored helper. When `python3` itself is not on `PATH`, the wrapper first accepts compatible alternatives such as `python3.6`, `python36`, or `platform-python`. On macOS it checks/installs `python3`, `curl`, and `unzip` via Homebrew when missing.
   - `cdx --update` stays a recovery path: it pares prerequisite checks down to `curl` before the forced wrapper/Codex update flow, so stale wrappers can still heal themselves and then continue into the Codex check even when `unzip`, `bwrap`, or local package mappings are broken. Normal startup still ensures a compatible Python 3 interpreter before sync/update work when the wrapper can manage prerequisites.
   - Interactive SSH terminals launch Codex through the same direct TTY path as local terminals, avoiding wrapper-owned PTYs around the Codex UI. Alt-screen stays enabled: the wrapper never forces inline mode and has no override for it. `cdx doctor` reports SSH env hints and launch mode for troubleshooting.
   - Auth synchronization is generation-based and independent of the managed
     content run lock. Short local locks provide coherent reads/writes. Bounded
     requests that can persist credentials (`/auth` store and bundle
     `auth_candidate`) deliberately retain the auth+logout-intent lock through
     the network boundary so logout has one linear order with server storage.
     Each wrapper-launched engine child holds a separate auth-path-keyed shared
     lease from `Start` through `Wait`; duplicate session/active-child
     descriptors inherited by the native process keep both guarantees alive
     after wrapper SIGKILL. Managed writers therefore cannot rename credentials
     during a native login/refresh/logout. Late responses preserve a newer usable native login
     unless that exact candidate was definitively rejected and an older
     verified canonical is explicitly authorized. `cdx logout` journals before
     native removal, takes exclusive maintenance when possible, and otherwise
     defers removal until every peer session exits. Durable logout intent uses
     auth-generation plus exact marker-byte compare-and-swap; a distinct local
     login remains marked until that exact candidate is accepted server-side,
     while `cdx login status` never acknowledges it. Content-bound local
     logical generations keep accepted X and subsequent native Y ordered even
     if the host clock/mtime moves backwards; immediate next runs reuse the
     exact stamp. cdx follows
     effective `CODEX_HOME`; clx treats `~/.claude/.credentials.json` as
     authoritative and its old clx credential path as a write-only mirror.
   - Every auth-aware invocation holds a portable shared session lease keyed to
     its effective auth home. API `host.secure` responses update that
     invocation's durable purge request; concurrent insecure requests stay
     sticky until the last process exits. Status-only `insecure` /
     `insecure-denied` responses request purge even without a host block, and a
     stale startup response is not replayed at finish. Active children defer
     cleanup; new sessions fail fast while uninstall/logout owns exclusive
     maintenance. Logout intent survives cleanup. Required auth
     upload/materialization, marker, purge, or uninstall-auth removal failures
     return non-zero; a blocked canonical write is a safe skip only when usable
     local auth remains.
   - clx applies a local-first launch matrix: runnable local auth survives
     transient upload/runner infrastructure failures; verified runnable server
     auth repairs missing or corrupt local state; and if neither exists an
     interactive run starts `claude auth login` directly. Headless runs print
     that interactive action. A logout marker makes its exact stale native
     generation unusable—it is cleared only by an accepted new login or a
     different verified canonical, never unconditionally.
   - The active-child guarantee covers processes launched through `cdx`/`clx`.
     A separately invoked raw `codex` or `claude` process does not participate
     in wrapper leases; operators needing race-safe fleet auth should use the
     wrappers consistently.
   - When a host already has an active wrapper run, the concurrent guard still
     skips managed content/update writes and peer reconciliation, but performs
     the auth freshness check and keeps API/auth/runner health visible. The
     outcome says `SYNC PAUSED`, not the over-broad `READ ONLY`; an explicit
     `--allow-concurrent-sync` remains the write-enabled escape hatch. This is
     normal contention requiring no operator action, so its status is neutral;
     warning colour is reserved for conditions that require attention.
   - Wrapper post-run auth upload now compares both `last_refresh` and local `auth.json` SHA-256; content changes with unchanged timestamps are still pushed so fleet hosts can consume updated auth promptly.
   - Wrapper self-update re-exec preserves original argv for subcommands (for example `cdx resume`) and snapshots original argc separately, so empty-argv restarts fall back cleanly without `set -u` empty-array crashes on older bash builds such as CentOS 7 / XCP-NG hosts.
   - `cdx` and `clx` share one responsive terminal dashboard: outcome, host/security/model context, local-to-target versions, semantic health glyphs, quota/activity, and the final result fit within the detected width. Redirects, dumb/narrow terminals, and `--minimal` use stable ANSI-free ASCII; explicit minimal mode also covers wrapper help, status, doctor, cron/peer-update progress, and the measured exit footer. Wrapper-only presentation flags are consumed before an upstream help passthrough. Boot/status result text is control-sequence stripped, width-bounded, and capped at three lines; diagnostic causes/paths are bounded separately, and narrow update rows preserve the outcome before version metadata.
   - Both wrappers show the same optional `ACTIVITY` section: `local procs` is
     the same-UID wrapper process count; `hosts 30m` is the number of distinct
     hosts with an `agents.retrieve` event in the prior 30 minutes; `syncs UTC
     day` and `syncs UTC month` count those managed-agent sync attempts from
     the corresponding UTC boundaries. The API retains `sessions` as the JSON
     compatibility key, but these are not launch/concurrency counters. clx
     resolves missing model/effort context per field from the effective
     `~/.claude/settings.json`; a signed Claude model override wins over an
     inherited `ANTHROPIC_MODEL`, which is only the runtime fallback. cdx does
     the same per-field local fallback from
     `${CODEX_HOME:-~/.codex}/config.toml`.
   - Signed-config failures use the same structured status/doctor renderer with
     sanitized, bounded path/cause text and a non-zero result. `clx doctor`
     additionally validates usable credentials, parses JSON settings and the
     exact managed MCP block, treats only HTTP 2xx as API health, and fails an
     unreachable latency probe. Its FQDN guard now runs before lock/network
     activity and again immediately before Claude exec.
   - `--wrapper-help` renders the wrapper-owned command surface without a signed config. Upstream `--help` bypasses managed sync/update/UI work but retains the auth session and inherited child safety leases through native exit. Conflicting wrapper action flags fail with exit 2 instead of silently selecting a destructive winner.
   - Codex quota rows derive labels from provider `limit_seconds`, retain real
     zero-percent readings, distinguish unknown reset time in alert copy, and flag
     unavailable/malformed/stale telemetry. The host-effective active lane is
     the only lane that can warn or block (including provider
     allowed/limit-reached flags); the inactive lane remains context. Forecasts
     wrap instead of clipping and raise advisory attention without becoming a
     hard block by themselves. A projection is withheld until at least five
     minutes and 1% of its quota window have elapsed. Stale/malformed snapshots
     are last-known context only: their projections and percentage/provider
     gating are suppressed. When no snapshot exists (or reading it fails),
     `/auth` sends an explicit `status:"unavailable"` quota object rather than
     omitting the evidence.
   - A non-null persisted Codex lane also selects the actual launch model: `normal`
     injects `gpt-5.6-terra`; `spark` injects `gpt-5.3-codex-spark`, high effort,
     and disabled reasoning summaries. Explicit per-run model/profile flags win
     over that mapping, and the at-a-glance card mirrors the resulting choice.
     Clearing the lane leaves the signed fleet/per-host model in charge; only
     quota display and policy fall back to `normal`.
   - A stored runner transport failure renders attention because retrieve and
     cached launch remain allowed; a stored provider credential-verification
     failure still blocks. Doctors independently validate a usable local token
     and HTTP 2xx health.

5) **Host telemetry**
   - `/host/users` records current username/hostname for the host and returns the known list (used by `cdx --uninstall`).
   - `/host/lane` exposes/stores host lane preference (`normal|spark|null`) so wrappers can persist lane steering without admin login.
   - Host sync uses `/skills` list/retrieve/store. Agents can also create/update/revive shared manifest-only Skills with MCP `skill_store` and write recoverable delete markers with `skill_delete`; the managed `skill-manager` Skill explains and executes that flow. Codex's served guidance requires `skill_list` before answering or acting on a Skill request. When project coordination is enabled, the same delivery path also ships managed `coco`.
   - Shared project state itself is served live through `/projects*` and project-aware MCP tools/resources rather than through startup sync payloads.

6) **Quotas**
   - The `quota-cron` Compose sidecar polls ChatGPT `/wham/usage` using canonical tokens immediately on startup and then on `CHATGPT_USAGE_CRON_INTERVAL` (default 15 minutes). It respects the service's five-minute cooldown, writes its health heartbeat only after a usable provider snapshot, and retries on the next interval after failure. Results are cached and surfaced on `/auth` responses and admin dashboards with dual-lane metadata: normal + Spark windows and provider rate flags. `/auth` shapes `active_quota_lane` per calling host (`spark` only for a Spark-preferring host; otherwise `normal`) instead of reusing the account snapshot's default. If no readable snapshot exists, the host still receives `{status:"unavailable", active_quota_lane:...}` so the wrapper renders unknown quota health explicitly.

## Safety rails

- **Rate limits** — Global per-IP bucket for non-admin paths (default 120/minute, tunable); auth-fail bucket throttles repeated missing/invalid API keys with a block window when tripped. Limits return 429 with reset metadata.
- **IP binding & roaming** — First successful call pins the API key to that IP (and a second IP if the host is dual-stack: one IPv4 + one IPv6); optional roaming flag updates the stored IP. For a planned static-IP change, Host Detail’s **Release IP binding** action clears both stored addresses with an audit record, so the next valid host request claims the replacement address without changing the host’s security or roaming policy. Reverse DNS enforcement (when enabled) requires the caller IP to appear in the host’s A/AAAA records and have a PTR back to the host FQDN; runner probes can bypass via CIDRs; `DELETE /auth?force=1` allows uninstall from a different IP.
- **Insecure hosts** — Require an active sliding window (0–480 minutes, default 10, set via the log-ish dashboard slider or `duration_minutes`) for `/auth` retrieve and other window-gated host routes. Each non-store `/auth` call extends the window by that duration. `/auth` store submissions are still accepted as candidates when the window and grace period are closed, do not open/extend the window, and pass every normal authentication/validation/runner gate. New insecure hosts start with a provisioning window (default 30 minutes, overridable via register `duration_minutes`); secure hosts keep auth on disk. Every auth-aware cdx/clx invocation holds a shared session lease, updates its own purge request from live API security metadata, and only the last exiting process purges native credentials; active native children defer that purge and explicit logout intent is retained. When insecure approvals are enabled and an admin websocket client is connected, closed-window retrieve requests return a pending response and the wrapper waits for approval inside a single refresh-in-place terminal status box that points the operator to Admin `Enable window` and shows last-check/check-count metadata. Pending approval requests auto-deny after five minutes, removing them from the admin queue and returning `insecure_denied` to polling hosts; optional domain auto-allow rules can auto-open windows for matching subdomains while active.
- **Auth integrity** — Digest is sha256 over canonical JSON; stored digest mismatch triggers validation logging. Timestamps are clamped to reasonable bounds.
- **Encryption & secrets** — Secretbox protects API keys, payload bodies, and token entries; key is auto-generated/persisted in `.env` if absent. API keys also stored as sha256 hashes for lookup.
- **Kill switches** — Admin can disable the API (`/admin/api/state` 503s everything else) or set quota mode + limit slider (`/admin/quota-mode` exposes warn-only vs. hard-fail, `limit_percent`, and optional `week_partition` pacing for a daily allowance bar in `cdx`). Hosts can also be marked VIP (per-host toggle) to bypass the quota kill-switch entirely (always warn-only). Admin routes honor mTLS by default.

## Data retention & pruning

- Canonical auth lives in an engine-scoped generation ledger: `auth_payloads`
  keeps encrypted payloads plus keyed credential fingerprints and native
  freshness metadata, while `auth_canonical_heads` points at the current Codex
  and Claude generations. Exact historical credential replays are refused.
  Superseded generations are retained for 180 days and then pruned daily;
  current canonical rows are exempt regardless of age. `host_auth_states`
  tracks what each host last saw and `host_auth_digests` caches three recent
  digests per host and engine.
- Hosts are pruned when inactive for `inactivity_window_days` (default 30; set to `0` to disable; configurable in Admin Settings → General), never provisioned within 30 minutes, or when `expires_at` is in the past (temporary hosts; refreshed on successful host contact for a 2-hour idle window); pruning logs `host.pruned` and cascades digests/state/users.
- Logs, Skills and their `skill_files` bundles, all three memory stores, project
  coordination tables, shared-memory chunks/revisions, ChatGPT snapshots, and
  version flags all live in MySQL; storage is the compose volume. Disabling an
  external Skill source soft-deletes its rows from served inventory but retains
  the cached rows/files and last-known-good metadata. Re-enable validates that
  cache before restoring it without an upstream request; an invalid cache is
  rebuilt from the immutable upstream revision. Memory
  Atlas activity is assembled from the existing body-free logs, project events,
  and shared revision metadata and therefore follows their configured retention;
  it is not an immutable compliance ledger or a restorable body-history store.

## Fleet workflow at a glance

- Bring up the stack (`cp .env.example .env`, set DB/host vars, `docker compose up --build`; add `--profile caddy` for TLS/mTLS frontend). Runner + quota cron sidecars are on by default in compose.
- Log into Codex once on a trusted box; upload that `~/.codex/auth.json` via the dashboard, use the one-time `curl | bash` seed command, or call `/auth` with `command: "store"`.
- For managed hosts: `New Host` → paste the auto-copied `curl …/install/{token} | bash` command on the host. For disposable VMs: `Quick VM` → choose Codex, Claude, or Both → paste the auto-copied installer. Every host receives one `cxx`; Codex hosts receive `cdx -> cxx`, Claude hosts `clx -> cxx`, and dual-engine hosts both aliases against the same host key. Treat only a final `READY` plus exit 0 as success; `INCOMPLETE` means the named retry must be run (or a fresh single-use installer minted for wrapper/config failures).
- Host-side usage (how to run Codex via `cdx`, what files it manages, troubleshooting): see `docs/USAGE.md`.
- `cdx` pre-launch helpers are intentionally no-op safe: if `config.toml` yields no OTel exports or the current directory is already trusted, the wrapper continues into Codex instead of treating that as a fatal shell step.
- Set fleet CLI model defaults from Settings → Codex or Settings → Claude. Both tabs call `GET/POST /admin/model-defaults/:engine` and constrain effort to the selected model. Codex persists `model` / `model_reasoning_effort` in canonical `config.toml`; Sol/Terra/Luna/GPT-5.5/GPT-5.4/GPT-5.4 mini default to `medium`, while Spark defaults to `high`. Claude persists `model` / `effortLevel` in the deep-merged `settings.json` partial and defaults to Sonnet 5 at `high`. Fable 5, Opus 5, Opus 4.8, and Sonnet 5 persist `low|medium|high|xhigh` with default `high`; Opus 4.7 uses the same set with default `xhigh`; Sonnet 4.6 persists `low|medium|high`; Haiku 4.5 omits effort. The nearby Claude API defaults (`default_model`, `max_tokens`) also default to Sonnet 5 but configure only the Anthropic-compatible proxy and do not change managed Claude Code sessions.
- Build/edit `config.toml` from `/admin/config.html`; saved output is baked per host and synced by `cdx` to `${CODEX_HOME:-~/.codex}/config.toml` (managed HTTP MCP entry; secure hosts use the host API key, insecure hosts get a short-lived bearer). New builder drafts default to `model = "gpt-5.6-terra"` with `model_reasoning_effort = "medium"`, `personality = "friendly"`, `[features].apps = true`, `[features].fast_mode = true`, `[features].memories = true`, and `[features].multi_agent = true`; the admin builder keeps `guardian_approval`, `js_repl`, `tui_app_server`, and `prevent_idle_sleep` off until explicitly enabled. `status:missing` deletes the local copy. Legacy feature keys (`steer`, `experimental_windows_sandbox`, `enable_experimental_windows_sandbox`, `request_permissions`, `use_linux_sandbox_bwrap`) remain ingest-compatible but are dropped from rendered output.
- Optionally include `https://github.com/mattpocock/skills` from Authoring →
  Skills. The card is off by default and warns that this is an external
  instruction supply chain. Fresh source state defaults its six-hour
  auto-update on, while a preference set before inclusion is preserved; turn
  that switch off to pin the current last-known-good SHA, or use **Check now**
  for an operator-triggered refresh. Imported skills are visibly sourced
  and read-only in the ordinary editor. Re-enabling restores a complete,
  validated server cache without a GitHub request; a missing or damaged cache is
  fetched again from the immutable upstream revision. Turning inclusion off
  hides them from Codex immediately and makes Claude prune only their fleet-owned
  directories on the next bootstrap; unrelated and user-authored skills are
  untouched.
- Enable shared project coordination from Settings → Projects when you want multi-agent notes/todos/files/feedback; that toggle publishes the managed `coco` skill through MCP `skill://coco`. Disabling the module removes that managed skill from the MCP resource list. CoCo coordination handoffs are project-only; host-scoped MCP memories are not a cross-server fallback. Fleet-wide reference documents belong in shared memories (`shared_memory_*`), which need no project and no host. The Settings panel stays compact and opens each project on its own `/admin/projects/<slug>` workspace page, where the admin UI can also ask the runner to draft missing `title`/`name`/`description` metadata and a roster draft from the current shared project context before the operator saves.
- Inspect and manage the complete memory topology from Authoring → Memories.
  Memory Atlas keeps graph and paginated list views in sync, lazy-loads bodies
  in the inspector, and offers scope-aware create/edit/delete plus shared
  append. Memory keys/slugs and host/project ownership are fixed at creation;
  deletion is permanent and has no restore path.
- Rotate tokens by updating the trusted machine’s `auth.json` and pushing again (dashboard upload or `/auth` store from any host with the new digest).
- Decommission with dashboard delete or `cdx --uninstall` (calls `DELETE /auth`).

## Operations

- Logs are stored in MySQL (`logs` table). For a quick peek in a default Docker setup you can run:  
  `docker compose exec mysql mysql -u"$DB_USERNAME" -p"$DB_PASSWORD" "$DB_DATABASE" -e "SELECT * FROM logs ORDER BY created_at DESC LIMIT 10;"`
- The legacy `host-status.txt` export has been removed; use the admin dashboard (`/admin/overview` and `/admin/hosts`) for current host status.
- Timestamp comparisons normalize RFC3339 strings including fractional seconds, so Codex-style values such as `2025-11-19T09:27:43.373506211Z` are supported.

## Agent Messaging

Agent Messaging lets any eligible managed agent address any other one, covering
all four paths: Codex to Codex, Codex to Claude, Claude to Codex, and Claude to
Claude. It is separate from the human-facing Agent Portal and defaults off at
the fleet and per-host layers. Effective eligibility requires the fleet switch,
an active secure host, that host's Agent Messaging switch, the address engine
still enabled on the host, and the address itself enabled. Every send, bind,
claim, and acknowledgement rechecks those gates; changing host security,
status, or engines atomically withdraws runtime eligibility.

Wrapper lifecycles bind a stable canonical `agent:<uuid>` address. Native
resumes recover the same upstream identity; a fresh matching lifecycle may
reuse a dormant host/user/engine/cwd identity with continuity marked reset.
Interactive receive-capable sessions claim directly through the private Unix
broker. One outbound-only relay per host user handles dormant/resumable
addresses and never opens a host listener. Session finish clears the live
binding but retains the address as resumable/offline; SIGINT/SIGTERM stops the
relay generation and erases its server token.

The queue is ordered at least once: a monotonic dispatch order preserves
per-target FIFO, retries cannot leapfrog, and one target has at most one leased
or accepted message. Claims and sender client IDs are idempotent, leases last 60
seconds, retries back off, and attempt 12 becomes dead. Bodies are UTF-8 and at
most 32 KiB. TTL defaults to 24 hours and accepts 60 seconds through seven
days. Once delivery is accepted, loss of completion certainty becomes
`ambiguous` instead of automatic replay. An owner/admin may explicitly redrive
a dead/ambiguous row, creating a new sequence linked to the retained original.

Message bodies and delivery error text are secretbox-encrypted. Admin viewers
can inspect address, conversation, queue, direction, and message metadata but
never content. Alias/switch/cancel/redrive mutations and plaintext reveal
require owner/admin; reveal is an audited POST with no-store/no-cache response
headers. Disabling any eligibility layer cancels queued/leased work, marks
accepted work ambiguous, cancels affected conversations, revokes applicable
relays, and generation-fences bindings. Version 1 intentionally retains
terminal messages, canceled conversations, dormant addresses, and audit
history; there is no automatic Agent Messaging purge.

## Permanent Agent Portal

The optional `/go` portal gives each configured user one permanent, revocable
magic link. After fragment-token exchange it presents tabs for every eligible
active Codex and Claude root agent in the fleet. Users can send ordered ordinary
text and answer explicit prompts; first answer wins. Completed or failed agents
remain visible but read-only for 24 hours, then their sessions, events, prompts,
and messages are purged.

`cxx` 0.7.5 registers interactive and human-started execute/resume lifecycles
with the host credential. It retains the short-lived session bridge bearer and
proxies a fixed command set over a private Unix socket, leaving only the socket
path and session metadata in the child. The managed `#afk` Skill opens the relay
before queuing its attention notice and uses `cxx portal wait` to lease portal
text in the existing root session. `cxx portal accept` acknowledges only after
the instruction reached the model; unacknowledged leases are redelivered in
order. Claim retries carry one stable UUID, while event, acceptance, and
terminal retries reuse their original idempotency boundary with a fresh request
deadline. Replies and questions are deliberately published through `cxx portal
say` and `cxx portal ask`; there is no raw PTY or hidden tool-output stream.
As soon as the engine child exits, cxx closes relay writability, removes the
socket capability from the environment, finalizes the portal session, and only
then runs post-session updater/auth work.
This is a cooperative live-turn relay, not an out-of-band wake mechanism: once
the engine process or model turn stops polling, `relay_ready` becomes false and
the portal is read-only until a fresh eligible relay is active.

The portal has no outbound push channel. It replaced one: every lifecycle event
used to fan out as a chat message carrying a freshly rendered deep link, which
meant a stream of notifications each containing live bearer material. Now the
link is issued once and read back on demand from Settings → Agent Portal, and the
user bookmarks it. Lifecycle events (`started`, `resumed`, `progress`,
`waiting_input`, `terminal_block`, `attention`, `failed`, `completed`) are still
recorded and still stream to an open portal over SSE — they are simply not
delivered anywhere else. All identity, history, and input remain on `/go`.

The global switch is a persistent `versions.agent_portal_enabled` setting and is
seeded off on first rollout. New users default enabled. Turning off either the
global switch or one user revokes matching browser sessions and cancels queued
or leased undelivered commands/notices; re-enabling does not replay them and
does not change the permanent link. Explicit rotation is the only operation
that invalidates and replaces that link. A disabled answering user releases a
still-live prompt for another enabled user; global, relay, or terminal
cancellation expires the prompt so an old answer cannot replay after
re-enable. A maintenance sweep turns abandoned live sessions into failed,
read-only records, cancels their pending work, and purges the complete session
tree after retention expires.
