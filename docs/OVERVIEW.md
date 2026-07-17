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
- CI validates contract coverage by replaying recorded fixtures through the running Node server (`api/test/contract/contract.test.ts`) and through integration suites under `api/test/integration/`.

## Why teams use it

- One `/auth` call decides whether to accept a client upload or return the canonical copy and always includes versions + quota metadata.
- Per-host API keys are hashed/encrypted at rest, IP-bound on first use, and rotated when a host is re-registered.
- Canonical auth + per-target tokens are encrypted with libsodium `secretbox`; the key is bootstrapped into `.env` on first boot. Optional keyring mode (`AUTH_ENCRYPTION_KEYS` + `AUTH_ENCRYPTION_ACTIVE_KID`) supports rotation with `kid`-tagged ciphertext.
- Safety rails: global/auth-fail rate limits, API kill switch, token quality checks, RFC3339 timestamp bounds, optional IP roaming, and opt-in insecure-host gates.
- Runner sidecar validates canonical auth from a background worker (default every 5m, TTL 15m) and after stores, auto-applies refreshed auth from Codex, and never blocks `/auth` **retrieve** when down (canonical-auth-changing uploads, including admin/seed uploads, require a reachable runner when enabled).
- Extras ride the same API: Skill distribution, native project coordination (notes/todos/files/feedback/activity), MCP memories, ChatGPT `/wham/usage` snapshots.

## Key components (code map)

- **`api/src/server.ts` boot** — boots env, key manager + secretbox, Drizzle client, services, the auth-verification worker, global rate limiting, and registers all routes under `api/src/routes/*` (host/admin/installer/seed/auth/sync/skills/projects/agents/config/MCP/chatgpt/versions). Drizzle is the single source of truth for schema (`api/src/db/schema.ts`); migrations are generated/applied with `pnpm drizzle:generate` + `pnpm drizzle:push`.
- **`api/src/services/host-auth.ts`** — orchestrates `/auth`, host registration, IP binding/roaming, insecure-host windows, digest caching, canonicalization (auths synthesized from `tokens.access_token`/`OPENAI_API_KEY` when missing), token quality checks, version snapshotting, host pruning (inactive 30d or never-provisioned >30m), and runner integration with recovery/backoff.
- **`api/src/services/runner-client.ts` + `runner-validation.ts` + `api/src/ops/auth-verification-worker.ts`** — HTTP client to the auth-runner; probes readiness, posts canonical auth, keeps Codex/Claude canonical payloads verified in the background, requests skill summaries, requests memory summaries, requests admin skill drafts, requests admin project metadata drafts, and returns runner telemetry.
- **Wrapper bakery v2** — `api/src/services/wrapper-config.ts` composes the typed per-host JSON config and signs it with Ed25519 via `wrapper-signing-key.ts`; `wrapper-bin-registry.ts` discovers per-platform binaries under `storage/wrapper/v2/bin/`; `wrapper-meta.ts` and `wrapper-download.ts` back `/wrapper/v2/meta` and `/wrapper/v2/download`, while `wrapper-transition.ts` builds the legacy POSIX transition launcher served from `/wrapper/download` that writes config before execing the binary. Wrappers themselves are static Go binaries built from `wrappers/cdx/` and `wrappers/clx/`.
- **`api/src/services/projects.ts`** — tracks whether native shared-project coordination is enabled and derives the managed `coco` skill manifest published through MCP `skill://coco`, with the CoCo toolkit/help embedded in the skill itself and explicitly constrained to project-only shared state. Also owns `/projects*` and `/admin/projects*`: project creation, about/roster edits, shared notes/todos/files/feedback, project resource exports for MCP, and append-only event history.
- **`api/src/services/host-sync.ts`** — computes combined startup diffs/payloads for AGENTS.md and config (`/sync/status`, `/sync/bootstrap`) so wrappers can reduce pre-run API fan-out. The AGENTS portion uses the effective served document, so managed runtime additions like the Skills and Memories inventory blocks also participate in startup diffing; sync payloads now also expose managed-section metadata (`base_sha256`, `managed_sha256`, per-section counts/reasons) for debugging host-specific AGENTS tails.
- **`api/src/services/agents.ts`** — stores versioned AGENTS.md editions, serves either the latest/pinned fleet version or a per-host pin, exposes read-only history fetches for the admin UI, and can revert an older edition by cloning it into a fresh latest version while returning fleet serving to `latest`. Canonical AGENTS history can also enforce a configurable historical-backup cap (`versions.agents_backup_limit`): the newest latest draft is always kept, while currently served or host-pinned versions are protected from automatic pruning. Served host copies may append managed Skills and Memories inventory blocks at render time, report per-section presence/count/reason metadata through the host sync APIs, and can backfill missing memory summaries lazily through the runner while the AGENTS document is being rendered.
- **`api/src/services/memories.ts` + `mcp-server.ts`** — MCP memory storage per host (content, tags, optional metadata, optional runner-generated summary) with CRUD tooling (`memory_store`/`memory_retrieve`/`memory_search`), host-safe resource helpers, unconditional `skill://{slug}` read-only resources for synced Skill manifests, and optional project-aware MCP tools/resources (`project_*`, `project://{slug}`) when the Projects module is enabled. Coordinator filesystem helpers are retained for operator/internal use and are not exposed on the host-authenticated `/mcp` route.
- **`api/src/services/client-config.ts`** — renders/stores engine-scoped canonical client config from structured settings. Codex uses native `config.toml` `model` / `model_reasoning_effort`; Claude uses native `settings.json` `model` / `effortLevel` and deep-merges the fleet-owned paths. `/config/retrieve` bakes a per-host Codex copy using either the host API key (secure hosts) or a short-lived MCP bearer (insecure hosts) for the managed HTTP MCP entry, plus a Codex-only BrowserOS MCP entry when the host toggle is enabled.
- **`api/src/services/chatgpt-usage.ts` + `api/src/ops/chatgpt-usage-worker.ts`** — uses canonical auth to poll ChatGPT quotas and capture normal plus Spark quota lanes. The `quota-cron` Compose sidecar polls immediately at startup and then on `CHATGPT_USAGE_CRON_INTERVAL` (default hourly); its healthcheck follows a successful-refresh heartbeat rather than only process liveness.
- Admin dashboard charts use local Chart.js assets (with zoom plugin) for inline quota and usage analytics on the main dashboard; history APIs now support richer range/interval filters for those graphs.
- Admin dashboard supports login + role-based access once at least one active admin user exists; userless installs behave as before until the first admin is created. Login now uses a dedicated `/admin/login` page with server-side redirects (`/admin/` -> `/admin/login` when unauthenticated) and a username-first flow that requires passkeys for passkey-enabled admins; when exactly one active admin user exists and that user has a passkey, the page opens the passkey prompt directly without username/password or an extra authenticate click. Password recovery starts from login and completes on `/admin/password/reset`; successful recovery expires sessions, reset tokens, and passkeys. Personal session controls live in the desktop sidebar account menu and the mobile navigation sheet: theme selection is always available, while authenticated users also get self-service password change (`/admin/account/password`), personal passkey management (`/admin/account/passkeys`), and logout. Admin users and roles stay under Settings > Users & access; personal passkeys no longer live there.
- Host management now uses dedicated host detail pages at `/admin/hosts/{id}` (Action Items, Features, Stats, Infos) instead of the legacy host detail modal.
- **Drizzle storage + `api/src/security/secret-box.ts`** — MySQL storage with encrypted auth payload bodies and tokens; API keys stored as sha256 + secretbox ciphertext; supports legacy `sbox:v1` plus key-id ciphertext for rotation via `api/src/security/keyring.ts`.
- **Admin websocket server (optional)** — registered in-process by `api/src/ws/server.ts` and fed by `api/src/ws/publisher.ts`, which streams `admin_events` to connected `/admin` clients; `/admin/ws/info` advertises the public `ws/wss` URL and the latest event id. The admin SPA maps `log.created` actions to targeted panel refreshes (overview/hosts/settings/skills/projects/agents/memories/users/config/profiles) and falls back to overview+hosts for unknown actions.

## How the flow works

1) **Provision a host (admin)**
   - `POST /admin/hosts/register` creates or rotates a host, hashes + encrypts the API key, and mints a single-use installer token. Optional `vip=true` marks the host as VIP immediately (quota hard-fail disabled). Insecure hosts get a provisioning window (default 30 minutes, or `duration_minutes` from register when provided); secure hosts expect long-lived local auth. The returned installer metadata includes `mode`/`label` so callers know whether the command will install Codex, Claude, or both. `POST /admin/hosts/quick-register` is the throwaway path: it auto-generates a short `tmp-*` host, marks it insecure + temporary, and returns the same installer metadata.
   - `GET /install/{token}` emits a bash script that downloads the baked wrapper(s), installs the matching CLI tool(s), prints an engine-appropriate quickstart, and leaves the wrapper(s) ready to run. Tokens expire (`INSTALL_TOKEN_TTL_SECONDS`) and are marked used on first fetch.

2) **Every `/auth` call**
   - The auth-verification worker runs on boot and then every `AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS` (default 300s), refreshing stale Codex/Claude canonical payloads according to `AUTH_RUNNER_VERIFY_TTL_SECONDS` (default 900s). Successful stale probes also refresh per-engine runner telemetry, so the runner card reflects auth readiness for `cdx`/`clx` startup. `/auth retrieve` reads that stored verdict and does not run runner probes inline.
   - API key auth: resolves client IP, enforces per-IP binding unless `allow_roaming_ips` or `?force=1` on `DELETE /auth`; insecure-host window gating applies to `/auth` retrieve (and other window-gated routes), while `/auth` store submissions are still evaluated as candidates when the window is closed.
- Versions: reports the effective fleet Codex target (GitHub latest with stale fallback plus an internal minimum floor of `0.125.0`), `client_version_enforce_exact` downgrade policy, wrapper version/sha from server disk, runner state, quota policy (`quota_hard_fail`, `quota_limit_percent`, and optional `quota_week_partition` pacing), `auto_update_enabled` for managed update hosts, and the fleet-wide `cdx_silent` quiet flag. When auto-update is enabled, normal `cdx`/`clx` startup self-updates the wrapper from the API artifact, re-execs the original argv, then repairs a locally stale Codex or Claude CLI; `--cron` is only an optional scheduled trigger. When Codex self-management is skipped, the summary note still distinguishes active-run, unsupported-platform, and true privilege-skip cases; privilege skips still include the wrapper-detected UID to expose root/user-namespace mismatches directly in the output. VIP hosts force warn-only (`quota_hard_fail=false`) regardless of the global policy.
- Wrapper self-update decisions are edge-triggered: matching wrapper version plus matching baked SHA stay `current`, so hosts do not redownload and restart into the same wrapper just because the decision helper returned the wrong shell status.
   - Retrieve path: compares client `last_refresh`/`digest` to canonical. Returns `valid`, `upload_required`, `outdated`, or `missing`, plus host stats (API calls, monthly token totals) and recent digests (remembered per host).
   - Store path: validates RFC3339 `last_refresh` (>= 2000‑01‑01, <= now+300s), enforces token entropy/length, normalizes/sorts auths, and synthesizes entries from native engine tokens when needed. When the runner is configured, a positive live verdict is required before persistence; definitive credential rejection returns 422, while transient runner/provider failures return 503 without poisoning canonical auth. With no configured runner, a new lineage may be stored `pending`, but it cannot replace a selected `failed` lineage. The same path applies to admin and seed uploads. Store submissions remain candidates regardless of insecure-window state, but still require normal API-key/IP/reverse-DNS/installation checks. A usable runner `updated_auth` replaces the candidate; a present unusable or older refreshed payload fails closed. On success, the encrypted body, per-target entries, host sync state, and digest cache commit together.

   - Canonical ordering is monotonic per engine. RFC3339 values are compared by
     instant; a newer structurally valid pending/failed row is never bypassed
     for historical verified auth. Store and worker operations serialize
     runner work, re-resolve before commit, and return `updated`, `valid`, or
     `outdated` with the authoritative payload. Every accepted canonical digest
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
   - Enabled when `AUTH_RUNNER_URL` is set (default in compose). The background worker keeps the latest Codex/Claude canonical payloads verified/refreshed; store paths still validate synchronously before accepting new auth. Runner failures are logged (`auth.validate`/`auth.runner_store`), do not block `/auth` retrieve, but **do** block canonical-auth-changing uploads, including admin uploads and seed uploads.

4) **Wrapper distribution**
   - `/wrapper/v2/meta` (and the legacy `/wrapper` alias) returns the per-platform binary manifest. `/wrapper/v2/download` returns the raw Go binary for v2-aware clients, and `/wrapper/download` remains the legacy shell-transition path for date-versioned wrappers. New wrapper versions roll out by publishing under `storage/wrapper/v2/bin/<engine>/<os>-<arch>/v<version>/<binary>` (CI does this from tagged releases); hosts pick up the new binary on next run via the signed config's `binary_sha256`.
   - The wrapper exposes a short Spark-lane alias: `cdx ls` rewrites to `cdx lane spark` before normal lane/profile parsing. Every explicit lane selection is a server-side preference and therefore persists; the old `--persist` spelling remains accepted as a compatibility no-op.
   - Help-only invocations (`cdx --help`, `cdx -h`, `cdx help`, and Codex subcommand help such as `cdx exec --help`) bypass wrapper startup noise and print only upstream Codex help text. They skip the managed run lock, sync, update, MOTD, and footer, but remain supervised so the native child inherits both auth-session and active-child descriptors until it exits.
- Wrapper startup pull sync is batched: it probes `POST /sync/status` and, when updates exist, pulls content via `POST /sync/bootstrap` (AGENTS/config in one flow). When local auth is already valid, that same bundle path now also carries auth metadata/refresh inline (`include_auth=true`), and `auth_candidate` is processed before canonical auth is returned so fresh local logins upload to canonical storage before launch. Native Claude credentials without `last_refresh` are compared against canonical form first and only stored when they actually differ, preventing a server copy from overwriting a fresh local OAuth credential. Older servers automatically fall back to legacy per-resource pull endpoints, but transient bundle failures do not trigger extra per-resource retries during startup.
- Wrapper Codex updates now key off `/auth` `client_version_enforce_exact`: floor-only targets only trigger upgrades, while explicit above-floor pins can still downgrade to match.
  - When the Projects module is enabled, the managed `coco` skill is published through MCP `skill://coco`; there is no separate wrapper-side project bootstrap pass. When the module turns off again, the managed skill disappears from the MCP resource list, and wrapper cleanup removes stale local skill directories so old CoCo docs cannot shadow the project-only skill.
- `POST /sync/bootstrap` can also process auth in the same request when `include_auth=true`: when `auth_candidate` is provided, the server uses the same runner-validated canonical store path as `/auth store`, reports `auth_stored` on success, and returns store metadata including `runner_applied` / skipped-reason fields. A deterministic malformed/unusable/provider-rejected candidate may receive an older verified canonical only with `candidate_rejected_definitive:true`; transient failures omit the signal and preserve the newer local generation.
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
   - Interactive SSH terminals launch Codex through the same direct TTY path as local terminals, avoiding wrapper-owned PTYs around the Codex UI. Alt-screen stays enabled by default; `CODEX_SSH_ALT_SCREEN=1` is only an explicit inline-mode override. `cdx doctor` reports SSH env hints and launch mode for troubleshooting.
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
     while `cdx login status` never acknowledges it. cdx follows
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
   - The active-child guarantee covers processes launched through `cdx`/`clx`.
     A separately invoked raw `codex` or `claude` process does not participate
     in wrapper leases; operators needing race-safe fleet auth should use the
     wrappers consistently.
   - When a host already has an active wrapper run, the concurrent guard still
     skips managed content/update writes and peer reconciliation, but performs
     the auth freshness check and keeps API/auth/runner health visible. The
     outcome says `SYNC PAUSED`, not the over-broad `READ ONLY`; an explicit
     `--allow-concurrent-sync` remains the write-enabled escape hatch.
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
   - Host sync uses `/skills` list/retrieve/store; admin routes write delete markers that propagate to hosts on next sync. When project coordination is enabled, this same path auto-ships the managed `coco` skill to clients.
   - Shared project state itself is served live through `/projects*` and project-aware MCP tools/resources rather than through startup sync payloads.

6) **Quotas**
   - The `quota-cron` Compose sidecar polls ChatGPT `/wham/usage` using canonical tokens immediately on startup and then on `CHATGPT_USAGE_CRON_INTERVAL` (default hourly). It respects the service's five-minute cooldown, writes its health heartbeat only after a usable provider snapshot, and retries on the next interval after failure. Results are cached and surfaced on `/auth` responses and admin dashboards with dual-lane metadata: normal + Spark windows and provider rate flags. `/auth` shapes `active_quota_lane` per calling host (`spark` only for a Spark-preferring host; otherwise `normal`) instead of reusing the account snapshot's default. If no readable snapshot exists, the host still receives `{status:"unavailable", active_quota_lane:...}` so the wrapper renders unknown quota health explicitly.

## Safety rails

- **Rate limits** — Global per-IP bucket for non-admin paths (default 120/minute, tunable); auth-fail bucket throttles repeated missing/invalid API keys with a block window when tripped. Limits return 429 with reset metadata.
- **IP binding & roaming** — First successful call pins the API key to that IP (and a second IP if the host is dual-stack: one IPv4 + one IPv6); optional roaming flag updates the stored IP. For a planned static-IP change, Host Detail’s **Release IP binding** action clears both stored addresses with an audit record, so the next valid host request claims the replacement address without changing the host’s security or roaming policy. Reverse DNS enforcement (when enabled) requires the caller IP to appear in the host’s A/AAAA records and have a PTR back to the host FQDN; runner probes can bypass via CIDRs; `DELETE /auth?force=1` allows uninstall from a different IP.
- **Insecure hosts** — Require an active sliding window (0–480 minutes, default 10, set via the log-ish dashboard slider or `duration_minutes`) for `/auth` retrieve and other window-gated host routes. Each non-store `/auth` call extends the window by that duration. `/auth` store submissions are still accepted as candidates when the window and grace period are closed, do not open/extend the window, and pass every normal authentication/validation/runner gate. New insecure hosts start with a provisioning window (default 30 minutes, overridable via register `duration_minutes`); secure hosts keep auth on disk. Every auth-aware cdx/clx invocation holds a shared session lease, updates its own purge request from live API security metadata, and only the last exiting process purges native credentials; active native children defer that purge and explicit logout intent is retained. When insecure approvals are enabled and an admin websocket client is connected, closed-window retrieve requests return a pending response and the wrapper waits for approval inside a single refresh-in-place terminal status box that points the operator to Admin `Enable window` and shows last-check/check-count metadata. Pending approval requests auto-deny after five minutes, removing them from the admin queue and returning `insecure_denied` to polling hosts; optional domain auto-allow rules can auto-open windows for matching subdomains while active.
- **Auth integrity** — Digest is sha256 over canonical JSON; stored digest mismatch triggers validation logging. Timestamps are clamped to reasonable bounds.
- **Encryption & secrets** — Secretbox protects API keys, payload bodies, and token entries; key is auto-generated/persisted in `.env` if absent. API keys also stored as sha256 hashes for lookup.
- **Kill switches** — Admin can disable the API (`/admin/api/state` 503s everything else) or set quota mode + limit slider (`/admin/quota-mode` exposes warn-only vs. hard-fail, `limit_percent`, and optional `week_partition` pacing for a daily allowance bar in `cdx`). Hosts can also be marked VIP (per-host toggle) to bypass the quota kill-switch entirely (always warn-only). Admin routes honor mTLS by default.

## Data retention & pruning

- Canonical auth lives in `auth_payloads` (encrypted body + sha256) with per-target `auth_entries` (encrypted tokens). Those canonical payloads are engine-scoped (`codex` and `claude`), `host_auth_states` tracks what each host last saw per engine, and `host_auth_digests` caches up to 3 recent digests per host per engine.
- Hosts are pruned when inactive for `inactivity_window_days` (default 30; set to `0` to disable; configurable in Admin Settings → General), never provisioned within 30 minutes, or when `expires_at` is in the past (temporary hosts; refreshed on successful host contact for a 2-hour idle window); pruning logs `host.pruned` and cascades digests/state/users.
- Logs, Skills, project coordination tables, ChatGPT snapshots, and version flags all live in MySQL; storage is the compose volume.

## Fleet workflow at a glance

- Bring up the stack (`cp .env.example .env`, set DB/host vars, `docker compose up --build`; add `--profile caddy` for TLS/mTLS frontend). Runner + quota cron sidecars are on by default in compose.
- Log into Codex once on a trusted box; upload that `~/.codex/auth.json` via the dashboard, use the one-time `curl | bash` seed command, or call `/auth` with `command: "store"`.
- For managed hosts: `New Host` → paste the auto-copied `curl …/install/{token} | bash` command on the host. For disposable VMs: `Quick VM` → choose Codex, Claude, or Both → paste the auto-copied installer. Codex hosts receive `cdx`, Claude hosts receive `clx`, and dual-engine hosts receive one combined installer that provisions both wrappers against the same host key.
- Host-side usage (how to run Codex via `cdx`, what files it manages, troubleshooting): see `docs/USAGE.md`.
- `cdx` pre-launch helpers are intentionally no-op safe: if `config.toml` yields no OTel exports or the current directory is already trusted, the wrapper continues into Codex instead of treating that as a fatal shell step.
- Set fleet CLI model defaults from Settings → Codex or Settings → Claude. Both tabs call `GET/POST /admin/model-defaults/:engine` and constrain effort to the selected model. Codex persists `model` / `model_reasoning_effort` in canonical `config.toml`; its model defaults are Sol `low`, Terra/Luna/GPT-5.5/GPT-5.4/GPT-5.4 mini `medium`, and Spark `high`. Claude persists `model` / `effortLevel` in the deep-merged `settings.json` partial and defaults to Sonnet 5 at `high`. Fable 5, Opus 4.8, and Sonnet 5 persist `low|medium|high|xhigh` with default `high`; Opus 4.7 uses the same set with default `xhigh`; Sonnet 4.6 persists `low|medium|high`; Haiku 4.5 omits effort. The nearby Claude API defaults (`default_model`, `max_tokens`) also default to Sonnet 5 but configure only the Anthropic-compatible proxy and do not change managed Claude Code sessions.
- Build/edit `config.toml` from `/admin/config.html`; saved output is baked per host and synced by `cdx` to `${CODEX_HOME:-~/.codex}/config.toml` (managed HTTP MCP entry; secure hosts use the host API key, insecure hosts get a short-lived bearer). New builder drafts default to `model = "gpt-5.6-terra"` with `model_reasoning_effort = "medium"`, `personality = "friendly"`, `[features].apps = true`, `[features].fast_mode = true`, `[features].memories = true`, and `[features].multi_agent = true`; the admin builder keeps `guardian_approval`, `js_repl`, `tui_app_server`, and `prevent_idle_sleep` off until explicitly enabled. `status:missing` deletes the local copy. Legacy feature keys (`steer`, `experimental_windows_sandbox`, `enable_experimental_windows_sandbox`, `request_permissions`, `use_linux_sandbox_bwrap`) remain ingest-compatible but are dropped from rendered output.
- Enable shared project coordination from Settings → Projects when you want multi-agent notes/todos/files/feedback; that toggle publishes the managed `coco` skill through MCP `skill://coco`. Disabling the module removes that managed skill from the MCP resource list. Shared CoCo handoffs are project-only; host-scoped MCP memories are not a cross-server fallback. The Settings panel stays compact and opens each project on its own `/admin/projects/<slug>` workspace page, where the admin UI can also ask the runner to draft missing `title`/`name`/`description` metadata and a roster draft from the current shared project context before the operator saves.
- Rotate tokens by updating the trusted machine’s `auth.json` and pushing again (dashboard upload or `/auth` store from any host with the new digest).
- Decommission with dashboard delete or `cdx --uninstall` (calls `DELETE /auth`).

## Operations

- Logs are stored in MySQL (`logs` table). For a quick peek in a default Docker setup you can run:  
  `docker compose exec mysql mysql -u"$DB_USERNAME" -p"$DB_PASSWORD" "$DB_DATABASE" -e "SELECT * FROM logs ORDER BY created_at DESC LIMIT 10;"`
- The legacy `host-status.txt` export has been removed; use the admin dashboard (`/admin/overview` and `/admin/hosts`) for current host status.
- Timestamp comparisons normalize RFC3339 strings including fractional seconds, so Codex-style values such as `2025-11-19T09:27:43.373506211Z` are supported.
