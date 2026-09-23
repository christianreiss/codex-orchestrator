# 2026-09-23

- **Setup wizard streamlined end to end.** After `bin/install.sh` creates the owner, the console sends a signed-in admin with an unfinished wizard and open checklist items to `/admin/setup` once per browser session, starting at Engines. Skip on Fleet defaults saves catalog defaults (no more silent `config_missing`); Skip on Engines records nothing; progress marks follow step ids; Continue/Finish submit typed credentials and hostnames; a 401 goes to `/login?next=/setup`. Dashboard setup items are links. One stepper, choice cards, footer-only actions, success/warning tokens, read-only code blocks, and a Claude effort picker across all steps.
- **One host registration form with live install progress.** The Hosts sheet and the wizard share `HostRegisterForm`; engines default to the wizard answer. Chips now say what they do: *Trusted — no approval window* and *Skip TLS verification* are independent (the "mTLS only" label was wrong). After minting, a timeline shows Installer fetched → Wrapper installed → First sync (polls every 5s), with inline *Seed credentials* and *Re-mint installer* (never re-registers, so the API key is not rotated). Quick VM copy: the token lasts 30 min, the temporary host 2 h.
- **cdx/clx first run (wrapper 0.9.3).** A progress line while syncing, uploading and installing; a missing engine CLI is installed in the foreground before giving up with exit 127; `cdx` now offers `codex login` when no credentials exist anywhere, and both engines ask (default yes) before a native login and never start one without a TTY. Repair hints read `cdx cron run` / `clx cron run` everywhere. Skills listing and the version probe overlap the sync call.
- **Installer token errors now reach the terminal.** `/install/{token}` and `GET /seed/auth/{token}` answer used/expired/missing tokens with HTTP 200, `X-Installer-Error: <code>` and a script that prints the reason to stderr and exits 1; the old 4xx made `curl -fsSL … | sh` run an empty script. Consuming an installer publishes `host.updated`, and `/admin/hosts` + host detail gain `installer_used_at` / `installer_expires_at`.
- **Host installer preflight, first sync, and aligned notices.** Missing `python3`/`curl` or an unwritable bin root stops before the header card with one line and a fix each; after the CLI checks each engine runs one non-fatal `--allow-concurrent-sync sync` (warn, never `INCOMPLETE`); the duplicate `cxx agent service install` is gone (`cron run` installs it). Notice lines follow the wrapper grammar: 7-wide topic, detail on the next line, ASCII `+ ! x >`, piped form `cdx topic: message`. Retry hints read `cdx cron install` / `cdx cron run`.
- **Setup status: live database probe, wizard engines, fleet defaults.** The `database` check runs `SELECT 1` and reports failure instead of 500ing; `default_engines` (wizard answer, else configured) drives the auth next actions; new `fleet_defaults` next action before `first_host`.
- **`bin/install.sh`: data root follows the domain; no runner-URL prompt; `--tls` required when scripted.** `urls` runs before `dataroot`, whose default is `/var/docker_data/<domain>`. `--non-interactive` lists a missing `--tls` with the other missing values instead of silently choosing `none`. `verify`/`doctor`/owner read the 503 `/readyz` body and print each failing check with its fix. The owner step validates username/email like the server and prints the API's error message; the closing message points at `/admin/setup`.
- **README rewritten with fresh screenshots.** Feature-first tour with twelve new images of the current console, portal and `cdx`/`clx` boot screens; regenerate them with `cd frontend && npm run shots:readme` (Playwright against a mocked demo fleet).
- **Hotfix: IPv6-bound hosts rejected with `ip_mismatch` since wrapper 0.8.14.** 47 hosts were bound IPv6-only and now dial over IPv4; migration `0033` releases those bindings so each host rebinds on its next request (same as *Release IP binding*).
- **Engine enable/disable applies on the next `cdx`/`clx` launch (wrapper 0.9.2).** A changed `/auth` engine set queues maintenance past its cooldown instead of waiting up to 15 minutes.
- **Host installer adopts the `cxx` terminal UI.** `/install/{token}` shows a host card, wrapper notice lines and engine badges on UTF-8 terminals; piped/`LC_ALL=C`/`TERM=dumb` output unchanged.
- **Insecure approvals alert moved to the sidebar.** Amber nav item with count linking to `/hosts?insecure=1` on every page; the Overview banner is gone.
- **`scripts/deploy.sh` publishes the `cxx` wrappers.** Bump `VERSION` in `wrappers/Makefile` and deploy; builds four platforms, verifies the signing key, publishes, recreates the api. `--skip-wrappers` opts out.
- **Quota provider question: usage bars and `1`–`4` hotkeys (wrapper 0.9.1).** Keys follow the provider (`1` cdx, `2` clx, `3`/`4` remember for today); Enter keeps the invoked engine.
- **cdx/clx terminal UI refresh (wrapper 0.9.0).** One `✓/▲/✗ <persona> <topic>` message grammar, arrow-key menus for questions, 24-bit palette; pipes/`--minimal` keep line prompts. Requires Go 1.25.8.
- **Agent chat redesigned Messages-style** on `/go` and Active Clients: searchable conversation list, bubble thread, pill composer, *Needs you* bar with quick replies.
- **Codex models `gpt-6-sol` and `gpt-6-luna` added** (default `medium`; codex-cli 0.156.1). `gpt-5.5` stays until its 2026-10-14 retirement.
- **Insecure-access approval dialog redesigned.** Stale requests retired server-side every 10s (new `expired` status), caller IP recorded, focused per-host cards with countdown and Approve/Allow domain/Deny.
- **Fixed `config.toml` drift against codex-cli 0.156.1.** Dropped removed keys, `local_provider` → `oss_provider`, no more top-level `profile` (now a hard boot error upstream), per-profile sandbox tables and `[security]`.
- **Added `claude-opus-5-5`** to the Claude model catalog (default effort `medium`).
- **`cdx update`/`clx update` now update the engine too** via `EnsureEngineCurrent` after every `sync`, not only on the cron tick.
- **Fixed `401 ip_mismatch` on dual-stack hosts (wrapper 0.8.14).** Wrapper HTTP clients now prefer IPv4 (`ipv4.PreferDialContext`), falling back to IPv6 only without an IPv4 route.

# 2026-09-22

- **Lean Projects reads.** New `project_summary` (call it first), `project_files`, `project_notes`, `project_feedback_list`, windowed `project_file_read`, `project_changes payloads:"preview"`, `project://{slug}/summary`.
- **`project_changes` accepts `since_seq`** as an alias and no longer truncates `since` to 32 bits.
- **Project files capped at 4 MiB** and accept `encoding: "base64"` (migration `0031`); digest/size describe decoded bytes. Mime type inferred from extension.
- **Project tool schemas closed** (`additionalProperties: false`); unknown args error, enums enforced case-insensitively, legacy aliases declared.
- **Board cards gain `due_at` and dependencies** (migration `0032`): `ready`/`waiting_on`, advisory `depends_unmet` on claim, cycles refused.
- **Board templates.** `project_create`/`POST /admin/projects` take `board_template`: `software` (default) or `migration`.
- **Projects can be finished.** New `project_update`, `project_archive`/`project_unarchive`, `project_feedback_update`, `project_note_delete`; `project_list include_archived`; console Archive/Reopen.
- **Console project tabs stop fetching every file body** via `GET /admin/projects/{slug}/summary` and `/files/{id}`.
- **Fixes:** `project_summary` board status always "disabled"; project memory events now refresh open Activity tabs.
- **Managed `coco` skill** now opens with `project_summary` and covers the lifecycle steps (hosts resync it).

# 2026-09-20

- **`cxx agent doctor --json` reports `channel_policy` for Claude** (`approved` / `fallback`), exposing hosts on the development-channels fallback.

# 2026-09-19

- **Fixed Claude messaging on pre-0.8.11 wrappers.** The plugin-shaped `cxx-agent` config and permissions are now gated on the host's reported wrapper version.
- **Old engine versions are swept.** Each maintenance tick keeps only the selected version under `~/.cxx/engines/{claude,codex}`; uninstall/disable removes the store.

# 2026-09-18

- **Claude stops prompting for development channels.** `clx` ships `cxx-agent` in its `cxx-receiver` plugin, approved via a `managed-settings.d` drop-in (falls back to the prompting flag).
- **Claude permission allowlist moves to `mcp__plugin_cxx-receiver_cxx-agent__*`** and adds `Bash(clx:*)`/`Bash(cxx:*)`; user-scope `mcpServers.cxx-agent` no longer served.

# 2026-09-17

- **Compatibility API requests get their own runner timeout.** `AUTH_RUNNER_EXEC_TIMEOUT` (default 600s) replaces the inherited 8s probe timeout.
- **cxx 0.8.10 removes receiver chat probes;** reception uses silent native health checks and the UI offers Reconnect receiver.

# 2026-09-16

- **cxx 0.8.9 auto-connects interactive sessions to peer/portal reception** via native queues/Channels; Clients and `/go` show receiver evidence.

# 2026-09-15

- **Claude login expiry warnings (wrapper 0.8.8).** Dashboard and clx show a three-day countdown with renewal instructions.

# 2026-09-14

- **Quota-based provider choice at startup.** cdx/clx recommend the less-pressured provider, optionally remembered until midnight (`run --quota-choice-reset`); configured under admin Quotas.

# 2026-09-13

- **Runner ships Codex 0.154.0** with checksums, fixing rejected `gpt-6-astra` probes that blocked credential acceptance.
- **cxx 0.8.6:** final credential uploads share one 15s budget. Request IDs now match between logs and response headers.

# 2026-09-11

- **`cxx remote` scaffold (default off, `remote_exec_enabled`).** SSH ControlMaster reuse with on-disk job state; remote operations currently return `not implemented`.

# 2026-09-10

- **Cron ticks no longer request credentials.** Content-only sync stops per-tick approval requests and Claude trust-loss teardown on insecure hosts.
- **`/sync/bootstrap` and `/sync/status` skip the insecure-window check** when `include_auth: false`.

# 2026-09-09

- **File transfer between agents** (off by default): `transfer_put/get/info/delete`, chunked by `offset`, required `ttl_seconds`, byte caps, per-file audit trail, `transfers.download` capability.
- **Insecure approvals:** resolved rows animate out; allowing a domain approves all its pending hosts; approvals default to 8 hours; domain allows can be permanent.
- **Documentation re-aligned with code** across README, `docs/*.md`, wrapper README and the manual.

# 2026-09-08

- **Needs you banner** above the composer in both WebUIs; `cxx portal resolve --summary` withdraws an attention notice (cxx 0.8.4).
- **Active Clients rebuilt (cxx 0.8.3)** with counts, filters, search and resilient refresh/stream reconnection; presence and delivery reject expired bridges and disabled hosts.
- **cxx 0.8.2: upgrades move to background maintenance.** Launches never wait on engine/wrapper updates; one coordinator, cron every 15 min, atomic engine installs.

# 2026-09-07

- **cxx 0.8.1 auth hardening.** Both engines upload rotations every 2s, pull canonical changes mid-session and preserve concurrent native writes.
- **cxx 0.8.0 terminal output overhaul** with a shared renderer, quota meters and a PTY verification matrix; Claude quota reports added to status output.
- **Fixed Codex quota reset countdowns** after a window expires, and engine routing so Claude requests never fall back to Codex state.
- **cxx 0.7.28:** `cdx sync`/`clx sync` exit nonzero on failed writes or offline fallback.
- **Admin shell refresh:** navigation, per-engine runner status on Overview, engine settings with unsaved-change indicators.

# 2026-09-06

- **Claude settings audit.** Fixed `outputStyle` (keyed by frontmatter name), fleet hooks shape, `advisorModel` (haiku dropped, rank pairing enforced), `statusLine` validation, clx argv parsing for five value flags; added `SessionEnd`/`PostCompact` hooks.
- **Engine audit against codex-cli 0.153.4 / claude-cli 2.1.261.** `gpt-5.4-mini` retired → `gpt-5.6-luna`, `gpt-6-astra` gains `ultra`, Sol default `low`, `claude-fable-5-1` added, 23 removed feature flags dropped, missing subcommands forwarded.
- **`cdx --execute` docs corrected:** it runs with the fleet's sandbox policy, not read-only; wrapper-only flags documented.

# 2026-09-05

- **`gpt-6-astra` is the Codex default** (`medium`); catalog trimmed to seven models, `gpt-5.4` selections migrate to Astra.

# 2026-09-04

- **Console can talk to agents.** Migration `0027` lets admin users author agent messages; `/go` accepts console sessions; composer, prompt answering and close actions in the console.
- **Active Clients page** (`/admin/clients`) with presence, current task/branch and force-close; `agent_portal.reveal_transcript` gates timelines.
- **Agent presence derived from heartbeats.** `agent_list(online:true)` stops returning dead agents; Git Director reclaims crashed holders within 45s; `agent_list` ranked and capped at 50.
- **ChatGPT usage card** shows only reported windows, adds the Spark lane and fixes sparkline/history labels after the July payload change.
- **Fleet insecure window.** One deadline (5 min–24 h, default 8 h) admits all insecure hosts; closing clears host windows and domain allows; TopBar countdown.

# 2026-08-27

- **Project board with claims replaces todos** (migration `0026`). `project_board_list`, `project_card_create|claim|move|release|update|get`; claims reclaimed on agent death or 30-min TTL; `project_todo_*` keep working as a card view.

# 2026-08-25

- **Legacy-launcher hosts get `cxx` on `PATH`,** fixing the `cxx-agent` MCP server failing to start.
- **Fixed wrapper publishing leaving 0700 directories** that the API couldn't read, stranding hosts on the previous version.

# 2026-08-24

- **Git Director** (off by default, `git_director_enabled`): `git_register|list|join|merge_request|merge_status|release`, advisory per-clone merge arbitration with model verdicts only on contention, dead-agent reclaim, console page (migration `0025`).

# 2026-08

- **Default-deny admin authorization.** Every `/admin/*` and session-guarded `/cli/auth/*` route now maps to one capability in a role matrix (`api/src/security/capabilities.ts`); the API refuses to boot on an unmapped route, and denials return `403 admin_role_required`. Migration `0022` sets `compatible` mode on existing installs (behavioral no-op, logs would-be denials at `GET /admin/authorization`) and `strict` on fresh ones; `POST /admin/authorization` switches. Closes a live leak: `GET /admin/hosts/{id}/auth?include_body=1` now needs `auth.reveal_credential` (owner/admin only).
- **Refresh-token races closed for both engines.** Runner `/verify` probes now use refresh-stripped credentials (empty `tokens.refresh_token` for Codex), `/exec` no longer returns `updated_auth`, expired-access canonicals keep their verdict instead of being probed, and `cdx`/`clx` upload mid-session rotations every 30 s. The per-user `cxx-agent` worker also watches Claude credentials so detached `claude daemon run` rotations are uploaded (wrapper `0.7.23`).
- **Adaptive verifier cadence.** Re-probe interval grows with proven-good age between the 900 s TTL and `AUTH_RUNNER_VERIFY_MAX_INTERVAL_SECONDS` (default 6 h); successful gateway execs count as verification.
- **`#call` and live agent conversations.** Agents dial each other with a single-use four-digit PIN (`agent_call_open`/`agent_call_join`/`agent_listen`, `cxx agent call-*`); `agent_messaging.listen_enabled` lets interactive sessions receive. All four Codex/Claude directions verified live; `agent_send` over MCP fixed; relay install enables `loginctl` lingering. Agent Messaging is now governed by the fleet switch alone (insecure hosts inside their window included; `POST /admin/hosts/{id}/agent-messaging` removed; needs cxx `0.7.8`), and the served `AGENTS.md`/`CLAUDE.md` gain an Agent Messaging section.
- **Fleet security posture: nine 0–4 axes.** Replaces the frozen policy literal with an operation matrix projected into Hard Stop Lines, safety floor and a new `## Standing Authorizations`; applied as a bake-time overlay on `config.toml`/`settings.json` via named profiles (`agent_policy_profiles`, migration `0018`). Fleet Instructions gains a Generated/Manual/Disabled switch (`/admin/agents-generation-mode`), a live effective-document preview, and setting↔block provenance highlighting.
- **Guided installer and first-run wizard.** `bin/install.sh` (twelve resumable steps, `--json`, `--non-interactive`, `doctor`) replaces `bin/setup-quick.sh`; `migrate.js --init-schema` bootstraps an empty DB from `api/src/db/baseline/schema.sql`. `/admin/setup` becomes a nine-step wizard (`setup_wizard_state`) with a shared `SeedAuthPanel`. Client-certificate mTLS generation removed (`ADMIN_ACCESS_MODE` is `cookie|open`); Caddy ACME state now persisted in volumes.
- **`cxx sync` and content convergence.** New `cxx|cdx|clx sync`; `cxx update` re-execs into a sync-only pass and the nightly `cxx cron run` tick now syncs managed content. Session-exit engine installs re-resolve their target via `POST /cron/check` (`probe: true`), and per-host client version pins finally reach wrappers.
- **Agent Portal honesty pass.** Relay opens only during a live `cxx portal wait`; new `working` presence; force-end reachable for dead agents; undelivered messages marked; freshness windows configurable (`AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS`, `AGENT_PORTAL_RELAY_FRESH_SECONDS`). Every long poll in the fleet had returned instantly (`req.raw.destroyed` misuse); fixed.
- **Wrapper config lifecycle.** Signed configs carry a 30-day `expires_at` (`WRAPPER_CONFIG_TTL_SECONDS`) with self-healing refetch; multiple active signing keys can co-sign (`signatures` array, `api/src/ops/rotate-signing-key.ts`); golden round-trip fixtures under `wrappers/testdata/`. `hosts.config_baked_at` dropped (migration `0017`).
- **Removals.** All orchestrator-enforced rate limiters (migration `0019`; use the reverse proxy); the non-actionable Codex CLI update banner; the fleet-policy prohibition on writing secret values when a task requires it.
- **Optional OpenTelemetry.** API bakery spans behind `OTEL_TRACES_ENABLED`; wrapper spans only in `-tags cxx_otel` builds, gated by `CXX_OTEL_TRACES_ENABLED`.
- **Admin console rebuild.** Route-registry navigation with canonical Engines/Policies/Agent Portal/Knowledge routes (308 redirects for retired URLs), neutral zinc/slate theme, Fleet Policy Builder with versioned AGENTS.md (v55), Secrets discovery guidance, `GET /admin/setup/status` and `/readyz`.
- **Fixes:** host engine toggles now converge via peer-reconcile (Go npm bootstrap, cron no longer aborts on cleanup failure); Codex `web_search` emitted as the string enum (a boolean broke every host's config); relay honors `Retry-After` on 429; heartbeat no longer fails for pre-switch sessions; migration `0016` made idempotent; clearer spent-`#call`-PIN error.

# 2026-07

- **Single `cxx` multicall wrapper.** `cdx`/`clx` become relative aliases to one binary built for four platforms; installers install it once, migrate legacy binaries, and run one host-wide `cxx-managed` cron (cxx `0.7.1`–`0.7.2`). Host detail reports one CXX wrapper version.
- **Agent Messaging and Agent Portal.** Default-off fleet bus for encrypted one-to-one agent messages with ordered at-least-once delivery (`cxx agent`, MCP tools, admin views). Permanent per-user Agent Portal at `/go` (cxx `0.7.5`), made pull-only on 2026-07-30: Matrix push removed (migration `0009`), `POST /admin/agent-portal/users/{id}/resend` gone, links revealed via `GET /admin/agent-portal/users/{id}/link`.
- **Fleet secrets store.** `secrets` table (migration `0010`), MCP `secret_list|search|get` with per-read audit, admin CRUD under `/admin/secrets` plus role-gated reveal, and a managed `## Secrets` block in served agent docs.
- **Memory stores.** Project-scoped `project_memory_*` (`coord_project_memories`), fleet-wide `shared_memory_*` documents with chunked FULLTEXT search and `shared://` resources (migration `0006`), a managed Memory routing block, and the Memory Atlas admin workspace with `/admin/memories` ETag lifecycle API.
- **Automatic migrations.** `api/src/db/migrator.ts` applies idempotent SQL on boot (`RUN_MIGRATIONS_ON_BOOT` default on) and from `scripts/deploy.sh`, tracked in `schema_migrations`; `npm run migrate[:check]` CLI.
- **Verified-only canonical auth.** Codex/Claude credentials must pass live runner verification before acceptance or distribution; unverifiable readbacks are quarantined; a generation ledger rejects replays and rollbacks (180-day history). Wrappers `0.6.46`–`0.6.53` harden concurrent sessions, logout intent, and local-first recovery.
- **Compatible API gateways conform to SDKs.** `/anthropic/v1/*` and `/v1/*` now match upstream error types, model endpoints (`GET /models/{id}`), token-cap params, `count_tokens`, and fail closed on unsupported tools/content; a `max_tokens` → CLI flag 502 was fixed.
- **Skills.** Managed `#context` and `skill-manager` skills; agents can `skill_store`/`skill_delete` over MCP; opt-in Matt Pocock skill source; Claude skills sync as complete directory bundles (cxx `0.7.3`).
- **Models and defaults.** GPT-5.6 Sol/Terra/Luna (Terra/medium default), Claude Sonnet 5 default plus Fable 5, Opus 4.8 and Opus 5; fleet model/effort defaults via `/admin/model-defaults/:engine`.
- **Terminal UX (`0.6.44`–`0.6.45`).** Responsive shared dashboard, `--minimal`, `--wrapper-help`, truthful quota/forecast display; `cdx resume`/`clx resume` now actually resume.
- **Admin UI.** Task-based navigation, light/dark system, password-reset flow, Release IP binding action, Switchyard brand mark, list+detail CRUD pattern.
- **Fixes:** `cdx --execute` no longer forces a read-only sandbox that disabled MCP (`0.6.55`); dual-engine cron staggered by 30 min; fresh `cdx login` no longer clobbered by stale canonicals (`0.6.41`); `/sync/bootstrap` envelope unwrapped; insecure approvals auto-deny after 5 min; `curl_insecure` covers installer downloads; ChatGPT quota refresh every 15 min; MySQL 8.4 native-password flag.

# 2026-06

- **Auth verification moved to a background worker.** `/auth` retrieve and `/sync/bootstrap` now return the stored `verification_state` instead of probing the runner inline; a worker re-verifies both engines every `AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS` (default 300s).
- **Launch gate proves auth before reporting green.** `ensureServedVerification` runner-verifies served canonical auth for Claude and Codex (TTL `AUTH_RUNNER_VERIFY_TTL_SECONDS`, default 900s, single-flighted); wrappers refuse on `verification_state=failed` rather than launching into a 401 or dead refresh token.
- **Interactive login recovery.** `cdx` and `clx` offer `codex login` / `claude auth login` when managed credentials fail, upload the result through `/auth command=store` and re-check; non-interactive runs fail closed. `clx auth ...` passes through.
- **cdx and clx production-readiness passes.** Fixed `cdx lane`, the `-4` IPv4 proxy for HTTPS, `cdx doctor` verdicts, skills change detection, Spark quota decoding, `QUOTA_HARD_FAIL=0`, the FQDN guard ordering, `clx help` hangs, OAuth offline freshness, and unverified peer-bundle signatures.
- **Claude permission mode defaults to `auto`.** Rendered as `permissions.defaultMode` (the key Claude Code actually reads) and always emitted; pin `default` in Authoring → Fleet settings to get prompting back.
- **Claude auth is native account login.** `claudeAiOauth` is preserved canonically, `clx` stops injecting `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`, and fleet skills sync to `~/.claude/skills/<slug>/SKILL.md`.
- **Per-host engine switches and dual-engine cron.** Hosts toggle Codex/Claude individually (disabled routes return `engine_disabled`); one `--cron run` keeps both wrappers and both CLIs current, and installers bootstrap the primary engine too.
- **Removed token-usage counting and Joplin.** `POST /usage`, the token admin endpoints/tables and dashboard cards are gone (drop migration `0001_drop_token_usage.sql`); the Joplin integration and its tables were removed. `claude_artifacts` table added.
- **Ops and UI.** Added `scripts/deploy.sh`; Codex allowlist is `gpt-5.5`/`gpt-5.4`/`gpt-5.4-mini`/`gpt-5.3-codex-spark`; Claude advisor model is fleet-managed; Users moved to Settings → Users; runner state and host online status became engine-scoped and contact-based.
- **Fixes:** `clx` MCP servers now land in `~/.claude.json`; explicit `/auth` store failures surface as errors; insecure-approval waits no longer look like "API offline"; Codex `latest` no longer resolves stale or downgrades; knip-driven dead-code removal.

# 2026-05

- **Backend rewritten in Node.** The PHP backend was replaced by Node 22 / Fastify 5 / Drizzle / TypeScript under `api/`, with the HTTP contract, MySQL schema and `sbox:v1` envelopes preserved and a native `/admin/ws`.
- **Admin UI rewritten in SvelteKit.** The vanilla-JS SPA became SvelteKit + Tailwind + shadcn-svelte built into `public/admin/`, with a Cmd-K palette in place of chord shortcuts and themes cut to System / Light / Dark; eight features lost in the rewrite were restored.
- **Wrapper bakery v2 (Go).** `cdx`/`clx` became signed static Go binaries with `/wrapper/v2/*`, platform-specific artifacts (`X-Wrapper-Platform`), system installs to `/usr/local/bin` by default, startup self-update via `sudo -n install`, and `/wrapper/download` kept as a legacy transition launcher.
- **Platinum Claude Code support.** Fleet subagents, slash-commands and output-styles live in the `claude_artifacts` table; `~/.claude/settings.json` is deep-merged through `owned_paths` rather than overwritten; `claude_model_override` reaches rendered settings.
- **Claude OAuth credentials accepted.** `claudeAiOauth.accessToken` works for seeding, `/auth`, `clx auth-upload` and runner validation.
- **Removed cost tracking.** Pricing and cost history, run-cost reporting and the Claude spend-limit UI are gone.
- **Admin additions.** Quick VM throwaway hosts, host-detail **Mint installer** (`POST /admin/hosts/{id}/installer`), per-host BrowserOS MCP toggle, single-user passkey auto-prompt, and CoCo `issue`/`test` feedback types.
- **Fixes:** Codex reasoning effort normalized (`xhigh` → `high`); `codex_auth` network pinned to `172.30.250.0/24` (`CODEX_AUTH_SUBNET`); passkey login/registration, ChatGPT `/wham/usage` refresh, runner status and SPA/API route collisions repaired after the cutover.

# 2026-04

- **Claude parity push.** Runner state became engine-scoped (`runner_state_claude` …), `POST /admin/runner/run-claude` was added, API keys became strict per engine (`sk-codex-*` / `sk-claude-*`), and `docs/interface-clx.md` was introduced.
- **Engine-aware host minting.** `POST /admin/hosts/register` emits `cdx`, `clx` or combined installers; host auth tables are engine-scoped, with parallel `claude_*` host fields; admins can add the missing engine to a host.
- **Claude seeding and upload.** Engine-aware seed commands, Claude credential canonicalization into `auths["api.anthropic.com"]`, `clx auth-upload`, and per-host Claude version/model overrides.
- **`cdx auth-upload`.** Normalizes a `codex login` `auth.json` (adds `last_refresh`) and uploads it; the startup bundle uploads fresh local auth when the server reports `missing`/`upload_required`.
- **Codex floor and models.** Codex CLI floor raised to `0.120.0`; `gpt-5.5` became selectable; retired models dropped from the allowlist and force-migrated to `gpt-5.4`; `[features].memories` and `fast_mode` default on.
- **OpenAI-compatible multimodal.** `/v1/chat/completions` and `/v1/responses` keep array content parts and forward images to the runner as `codex exec --image`.
- **Admin UI "warm operator console" redesign.** Paper/Ink themes with terracotta accents and Source Serif 4 headings.
- **Fixes:** runner `/health` readiness probes; seed tokens are consumed only after a successful store; musl Codex assets on newer glibc; the `host_auth_states` PK migration crash loop; the Joplin Server flow was reworked (later removed).

# 2026-03

- **Projects / CoCo module.** Native shared-project coordination under `/admin/projects*` and `/projects*`, `project_*` MCP tools and `project://{slug}` resources, plus a managed `coco` skill; legacy CoCo aliases were removed.
- **Skills over MCP only.** Hosts read manifests through `skill://{slug}` and wrappers stop mirroring local skill files; served AGENTS gets managed `## Skills` and `## Memories` inventories; runner-backed skill drafts (`/admin/skills/generate`, `/admin/skills/assist`) and project assist.
- **Custom prompts removed.** Slash-command/custom-prompt sync is gone end to end, and wrappers prune legacy prompt directories.
- **Cron auto-update covers the wrapper.** `/cron/check` returns wrapper update instructions, `cdx --cron install` checks in immediately, and host auto-update status has derived states in the UI.
- **Admin shell moved to real paths.** `/admin/dashboard`, `/admin/hosts/{id}` etc. replace hash routes; editorial rail nav, account menu, pink themes, an AGENTS workspace with backups, a `?` shortcuts modal, and a rebuilt New Host flow.
- **Passkey hardening.** WebAuthn requires user verification, username-bound login and atomic challenges; `ADMIN_WEBAUTHN_ORIGIN` added; `scripts/admin-passkeys.php` handles recovery.
- **MCP security.** Host-authenticated `/mcp` exposes only host-safe tools, and insecure hosts get a fresh short-lived MCP bearer on each config fetch.
- **Models and config.** `gpt-5.4` and `gpt-5.4-mini` added (default `gpt-5.4`); Codex floor at `0.114.0`; `personality`, `apps`, `js_repl`, bubblewrap, `prevent_idle_sleep` and guardian-approval toggles; OpenAI `/v1/models` lists real models and `/v1/responses` was added.
- **`cdx` wrapper.** `cdx -4` launches Codex behind a local IPv4-only proxy, `cdx ls` is shorthand for the Spark lane, help passthrough skips sync, Codex release downloads require a SHA-256 digest, and there are many SSH/PTY, Bubblewrap and quota-row fixes.
- **Fixes:** a large test-coverage and PHP dedup pass; XSS escapes in the users and MCP logs tables; `/mcp` UTF-8 hardening; repeated `set -e` no-op regressions in the wrapper.

# 2026-02

- **Security and deploy hardening.** Added `TRUST_X_FORWARDED` + `TRUSTED_PROXY_CIDRS`, `PUBLIC_BASE_URL_REQUIRED`/`STRICT_HOST_VALIDATION`, a runner shared secret (`AUTH_RUNNER_SHARED_SECRET`), staged secretbox key rotation (`AUTH_ENCRYPTION_KEYS`, `AUTH_ENCRYPTION_ACTIVE_KID`), `scripts/migrate.php` with `RUN_MIGRATIONS_ON_BOOT`, and removed the un-gated `mtls-debug.php`.
- **Startup sync bundle.** `POST /sync/status` and `/sync/bootstrap` batch the startup pulls; executable JSON contracts were added under `docs/contracts/`.
- **ChatGPT quota lanes.** Normal and Spark lanes are captured from `/wham/usage`, quota enforcement follows the active lane, and `cdx lane` / `POST /host/lane` steer and persist it.
- **`cdx` status, doctor and concurrency.** Wrapper-only `cdx status` and `cdx doctor`, a host-wide active-run guard with read-only secondary runs, atomic sync writes, `NO_COLOR`/`TERM=dumb` support, macOS support, and a redesigned boot summary and run footer.
- **Admin redesign.** Dedicated `/admin/login`, host detail pages at `/admin/hosts/{id}`, left-rail Settings/Hosts/Logs, inline Chart.js graphs, and websocket-driven refresh across the SPA.
- **Models and config.** `gpt-5.3-codex` became the default, `gpt-5.3-codex-spark` was added with a strict model allowlist, and obsolete features were dropped for Codex 0.105/0.106 compatibility; `web_search` is now top-level.
- **Fixes:** insecure "Enable window" 409s; `/auth` store is always evaluated as a candidate; the run-lock is scoped per UID; MCP `startup_timeout_sec = 30`.

# 2026-01

- **Admin login and users.** Admin login, user management, roles and password recovery, with userless bootstrap while no admins exist.
- **Websocket live dashboard.** An `admin_events` table, `/admin/ws/info`, an `admin-ws` service (`ADMIN_WS_ENABLED`) and toasts for authorized/refused `cdx` calls.
- **Insecure-host approval gate.** Optional admin approval with approve/deny endpoints, wrapper wait/poll, domain auto-allow rules, IP rebinding during the window, and `INSECURE_GRACE_MINUTES` / `INSECURE_SESSION_MAX_MINUTES`.
- **Reverse DNS enforcement.** `/auth` can require forward + PTR match globally, with per-host overrides.
- **Seed command and runner-gated store.** A one-time `curl | bash` seed uploads `~/.codex/auth.json` via `/seed/auth/{uuid}`, and `/auth` store runs the auth runner before persisting.
- **AGENTS.md versioning.** Versioned storage with pinned vs latest serving and per-host pins.
- **Wrapper.** `cdx` enforces the baked FQDN (`CODEX_ALLOW_FQDN_MISMATCH=1` to override), adds `-4` for IPv4, passes reasoning effort via `--config model_reasoning_effort`, accepts token-only `auth.json`, and syncs skills as `~/.codex/skills/<slug>/SKILL.md`.
- **Fixes:** dual-stack hosts bind one IPv4 + one IPv6; stored IP columns renamed to `ip4`/`ip6`; many dashboard theme and layout passes.

# 2025-12

- **Canonical `config.toml` and AGENTS.md.** Server-managed `client_config_documents` with `/config/retrieve` (per-host baking, native HTTP `[mcp_servers.cdx]`) and `/agents/retrieve`, plus admin builders; `cdx` syncs both.
- **MCP memories.** `/mcp/memories/*` and the `/mcp` JSON-RPC server with memory/resource tools, resource templates, and an admin Memories panel.
- **Skills registry.** `/skills` endpoints and the `skills` table, managed from Settings → Skills.
- **Quota policy.** `quota_limit_percent` (50–100) with warn/hard-fail, the `quota_week_partition` daily allowance, and VIP warn-only hosts (`/admin/hosts/{id}/vip`).
- **Host controls.** Temporary hosts with a 2h idle expiry, per-host model/reasoning and Codex version overrides, a fleet Codex version pin, IPv4-only and `curl_insecure` flags, configurable inactivity pruning (0–60 days), and installation UUID enforcement.
- **Admin access.** `ADMIN_ACCESS_MODE=mtls|none` replaces `ADMIN_REQUIRE_MTLS`/`DASHBOARD_ADMIN_KEY`; passkeys were removed (later reinstated).
- **Ops.** The `mysql-backup` sidecar is on by default; runner preflight runs every ~8h; outages count as offline so cached auth stays usable.
- **Fixes:** bash 4.2 / old-glibc installer compatibility (musl assets); `cdx --uninstall`; Python 3.9 parsing; many dashboard theme iterations.

Older, verbatim entries: `git show aa09a378:CHANGELOG.md`
