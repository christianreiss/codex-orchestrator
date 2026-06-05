## clx MCP servers land where Claude actually reads them

- **clx (0.6.21):** The managed `mcpServers.clx` block was being merged into
  `~/.claude/settings.json`, which Claude Code ignores for MCP — user-scope MCP
  servers live at the top level of `~/.claude.json`. The wrapper now splits the
  `mcpServers.*` owned paths out of the settings partial and deep-merges them
  into `~/.claude.json` (managed names tracked in
  `~/.clx/state/managed-mcp.json`; user-authored servers and oauth/project
  state survive; unparseable files are never overwritten). The inert block
  older wrappers wrote into `settings.json` is self-cleaned via the existing
  stale-path pass, and the trust-loss strip removes the managed server from
  `~/.claude.json` too. `clx doctor` now checks `~/.claude.json` for the MCP
  block. This fixes Claude Code sessions seeing no `memory_*`/`project_*`
  tools while the same endpoint worked for Codex.

## Host online pill uses real last contact

- **UI:** Hosts → Status pill no longer keys the 24-hour online window off
  `last_refresh` — that column carries the canonical auth payload's mint time
  (identical across the fleet, often days old), so every host rendered as
  Offline. Liveness now uses the freshest of `updated_at` (bumped on every
  auth sync and cron check-in) and the engine refresh timestamps. The
  Online/Offline filter chips inherit the fix.

## Command palette starts with hosts

- **UI:** The `/` command palette now ranks host results before navigation,
  actions, projects, skills, users, and theme entries so fleet lookups surface
  first while typing.

## Wrapper transition names are literal

- **API/Docs:** Removed the ambiguous legacy handoff wording across cdx/clx
  wrapper transition code, generated shell scripts, tests, and docs. The
  generated wrapper handoff now uses `INSTALL_CONTEXT=transition|installer`,
  and test DB helpers are named fakes rather than pretending to be runtime
  adapters.

## Codex latest no longer downgrades

- **API:** Codex auto-update now checks the live `openai/codex` release feed
  and normalizes `rust-v*` release tags, so `latest` resolves to the current
  Codex CLI release instead of the stale `0.130.0` fallback.

## Runner boxes use matching visuals

- **UI:** Dashboard runner state now renders Codex and Claude engine boxes with
  the same action label, icon, and button style. Only the engine name and live
  state differ.

## Users moved under Settings

- **UI:** Users is no longer a top-level sidebar item. The admin user management
  screen now lives at Settings -> Users (`/admin/settings/users`), while old
  `/admin/users` links redirect to the new location.

## clx auth upload accepts native Claude OAuth again

- **Runner/API:** Claude `clx auth-upload` and seed uploads now validate
  `claudeAiOauth` / `sk-ant-oat...` credentials through a native Claude CLI probe
  instead of sending the OAuth access token to Anthropic's public messages API as
  a bearer key, which returned 401 and gated canonical auth storage.

## Logs tabs render rows again

- **UI:** Logs → API, MCP, and Events now render their fetched rows without the
  shared virtualized table path that could leave all three tab bodies blank.

## Project cards can delete directly

- **UI:** Projects overview cards now include a quick delete action with the
  same destructive confirmation modal used by project detail pages.

## Codex auto-update cron resolves Settings targets

- **API:** Codex auto-update cron now resolves the Settings value `latest` to the
  cached available/release version before comparing host versions, and honors
  the Codex exact version lock written by Settings as the cron target.

## Hosts table is slimmer

- **UI:** Hosts → Auto-update was removed from the fleet table. Auto-update
  state and the toggle stay on the host detail page, where changing it has more
  context and less chance of accidental fleet-table clicks.

## Admin hosts status uses recent contact, not lifecycle state

- **UI/API:** Hosts → Status no longer treats `status = active` as “Online”.
  The list/detail payload now includes real `authed` / `auth_outdated` booleans,
  and the host table shows `Online` only when the host has required engine auth
  and a Codex or Claude refresh within the last 24 hours. Missing/stale auth is
  surfaced as a warning, and the Online/Offline/Unprovisioned filters use the
  same classification.

## Dashboard runner state is engine-scoped

- **UI:** Dashboard → Runner state now shows separate Codex and Claude rows with
  each engine's state, last check, last OK/fail timestamp, and manual probe
  action instead of one blended status badge.
- **API:** `/admin/runner` now exposes `runner.engines.codex` and
  `runner.engines.claude` as first-class telemetry while keeping the previous
  combined fields for compatibility.

## clx: Claude advisor model as a fleet-managed `settings.json` key

- **Feature:** the experimental Claude Code advisor tool (routes the full
  conversation transcript to a stronger reviewer model) is now fleet-managed via
  a new top-level `advisorModel` key in `~/.claude/settings.json`.
- **Server:** `advisorModel` is normalized (`normalizeClaudeAdvisorModel`,
  allowlist `opus` / `sonnet` / `haiku` — any other value, including empty, is
  treated as off) and rendered into the Claude settings partial + `owned_paths`.
  It is **not** routed through `normalizeClaudeModel` (a pass-through), so only
  the tier aliases are accepted.
- **Wrapper:** no code change — the deep-merge is generic over `owned_paths`, so
  the top-level scalar is set when on and removed via stale-path cleanup when
  switched off. Added a merge test covering both.
- **UI:** Authoring → Claude settings gains an "Advisor model (experimental)"
  selector (Off / Opus / Sonnet / Haiku); Off omits the key.

## CoCo MCP managed skill is restored

- **Server:** host-facing skill sync and MCP resource reads now derive the managed
  `coco` skill from the Projects module flag again. When Projects is enabled,
  `skill_list`, `skill_retrieve`, `resource_list`, `resource_read skill://coco`,
  and Claude skill bundles expose a read-only managed CoCo skill instead of
  depending on a stored `skills.slug = "coco"` row.
- **Projects bootstrap:** `project_bootstrap` now returns the managed
  `skill://coco` metadata plus native CoCo instructions/quickstart instead of
  `null` placeholders.

## clx: fleet skills now sync on-disk to Claude Code (`~/.claude/skills/<slug>/SKILL.md`)

Claude Code **cannot consume skills over MCP** (skills are strictly on-disk; MCP
only yields tools/prompts/resources) — so the fleet's shared skills reached codex
(which reads `skill://<slug>` over MCP) but never appeared as skills in Claude
Code. Now the orchestrator distributes them to Claude hosts on-disk, 1:1 with how
codex gets them. Authored once in the existing single skills editor; no new UI.
Requires an API deploy + a clx fleet binary bump.

- **Server:** `/sync/bootstrap` (engine=claude) gains `claude_skills` — the
  complete live set of claude-visible skills (`engine` null/`claude`), each
  rendered as a Claude Code `SKILL.md`. The renderer **coerces frontmatter
  `name:` to the slug** (Claude Code's loader keys off it; the stored manifest's
  `name` is the human display name, which would make the skill silently
  invisible). Content omitted on rendered-sha match. The rendered sha is
  bundle-only — `skills.sha256` (the raw-manifest sha the MCP path uses) is
  untouched.
- **Wrapper (clx ≥ 0.6.20):** writes `~/.claude/skills/<slug>/SKILL.md` (one dir
  per skill) with a dedicated `skills.json` manifest; prunes only fleet-written
  skill dirs (user-authored skill dirs and the `skills/` root are never touched);
  removed on uninstall and on trust loss. **`pruneLegacySkillDirs` no longer
  deletes `~/.claude/skills`** (it is now the fleet-managed store) — only the
  bash-era `~/.agents/skills` and `~/.clx/skills` caches. A host pruned at an
  older version self-heals (missing files are re-sent next run).
- **Codex unchanged** — still MCP-only. Also fixed an unrelated engine bias: the
  MCP resource list (`mcp-resources.ts`) hardcoded codex when listing skills,
  hiding any claude-specific skill from the catalogue; it now lists all.

## clx Claude auth is now native account-login (1:1 with codex auth.json)

The orchestrator's core job for codex is keeping `~/.codex/auth.json` current and
distributing it so codex uses it as an **account login**. clx now does the exact
same for Claude — and stops doing two things that broke it. Requires an API
deploy **and** a clx fleet binary push (+ a one-time re-seed; see below).

- **Server: preserve Claude's native `claudeAiOauth` account-login object.**
  `canonicalizeAuthPayload` preserved codex's `tokens`/`OPENAI_API_KEY` but had no
  symmetric branch for Claude, so an uploaded `.credentials.json`
  (`{claudeAiOauth:{accessToken,refreshToken,expiresAt,scopes}}`) was reduced to a
  derived `{auths:{api.anthropic.com:{token}}}` bearer — losing the refresh token
  and the native shape. Claude Code can't account-login from a bare bearer. Now
  the native `claudeAiOauth` is preserved (alongside the derived `auths`, which the
  `/anthropic` proxy still uses), so hosts receive a real `.credentials.json`.
  **One-time re-seed required:** existing canonical Claude payloads already lost
  `claudeAiOauth`; re-upload a fresh `.credentials.json` so the stored payload
  carries it.

- **Wrapper (`clx`): stop hijacking Claude's auth via env.** `env.go` injected
  `ANTHROPIC_API_KEY = <host orchestrator key>` + `ANTHROPIC_BASE_URL = …/anthropic`,
  and `preexec` bridged the credential token into `ANTHROPIC_API_KEY`. Codex tolerates
  the symmetric `OPENAI_*` (it ignores them in account mode), but Claude Code
  *consumes* `ANTHROPIC_API_KEY` — popping the "detected custom API key" prompt and
  overriding the OAuth login with a key the `/anthropic` proxy rejects (host keys
  aren't valid there; that proxy is for issued `sk-claude-*` keys). clx no longer
  sets `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`, and `preexec` only exports a
  *genuine* API key (`sk-ant-api…`), never an OAuth token (`sk-ant-oat…`). Claude
  Code then reads `~/.claude/.credentials.json` natively — exactly like codex reads
  `auth.json`. (Verified: native `claudeAiOauth` authenticates a real `claude -p`
  call; the codex `OPENAI_*` injection is left untouched.)

## clx Platinum follow-ups: no codex model leak into Claude settings + installable second engine

Two defects surfaced by the first real end-to-end `clx` install on a host that
already ran `cdx`. Both are API-only fixes — **no wrapper rebuild**, only an API
redeploy.

- **Claude settings no longer inherit the Codex model.** `retrieveClaudeSettings`
  fell back to the Codex `client_config` row when no Claude-engine config existed
  (the common greenfield state), so the Codex `model` (e.g. `gpt-5.5`) was baked
  into every Claude host's `~/.claude/settings.json` `model` key via the managed
  deep-merge. The fallback is removed: with no Claude config we now render from an
  **empty base** so the managed `mcpServers.clx` block is still delivered, but no
  `model` (or any other key) is borrowed from Codex. Per-host `claude_model_override`
  and an explicit Claude `client_config` still flow through unchanged. After the
  redeploy, the next `clx run` strips the orphaned `model` key (it is in the
  wrapper's `owned_paths` sidecar) while leaving user keys intact.

- **You can now install Claude on a host that already runs Codex.** The installer
  token always picked `primaryEngine = codex` when Codex was present, so the
  host-detail "Claude" button (which sends `engines: ["claude"]`) emitted a `cdx`
  installer — there was no supported way to install `clx` on a dual-engine host.
  `issueInstallerToken` now targets the engine the operator explicitly requested
  when they ask for a single one; the displayed `mode`/label still reflects the
  host's full engine set. Default (no explicit request) behaviour is unchanged
  (codex-when-present).

## Insecure-host approval UX: instant popup + no more false "API offline"

Two fixes to the insecure-host approval flow, so starting `cdx`/`clx` on an
insecure host surfaces an allow/deny box in the admin dashboard immediately and
the wrapper waits for the decision instead of bailing out.

- **Wrappers (`cdx`/`clx`): stop reporting a live API as offline while waiting
  on approval.** The orchestrator answers an insecure host with `423
  insecure_pending` (awaiting approval) or `403 insecure_denied` (rejected). The
  Go client collapsed every `>= 400` into a generic error, which the launch gate
  then synthesised into `status: "offline"` → "API offline" — even though the
  API was up and an operator was in the browser. `client.JSON` now returns a
  typed `HTTPError` carrying the parsed `code`, and `AuthRetrieve` /
  `SyncBootstrap` map `insecure_pending` → `insecure` and `insecure_denied` →
  `insecure-denied`, so the wrapper enters the approval poll loop (the
  previously-dead `case "insecure"` branch in `Decide`). No deploy step.

- **Admin dashboard: the approval popup no longer needs an F5.** The
  auto-popup now opens whenever the pending-approval count rises, not only on a
  live WS event. The `insecure.requested` push still pops the box instantly
  (it nudges the query refetch), but if the admin WebSocket is disabled or down
  the 30 s polling refetch now opens the box on its own. Previously the WS event
  was the *only* trigger after first load, so a missed push left the operator
  reloading the page. For instant (vs. ≤30 s) popups, the admin WebSocket must
  be enabled — `docker-compose.yml` sets `ADMIN_WS_ENABLED=1` by default; the
  committed env default remains `false` for non-compose deploys, so set it
  explicitly there if you run the API directly.

## claude_artifacts table — run on deploy

The Platinum Claude Code work adds one new table. Apply it before serving
traffic. Prefer running this exact DDL directly (it only ever creates the new
table); if you use `pnpm --filter api drizzle:push`, inspect the proposed
statements first and abort if it wants to ALTER/DROP any existing table —
`push` reconciles the whole schema against the hand-maintained mirror, not just
the diff.

```sql
CREATE TABLE IF NOT EXISTS claude_artifacts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind VARCHAR(32) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  sha256 CHAR(64) NOT NULL,
  display_name VARCHAR(255) NULL,
  description TEXT NULL,
  model VARCHAR(128) NULL,
  frontmatter JSON NULL,
  body LONGTEXT NOT NULL,
  source_host_id BIGINT UNSIGNED NULL,
  created_at VARCHAR(100) NOT NULL,
  updated_at VARCHAR(100) NOT NULL,
  deleted_at VARCHAR(100) NULL,
  engine VARCHAR(16) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_claude_artifacts_kind_slug (kind, slug),
  KEY idx_claude_artifacts_kind (kind),
  KEY idx_claude_artifacts_updated_at (updated_at),
  KEY idx_claude_artifacts_engine (engine)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

## Joplin removal — run on deploy

The Joplin integration has been removed in full. Once the new code is deployed,
run the following SQL on MySQL (crane) to drop the cache table and clean every
`versions` row the integration owned:

```sql
DROP TABLE IF EXISTS joplin_notes_cache;
DELETE FROM versions
 WHERE name IN (
   'joplin_url',
   'joplin_email',
   'joplin_password',
   'joplin_enabled',
   'joplin_sync_interval_minutes',
   'joplin_verified_at',
   'joplin_verified_config_hash'
 )
    OR name LIKE 'joplin\_%' ESCAPE '\\';
```

The `LIKE` clause is a belt-and-braces cleanup for any straggler keys (clipper
tokens, sync cursors, etc.) the legacy code may have written into `versions`.

# 2026-05-29
- Platinum Claude Code support: the orchestrator now manages Claude Code's native, on-disk artifact surface across the fleet — features Codex has no analogue for.
  - New fleet collections — **subagents** (`~/.claude/agents/*.md`), **slash-commands** (`~/.claude/commands/*.md`), and **output-styles** (`~/.claude/output-styles/*.md`) — authored in the admin UI and synced to every Claude host. Stored in the new `claude_artifacts` table; bundled to Claude hosts via `/sync/bootstrap` as the complete live set (If-None-Match per item). The `clx` wrapper writes `<slug>.md` files and prunes only the files it wrote, never user-authored files in those directories.
  - `~/.claude/settings.json` is now **deep-merged** instead of overwritten: the server ships only the fleet-managed keys (`model`, `mcpServers`, `hooks`, `statusLine`, `permissions`, `env`) plus an `owned_paths` list, and the wrapper merges them while preserving every user-owned key. Retired fleet keys are removed cleanly; on an explicit trust refusal the wrapper strips fleet keys + collection files (never on a transient outage). This fixes a latent bug where syncing fleet config would erase a user's own `settings.json` entries.
  - Per-host Claude model override (`claude_model_override`) now actually reaches the rendered settings (previously dead on the render path); admins can persist Claude-engine settings via `/admin/claude/config`.
  - New admin endpoints `/admin/claude/:kind[/:slug]` and `/admin/claude/config[/render|/store]`; new host endpoints `/claude/:kind[/retrieve|/store]`.
- Wrapper doctor: `cdx doctor` and `clx doctor` now report the running wrapper build version instead of the stale baked config version, so a self-updated `/usr/local/bin/cdx` no longer appears stuck on an older wrapper in diagnostics.
- Wrapper cron update: `cdx --cron run` and `clx --cron run` now fall back to passwordless `sudo -n install` when replacing a root-owned wrapper binary, matching the normal startup self-update path.

# 2026-05-26
- Config sync: updated Codex reasoning-effort normalization to the current `minimal|low|medium|high` set and maps legacy `xhigh` profile/host values to `high`, so synced `config.toml` files no longer make Codex reject `[profiles.*].model_reasoning_effort`.
- Docker compose: pinned the internal `codex_auth` bridge to `172.30.250.0/24` (configurable via `CODEX_AUTH_SUBNET` / `CODEX_AUTH_GATEWAY`) so Docker cannot auto-select a subnet that overlaps private backup or monitoring routes on production hosts.

# 2026-05-24
- Wrapper v2 platform selection: `cdx` and `clx` now send `X-Wrapper-Platform` on orchestrator calls, and `/cron/check` plus signed config baking return the platform-specific wrapper binary URL and SHA256 instead of falling back to the default Linux amd64 artifact.

# 2026-05-22
- cdx wrapper: normal startup now applies managed wrapper self-updates without requiring a cron entry, using passwordless `sudo -n install` when the wrapper lives under root-owned `/usr/local/bin`, then re-execs the original command before checking the Codex CLI. The Codex `latest` target is resolved before download so already-current hosts do not reinstall on every launch.
- Wrapper v2 cron auto-update: `cdx` and `clx` cron ticks now bootstrap `/usr/local/bin` into `PATH` at runtime and in newly installed crontab entries, so sparse cron environments can still find `codex` / `claude` and apply upstream CLI updates instead of reporting `unknown`.
- cdx wrapper: ChatGPT quota rows now show the burn-rate estimate for the percent expected at reset, restoring the old renewal-time projection while keeping the 100% ETA warning when the current rate would cross the limit before reset.

# 2026-05-20
- Admin WebUI routing: browser navigations to colliding SPA/API URLs such as `/admin/hosts`, `/admin/projects`, project detail slugs, and `/admin/users` now receive the Svelte shell when they ask for HTML, while API clients still receive JSON with `Accept: application/json`.
- Admin API Keys: OpenAI key list and create responses now return the snake_case key fields expected by the Svelte admin page, fixing the endless loading/crash on `/admin/api-keys`.
- Admin command palette: `/` search results now visibly highlight the active row when moving selection with Arrow Down / Arrow Up.
- Admin runner status: `/admin/runner` now reads persisted runner telemetry from the `versions` table, so the dashboard shows `ok` and the latest check time instead of `idle` / `never` when boot health checks have already verified the runner.
- Admin WebSocket updates: new insecure-host approval requests now invalidate the dashboard pending-approvals query as well as the Hosts insecure dialog, so connected browsers update immediately on `insecure.requested` / approve / deny events instead of waiting for polling or reload.
- Admin dashboard: fixed the insecure-host **Review** button to route through the `/admin` SPA base and open the insecure approvals dialog instead of hitting the backend-only `/hosts` path and showing `not_found`.
- ChatGPT usage refresh: restored the Node backend's real `/wham/usage` fetch path so dashboard loads and the Refresh button can persist current quota snapshots instead of only replaying stale cached rows.
- Admin dashboard: restored ChatGPT usage rendering by returning the nested quota-window and history-series shape expected by the Svelte dashboard while keeping the flat snapshot fields for compatibility.
- BrowserOS MCP: added a per-host Host detail toggle that bakes `[mcp_servers.browseros]` with `http://127.0.0.1:9000/mcp` into Codex `config.toml` only for enabled hosts, surfaces a BrowserOS startup chip in `cdx`, and leaves the feature off fleet-wide by default.
- Admin runner verification: wired Node `/admin/runner/run` and `/admin/runner/run-claude` to the real runner client and latest engine-scoped canonical auth payloads, replacing the temporary `runner_not_wired` 503 shown by the dashboard's **Verify Claude** button.
- CoCo project feedback: accepted `issue` and `test` as first-class feedback types alongside `bug`, `feature`, and `note` across MCP, host project routes, admin project routes, docs, and the admin feedback UI.
- Admin passkey login: when exactly one active admin user exists and that user has a passkey, `/admin/login` now starts the WebAuthn prompt directly and hides username/password plus the extra authenticate button; multi-user and password-only installs keep the existing username-first flow.
- Admin passkey login: fixed WebAuthn authentication options for VARBINARY-stored credential IDs so Drizzle Buffers are converted back to base64url strings before passing them to SimpleWebAuthn; passkey login no longer fails with `input.replace is not a function`.
- Host config sync: restored Node-side per-host `config.toml` baking so `/config/retrieve` and `/sync/bootstrap` inject the managed `[mcp_servers.cdx]` HTTP MCP block, host Authorization header, host model overrides, and trusted project stanza instead of serving the raw stored template. MCP also advertises the documented `resource_*` tools, so clients that expose MCP as tools can call `resource_read` for `skill://{slug}` manifests.

# 2026-05-19
- Removed the Joplin integration in full: deleted the API services (`joplin-client`, `joplin-config`, `joplin-cache`, `joplin-skills`), the `/admin/joplin/*` admin routes, the `joplinNotesCache` Drizzle table + `joplin_notes_cache` MySQL table, the `joplin.synced` WS event, the `JOPLIN_URL` / `JOPLIN_TOKEN` env entries, the frontend integrations page + types + nav entry, the PHP `AdminJoplinController` / `JoplinService` / `JoplinCacheService` / `JoplinSkillService` / `JoplinNoteRepository` / `JoplinMigration`, the `joplin_*` MCP tools and PHP wiring, the runner `/joplin/summarize` and `/joplin/query` endpoints, and the matching manual / docs sections. See the `Joplin removal — run on deploy` block at the top of this file for the SQL the operator must run after deploy.
- Admin WebUI hosts: the "Installer minted" modal now auto-copies the freshly minted installer command to the clipboard, while keeping the manual Copy command fallback.
- Wrapper v2 installer: relic cleanup now checks whether `/usr/local/sbin/cdx` or other legacy paths resolve to the same file as `/usr/local/bin/cdx` before removing them, so systems with aliased standard directories no longer delete the freshly installed wrapper.
- Admin WebUI hosts: the "Installer minted" modal now has a Re-create action that mints a fresh installer link in-place, preserving the selected engine set from the original mint action.
- Wrapper v2 installer: hardened cleanup for legacy symlink layouts where `/usr/local/bin/cdx` pointed at `/usr/local/sbin/cdx`; canonical symlinks are now replaced with a real wrapper binary before relic cleanup removes the old target path.
- Wrapper v2 installer: after a canonical `/usr/local/bin` install, stale or duplicate wrapper relics in the installing user's `~/.local/bin` and `/usr/local/sbin` are now removed when possible, with explicit `sudo rm` remediation when they cannot be cleaned automatically.
- Wrapper v2 installer: system install is now the default. Fresh `cdx`/`clx` installs target `/usr/local/bin` and use passwordless sudo when required, avoiding one wrapper copy per user on shared hosts; per-user installs now require an explicit `BIN_DIR=...` override.
- Wrapper v2 installer: after installing the Go wrapper, the generated installer now warns when the current shell may still resolve or cache another `cdx`/`clx` binary, and prints the direct installed path so operators can bypass stale shell hashes.
- Wrapper v2 bootstrap: fixed `cdx`/`clx` startup bundle handling so `/sync/bootstrap` resource envelopes are unwrapped before writing `~/.codex/config.toml`, `~/.codex/AGENTS.md`, `~/.claude/settings.json`, or `CLAUDE.md`; new installs no longer poison config files with JSON response envelopes.
- Admin WebUI passkeys: fixed account passkey registration to submit the attestation under the backend's expected `{response: ...}` envelope, and hardened the Node passkey routes to normalize raw WebAuthn credentials from stale clients instead of misreading the nested `response.clientDataJSON`.
- Wrapper v2 cron auto-update: verified the live bootstrap/install/check/report/self-update path end-to-end and hardened Codex CLI version parsing so current upstream output like `codex-cli 0.130.0` is normalized to `0.130.0` before cron reports or server update decisions are made. `/cron/check` also normalizes labeled submitted versions before comparing them to the fleet target.
- Admin WebUI auth: fixed the SvelteKit passkey login path to submit the WebAuthn assertion JSON under the backend's expected `response` key instead of trying to POST a raw browser `PublicKeyCredential`. The Node passkey service again derives RP ID and origin from `PUBLIC_BASE_URL` or trusted request headers when `ADMIN_WEBAUTHN_*` is unset. Logged-out operators are now redirected back to `/admin/login`, and the admin websocket is only opened after a valid session, so a stale static shell no longer looks "online" while every admin API call is actually 401.
- Wrapper v2: published the current `cdx`/`clx` bakery as `0.6.2` and hardened the Codex installer test path so root test runs cannot overwrite a real `/usr/local/bin/codex`. The rebuilt `cdx` status screen again shows ChatGPT quota bars from the live `/auth` metadata, and manual `cdx --update` / `clx --update` now exits after the binary swap instead of re-execing into an update loop.
- Wrapper v2: closed the last legacy-parity gaps from the stub-removal plan. `cdx auth-upload` now backfills a UTC RFC3339 `last_refresh` into vanilla `codex login` payloads before POSTing so they pass the server's RFC3339 validation. `cdx <profile>` falls back to `--profile <name>` when `[profiles.<name>]` exists in the synced `~/.codex/config.toml` (matched against a reserved-name allowlist), and `cdx ls` is wired as a one-keystroke shorthand for `cdx lane spark`. The boot screen's "Concurrent" row now picks its text from the auth decision (`Using local auth.json.` vs `Local auth.json is missing or invalid.`); `cdx`/`clx` headless callers (`--skip-boot`, `--execute`) get the quota warning text on stderr instead of only inside the boot screen. Both engines probe `/skills` once per run (cdx: `?engine=codex` implicit by host config; clx: `?engine=claude` explicit), fingerprint the response, and light the boot-screen "skills" dot on change; legacy on-disk caches (`~/.agents/skills`, `~/.codex/skills`, `~/.codex/prompts` for cdx; `~/.agents/skills`, `~/.clx/skills`, `~/.claude/skills` for clx) are one-shot pruned per wrapper version so MCP resolution is no longer shadowed. `docs/interface-cdx.md`, `docs/interface-clx.md`, and `docs/wrapper-v2-gap-analysis.md` are updated to reflect the merged state.
- Admin WebUI: restored eight features that did not make the SvelteKit rewrite, in a single coordinated landing built across four parallel git worktrees.
  - Hosts — host detail page now exposes a **Seed auth** dialog (Upload tab posts `{engine, payload}` to `/admin/auth/upload`; One-time-command tab calls `/admin/auth/seed-command` and renders the returned bash with a copy button + TTL), a tri-state **Reverse DNS** segmented control (Inherit / Force on / Force off → `POST /admin/hosts/:id/reverse-dns`), an **Agents version** InputDialog → `POST /admin/hosts/:id/agents-version`, and an **Add Codex** / **Add Claude** outline button that fires when the host is missing the other engine. The hosts list header gains a global Seed-auth entry point with no host context.
  - Hosts — backend extension: `POST /admin/hosts/:id/installer` now accepts an optional `engines: ('codex'|'claude')[]` body; the service unions the requested engines with the host's current tuple, persists the new engines list, and mints an installer for the union. Six new tests (4 route + 2 service) cover the union, comma-separated parsing, unrecognised-engine filtering, and no-args back-compat.
  - Hosts — insecure-window enable / extend flows on both the detail page and the Active-Windows dialog now open a popover with a 0–480 min slider (default 10 min) before firing `createEnableInsecureMutation({duration_minutes})`. The dialog's per-host extend uses the same popover; the fleet-wide `extendAll` button is left unwrapped because the underlying route ignores `duration_minutes`.
  - Settings — new **Claude version** section mirroring the Codex version section, with a "Lock fleet to this version" SwitchRow wired to the existing `claudeVersionMutation`. TOC nav links to it. The previously inline "Claude wrapper version" subsection inside `ClaudeEngineSection` is removed to keep a single source of truth and avoid duplicate DOM ids.
  - Dashboard — new **Runner state** card displays current state, last-run timestamp, last error, last result, with **Run Codex runner** and **Verify Claude** buttons. Polls `/admin/runner` every 15 s; mutations invalidate on completion.
  - Account — new **Theme** page under `/admin/account/theme` with auto / light / dark options. Picks call mode-watcher's `setMode` immediately and POST `/admin/theme` for per-user server persistence. Pink theme variants are not restored.
  - Authoring — Memories page gains a host `Select` dropdown above the search box, threaded through `/admin/mcp/memories?host=` so memories can be filtered by host.
  - Bundle includes the rebuilt SvelteKit SPA artifact under `public/admin/`.

# 2026-05-18
- Wrapper v2 sync: fixed `cdx`/`clx` resource sync to send the documented `sha256` field and write only `/agents/retrieve` / `/config/retrieve` `content` bodies, not the surrounding JSON envelope, so synced `config.toml` / `AGENTS.md` files remain parseable. The wrappers also accept Node `/auth` retrieve `valid` / `unchanged` statuses without warning.
- Admin UI / installers: added a host-detail **Mint installer** action backed by `POST /admin/hosts/{id}/installer`, which issues a fresh existing-key installer URL without rotating the host API key; Node install routes now resolve hashed/encrypted installer tokens correctly.
- Wrapper v2 transition: restored `/wrapper/download` as a legacy shell transition launcher for date-versioned bash wrappers, while keeping `/wrapper/v2/download` as the raw Go binary endpoint; `/auth` and `/cron/check` now steer legacy wrappers to the transition launcher without a static checksum, and v2 installers write signed config before installing the binary.
- Legacy wrapper compatibility: restored the standard `data` envelope alongside root response fields so still-installed bash `cdx` wrappers can parse `/auth`, `/versions`, `/cron/check`, and related host API responses after the Node cutover.
- Ops / Node cutover: fixed the live Docker wiring for the rewritten API by loading the mounted env file, keeping the existing `mysql_data` volume path, waiting for the auth runner healthcheck, publishing runner/wrapper-v2 state during API boot, and serving the `/admin` SPA entrypoint cleanly for direct operator probes.
- Wrapper v2 / cdx bakery: fixed local release output so `cdx`/`clx` builds are served under the API's `codex`/`claude` paths with platform manifests, and embedded the active live signing public key in both wrappers.
- Auth sync: kept Node `/auth` compatible with legacy `sbox:v1` canonical payloads, allowed first-run retrieve without a local digest, and ensured new host/seed auth writes keep payloads and tokens encrypted.

# 2026-05-17
- Backend rewrite (BACKEND-redo, full): replaced the ~30k-line PHP backend with a typed Node 22 / Fastify 5 / Drizzle / TypeScript implementation under `api/`. HTTP API contract preserved verbatim — every endpoint keeps its URL, method, request body, response shape, headers, and error envelope (standard / OpenAI / Anthropic, auto-selected by URL prefix). MySQL schema preserved verbatim, read by Drizzle. `sbox:v1[:kid=…]:<b64>` envelopes decoded byte-for-byte by `libsodium-wrappers`. Password verify supports bcrypt + phpass + argon2id with transparent argon2 rehash on next login. Admin WebSocket is native (`/admin/ws` via `@fastify/websocket`) — no external WS process. Replaced `public/index.php` (1042-line router), every controller, every repository, the 1440-line `AuthService` (split into 7 focused services), and 17 PHP migrations (mirrored in Drizzle schema). Single deploy artifact: `node dist/server.js`. 496 passing vitest cases (unit + integration) across 11 worktree-built route trees: host-api, admin-auth-users, admin-hosts, admin-overview-settings, admin-content (skills/agents/memories/projects), projects-client + MCP JSON-RPC, OpenAI-compat (`/v1/*` + SSE streaming), Anthropic-compat (`/anthropic/v1/*` + SSE), Joplin + manual articles, wrapper v2 bridge + signed config. Contract suite scaffold ready for golden-fixture replay against the legacy PHP. Caddyfile + Dockerfile + docker-compose.yml + CI cut over to the Node service. PHP source under `src/` and `public/index.php` retained for one release as reference; the next release deletes them.

# 2026-05-16
- Admin WebUI rewrite: replaced the hand-rolled vanilla-JS SPA in `public/admin/` (14 JS modules, 5 CSS files, 6-theme matrix, multi-key chord shortcuts) with a typed, modular SvelteKit + Tailwind + shadcn-svelte SPA under `frontend/` that builds into `public/admin/`. Top-level IA collapsed to Dashboard / Hosts / Projects / API Keys / Authoring / Logs / Users / Integrations / Settings, with a Cmd-K command palette replacing the chord shortcuts and the four separate Hosts nav items folded into filter chips. PHP gateway (`public/admin/index.php`) simplified — mobile UA sniffing, HTML string-injection of account name, and the cache-bust `?v=YYYY-MM-DD` system are all gone. Themes reduced from 6 to System / Light / Dark.
- Wrapper bakery v2 plan: published `CDX-redo.md` at the repo root — a complete redo of the `cdx` / `clx` wrapper bakery (Go single static binary per engine, two fully separate modules, pre-bake on config change with filesystem cache, parallel build then atomic swap). Implementation is staged but not landed; the document is the orchestrator's master brief for the rewrite.

# 2026-05-11
- Claude auth seeding: accepted Claude Code OAuth credentials (`claudeAiOauth.accessToken`) everywhere Claude API-key credentials are accepted: seed scripts, `/auth` canonicalization, `clx auth-upload`, and runner validation. Runner probes now send OAuth tokens as `Authorization: Bearer`, and Anthropic `rate_limit_error` probe responses count as valid credentials with quota pressure instead of rejecting seed uploads.
- Admin UI / hosts: added a Quick VM flow that mints an insecure temporary throwaway host with an auto-generated `tmp-*` name and immediately copies a Codex, Claude, or dual-engine installer.
- Cost tracking removal: stripped API cost/pricing calculation, pricing snapshots, cost history, wrapper run-cost reporting, and Claude spend-limit UI/enforcement. Usage reporting is now token-only, and boot migrations drop the legacy pricing/cost tables and columns.
- Admin UI / dashboard: fixed the Hosts active card to count hosts with recent `last_refresh`, `updated_at`, or latest token usage within the last 24h instead of strictly "today".
- Admin UI / dashboard: made `Hosts active` compute from the latest available host timestamp (`last_cron_check`, `updated_at`, `last_refresh`, `created_at`, and token usage time) to avoid false-zero when one stale field is present.

# 2026-05-05
- `cdx` cron-managed updates: fixed `/cron/check` to return the host-baked wrapper checksum, matching `/wrapper/download`, so older cron jobs no longer fail wrapper self-update with `hash mismatch` and abort before Codex CLI updates.
- Admin UI / dashboard: tightened the warm dashboard shell with a lighter top rail, quieter alert strip, denser usage cards, and a deliberate Claude empty state. Cache-bumped `dashboard.css` to `v=2026-05-05-01`.
- Admin UI / login: replaced the mock Codex/Claude login bubbles with the real OpenAI and Claude logo pair, refreshed the Claude SVG asset, and cache-bumped `login.css` to `v=2026-05-05-01`.

# 2026-05-03
- Admin UI / settings: moved credential seeding and runner/version maintenance out of Settings → General. Codex seeding, Codex runner, and version checks now live on Settings → OpenAI; Claude seeding and Claude runner verification live on Settings → Claude. Cache-bumped `dashboard.js` to `v=2026-05-03-02`.
- Installer: Codex bootstrap scripts now check for the archive prerequisites `tar` and `gzip`, try to install missing packages via common Linux package managers, and fail early with a clear remediation message if the host cannot install them automatically.
- Admin UI / host detail: added explicit `Add Claude` / `Add Codex` actions for single-engine hosts. The action mints a combined installer with the expanded engine set so existing wrappers and the newly added engine share the freshly rotated host API key. Cache-bumped `dashboard.js` to `v=2026-05-03-01`.
- `cdx` cron-managed updates: normal wrapper launches now still repair a locally stale Codex CLI after installing/reconciling the managed cron job, so new cron-managed hosts do not keep showing Codex's own "update available" banner until the first scheduled cron run. Wrapper bumped to `2026.05.03-02`.
- Installer / `cdx` updates: fixed Linux Codex CLI downloads for current releases such as `0.128.0` by using the published `unknown-linux-musl` assets instead of selecting missing `unknown-linux-gnu` assets on newer glibc hosts. Wrapper bumped to `2026.05.03-01`.

# 2026-04-30
- `cdx` / `clx` wrappers: fixed version-token parsing on newer Bash/Fedora builds by making the hyphen literal in the status-summary regex. Wrapper bumped to `2026.04.30-01`.
- Wrapper metadata: fixed Claude wrapper version detection so the unbaked `__WRAPPER_VERSION__` placeholder falls back to an auto hash instead of leaking into `/versions`.

# 2026-04-29
- Admin UI redesign: "warm operator console" visual overhaul of the entire `/admin/*` interface. Replaced the cold navy/cyan palette with warm cream (Paper) and espresso (Ink) themes using terracotta and amber accents. Added Source Serif 4 as a self-hosted display serif for editorial headings. Dropped glassmorphism/backdrop-filter in favour of solid surfaces with 1px hairlines. Bumped corner radii (8→10px cards, 12→14px modals, 12→18px login). Simplified shadows to hairline-first. All six themes preserved (Auto, Light, Dark, Auto Pink, Bright Pink, Dark Pink). All CSS class names and variable names preserved. No JS changes, no framework additions, no build step.

# 2026-04-27
- Admin UI / users: fixed `/admin/settings/users` rendering blank by removing the Users settings subpanel from the top-level dashboard visibility toggle. Cache-bumped `dashboard.js` to `v=2026-04-27-02`.
- Codex defaults: made backend config normalization default `[features].fast_mode = true`, so older/sparse fleet settings render fast mode even when the admin UI has not re-saved the toggle.
- Codex defaults: enabled native Codex Memories by default in rendered `config.toml` via `[features].memories = true`, exposed the toggle in the admin config builder, and raised the Codex minimum/version fallback plus auth-runner baked CLI to `0.125.0` so the fleet target understands the setting. Cache-bumped `config.js` to `v=2026-04-27-01`.

# 2026-04-26
- `clx` cron auto-update: fixed parsing of `/cron/check` wrapper-update metadata so cron-managed Claude hosts actually install a required wrapper update before continuing, and made `/cron/report` include `engine=claude` so successful Claude CLI updates persist to the Claude version fields instead of the Codex fields.

# 2026-04-25
- Model support: added `gpt-5.5` to the Codex/OpenAI allowlist across backend validation, `/v1/models`, admin config/profile pickers, host override controls, and scaling model selectors. Fleet defaults remain on `gpt-5.4`; this change makes GPT-5.5 selectable without silently retuning existing hosts. Cache-bumped `dashboard.js` to `v=2026-04-25-02` and `config.js` / `profiles.js` to `v=2026-04-25-03`.
- Admin UI / scaling: fixed the default usage-scaling settings so the first downgrade step now shows `gpt-5.4-mini` with `high` effort instead of the stale `gpt-5.4` / `medium` pair left over from the earlier rollout. The scaling copy now reflects that the rule can step down both model and effort, and `dashboard.js` was cache-bumped to `v=2026-04-25-01`.
- Admin UI / config: hardened the OpenAI model pickers in `/admin/settings/config` and `/admin/settings/profiles` so they rebuild directly from the supported-model allowlist (`gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.2`) instead of trusting whatever options happen to already be in the DOM. Cache-bumped `config.js` and `profiles.js` to `v=2026-04-25-02`.

# 2026-04-24
- Runner preflight: fixed `RunnerVerifier` readiness probes to hit the runner’s GET-safe `/health` endpoint before posting to `/verify` / `/verify-claude`, and raised the background runner timeout to 12 seconds so cron/preflight checks no longer false-fail just because verification routes are POST-only or the Codex probe needs a cold-start.
- Claude lifecycle parity: fixed automatic pending-auth runner validation to use `/verify-claude`, surfaced Claude runner state from the Claude-specific version keys, persisted `engine=claude` for new CLX usage rows/ingests, and made runtime API keys strict per engine (`sk-codex-*` for OpenAI-compatible routes, `sk-claude-*` for Anthropic-compatible routes). CLX settings now render Claude-native `mcpServers.clx`, config sync creates `~/.claude` before mirroring `settings.json`, and the Claude installer now retries npm global install through sudo when needed.
- Codex defaults: moved the Codex CLI floor to `0.120.0`, so lower fleet pins, host overrides, installers, auth snapshots, and cron update checks force-upgrade to at least `0.120.0`. GPT-5.4 remains the default model and forced legacy model migrations now select `high` reasoning effort. The `cdx` SSH launch path no longer auto-injects the old pre-0.120 alt-screen workaround. Cache-bumped `config.js` and `profiles.js` to `v=2026-04-24-01`.

# 2026-04-20
- Claude workflow parity: seed commands are now engine-aware. Operators can mint Claude seed scripts from the dashboard, the token records remember `engine`, and generated scripts upload `~/.claude/.credentials.json` with the same runner-validated `/seed/auth/{uuid}` flow used for Codex.
- Claude auth canonicalization: server-side auth storage now accepts Claude credential shapes (`api_key`, `anthropic_api_key`, `ANTHROPIC_API_KEY`) and synthesizes the canonical `auths["api.anthropic.com"]` entry during runner validation and storage, matching Codex fallback behavior.
- `clx` wrapper: added `clx auth-upload`, canonical digest tracking, startup-bundle auth ingestion, and API-key extraction from server-returned `auths["api.anthropic.com"].token`, so post-install credential refreshes work analogously to `cdx auth-upload`.
- Admin Claude parity: hosts can now pin a Claude Code CLI version and a Claude model override from the host action panel; `/auth` host metadata returns `claude_client_version_override` alongside the existing Claude client/wrapper fields.

# 2026-04-19
- cdx wrapper: added `cdx auth-upload`, a wrapper-only command that normalizes a local `~/.codex/auth.json` from `codex login` when `last_refresh` is missing, uploads it through `/auth command=store`, and exits without launching Codex. Normal auth sync now performs the same safe normalization before deciding a local auth file is unusable. Wrapper bumped to `2026.04.19-02`.
- cdx wrapper: startup bundle sync now calls `/sync/bootstrap` when auth alone reports `missing` or `upload_required`, so a fresh local `~/.codex/auth.json` from `codex login` is uploaded to canonical storage even when AGENTS/config are already current. Wrapper bumped to `2026.04.19-01`.
- Auth runner: bumped the baked Codex CLI from `0.101.0` to `0.121.0` and made the verification probe use `RUNNER_CODEX_PROBE_MODEL` (default `gpt-5.4`) instead of the removed CLI default model, so runner validation no longer fails with `gpt-5.2-codex` unsupported errors.
- Runner recovery: failed runner probes now update `runner_last_check` and background preflight/recovery probes use a short timeout, preventing stale runner failures from making host startup sync wait until the wrapper reports `request_failed: The read operation timed out`.
- Seed auth command: generated `curl | bash` scripts now normalize plain Codex `auth.json` files by adding `last_refresh` when missing, avoid printing successful auth payloads back to the terminal, and show server validation JSON on HTTP failures. Seed tokens are now consumed after a successful store-level upload instead of before runner/auth validation, so retryable 422 failures no longer burn the one-time command.

# 2026-04-18
- cdx wrapper: shell-escape host-baked wrapper strings and quote the baked FQDN guard comparison so malformed host labels (for example an installer command pasted into the FQDN field) no longer make `/usr/local/bin/cdx` fail at parse time. Wrapper bumped to `2026.04.18-01`.

# 2026-04-14
- Claude parity pass — broad feature-parity push between `cdx`/Codex and `clx`/Claude across wrapper, backend, admin UI, runner docs, tests, and docs. Only intentional (engine-semantic) deltas remain.
  - Backend: added `POST /admin/runner/run-claude` + `AdminOverviewController::runnerRunClaude()` so the admin dashboard's "Claude Runner" button actually reaches a handler; the dashboard had been calling a 404 route. The new handler invokes `RunnerValidationService::triggerRunnerRefreshClaude()` which bypasses the Codex canonical-digest ladder and hits `RunnerVerifier::verifyClaude()` directly.
  - Backend: runner state is now engine-scoped (`runner_state_claude`, `runner_last_check_claude`, `runner_last_ok_claude`, `runner_last_fail_claude`). Previously a Claude runner failure would mark the global `runner_state=fail` and poison the Codex path.
  - Backend: `/v1/models` and `/anthropic/v1/models` now enforce per-key rate limits. `ClaudeApiController::embeddings()` now also rate-limits, matching the rest of the controller.
  - Backend: `OpenAiApiController` now takes an optional `VersionRepository` and calls `ensureApiEnabled()` on every handler, symmetric with `ClaudeApiController`.
  - Backend: `AdminOpenAiKeyController::index()` now returns only Codex keys (`listByEngine(Engine::CODEX)`) and its mutating helpers pass `Engine::CODEX`. Previously the "API Keys" admin page showed Claude keys mixed in with OpenAI keys.
  - Backend: `AuthController::syncStatus` / `syncBootstrap` now extract the `engine` from the request, pass it to `StartupSyncService::collect(...,$engine)`, and attach `chatgpt_usage` for Codex hosts / `claude_usage` for Claude hosts. `StartupSyncService` propagates the engine to `AgentsService::retrieve()` and `ClientConfigService::retrieve()` and now returns `filename` + `format` hints per phase.
  - Backend: `AdminOverviewController::authUpload()` accepts an `engine` field so Claude canonical payloads land in `canonical_payload_id_claude` instead of the Codex store.
  - Admin UI: consolidated the two duplicate `data-settings-panel="claude"` sections (DOM ID collision bug) into one authoritative panel. The "Claude API on/off" toggle now lives in the "API Keys" panel header next to the OpenAI toggle so operators manage both compat APIs in one place. The "API Keys" table now loads both engines, shows an Engine badge per row, and the "New key" modal asks the operator which engine to mint for.
  - Admin UI: deduplicated stray Claude nav links in the rail settings menu, the mobile tab bar, and the sidebar. Wired the previously-decorative `#seedEngineCodex` / `#seedEngineClaude` radios; the selected engine now rides along with `/admin/auth/upload`.
  - Admin UI: `/admin/settings/claude` was a 404 because the router regex didn't allow the `claude` section — fixed. Wired a `window.__initClaudeOnce` that loads settings from `/admin/claude/settings`, saves via `#claudeSettingsSaveBtn`, and updates `#claudeRunnerChip` after verification runs.
  - Admin UI: fixed `sk-coco-YOUR_KEY` → `sk-codex-YOUR_KEY` typos in the API reference docs/modal.
  - CLX wrapper: extracted `clx_auth_push()` into its own `02-auth-30-push.sh` fragment and added a dedicated `02-auth-20-validate.sh` fragment with `get_auth_last_refresh`, `is_last_refresh_recent`, and `validate_auth_json_file` (mirrors cdx). The validator understands Claude credential shapes — `api_key`, `anthropic_api_key`, and `auths["api.anthropic.com"].token`.
  - CLX wrapper: new optional `03-sync-40-startup-bundle.sh` fragment that atomically fetches auth + agents + config via `POST /sync/bootstrap`. Gated off by default (`CLX_USE_STARTUP_BUNDLE=1` to opt in) with a clean fallback to the three-call path on schema-mismatch / 404 / 5xx.
  - CLX wrapper: `clx --update` now verifies the downloaded wrapper against the server's `sha256` metadata before replacing the local binary, with a clear "Refusing to install unverified wrapper" error on mismatch. A depth guard (`CLAUDE_WRAPPER_RESTART_DEPTH`) aborts after 2 restarts in a single invocation to prevent update loops. `clx_update_cli()` now retries with sudo if the first `npm install -g @anthropic-ai/claude-code` fails.
  - CLX wrapper: `clx status` now reports wrapper source (seed vs storage), auto-update flag, startup-bundle state, auth freshness age, and fleet/runner state when available. The wrapper was rebuilt from 22 fragments (up from 19).
  - Runner: README now documents `/verify-claude`, per-engine request routing (`engine: "codex"|"claude"` field on skill/memory/project/joplin endpoints), `/health`'s dual-engine availability block, and the Dockerfile's inclusion of both CLIs.
  - Docs: new `docs/interface-clx.md` describing the clx CLI surface, sync contract, config bake placeholders, boot sequence, and intentional deltas (no lane, no reasoning_effort, no device-code login, npm-only CLI updates, native SSH handling).
  - Contracts: `docs/contracts/sync-bootstrap.schema.json` now accepts an `engine` discriminator.
  - Tests: added ClxWrapper* coverage (script dependency, update checksum, help passthrough, startup bundle, uninstall, cron, IPv4, usage upload, FQDN guard, no-reasoning-override regression, restart-loop guard) plus admin tests (AdminClaudeKeyControllerTest, AdminClaudePanelUiTest, AdminClaudeSettingsEndpointTest, AdminClaudeStateEndpointTest, AdminClaudeVersionEndpointTest, AdminRunnerRunClaudeRouteTest, AdminSeedEngineWiringTest, AdminOpenAiKeyEngineFilterTest, ApiModelsRateLimitTest, OpenAiApiControllerApiDisabledTest, AuthControllerSyncBootstrapClaudeTest, RunnerValidationServiceClaudeStateTest, StartupSyncServiceEngineTest). Full PHPUnit suite stays green at 1463 tests.

# 2026-04-13
- cdx wrapper: removed the interactive SSH Python PTY bridge again and returned SSH launches to direct Codex TTY ownership. This avoids stacked-PTY cursor/input drift on SSH hosts while keeping the old-version `--no-alt-screen` fallback, and the wrapper version bumped to `2026.04.13-01`.

# 2026-04-10
- Admin UI / host detail: the `Install` action on `/admin/hosts/{id}` now respects the actual host engine state instead of falling back to stale new-host modal state. Host-detail installer refreshes now stay correct for all three modes: Codex-only, Claude-only, and dual-engine hosts, and the action label now names the exact installer being minted.
- Installer: when `cdx` or `clx` already exists in a standard wrapper path, the host installer now overwrites that active path first instead of always preferring `/usr/local/bin`. This avoids same-shell upgrades continuing to hit an older cached wrapper path, and the installer now prints a `hash -r` hint when the shell may still have the old location cached.
- cdx wrapper: fixed sync-config precedence so freshly downloaded host-baked wrappers no longer get shadowed by stale `~/.config/cdx/credentials.env` entries from older `cdx login` runs or rotated host keys. Baked host API/base settings now win whenever present, CLI-login credentials remain fallback-only for unbaked wrappers, and the wrapper version bumped to `2026.04.10-01`.
- Migrations / ops: fixed the `host_auth_states` engine-scope migration so MySQL swaps the old primary key to `(host_id, engine)` in a single `ALTER TABLE` instead of dropping `PRIMARY` first. Existing installs no longer crash-loop the `api` container on boot with `Cannot drop index 'PRIMARY': needed in a foreign key constraint`.
- Host auth persistence: made host canonical-auth tracking fully Claude-compatible without breaking Codex fields. Hosts now keep parallel Claude sync fields (`claude_last_refresh`, `claude_auth_digest`, `claude_client_version`, `claude_wrapper_version`, `claude_model_override`, `claude_reasoning_effort_override`) alongside the existing Codex ones, `auth_payloads`/`host_auth_states`/`host_auth_digests` are now engine-scoped, and admin/auth host payloads now expose the Claude fields plus `engines` / `engines_list`. `POST /admin/hosts/{id}/clear` now clears both Codex and Claude auth linkage for the host.
- Host minter / installer: `POST /admin/hosts/register` now mints engine-aware installers instead of always emitting a Codex-only bootstrap. Codex-only hosts get `cdx`, Claude-only hosts get `clx`, and dual-engine hosts now receive one combined installer command that installs both wrappers and both CLIs in a single run. The installer response now includes `mode`/`label` metadata for admin UI and API callers.
- Auth runner: fixed the `claude` branch container rebuild by installing `xz-utils` in the runner image before extracting the Node.js `.tar.xz` payload used for the Claude Code CLI layer. `docker compose build` no longer fails with `tar (grandchild): xz: Cannot exec`.

# 2026-04-09
- OpenAI-compatible API: `POST /v1/chat/completions` and `POST /v1/responses` now preserve array-format content parts instead of coercing them to PHP `"Array"`. Text parts are normalized, and `image_url` / `input_image` parts now flow through the runner as real `codex exec --image` attachments for both remote `http(s)` URLs and base64 `data:` URLs. API/admin docs and runner docs were updated to match.
- Auth runner: fixed the Codex CLI invocation for multimodal runs so `exec` options (`-s`, `--skip-git-repo-check`, `--image`, `--model`) are passed before the prompt instead of after it, and moved the runner’s temporary Codex `$HOME` root out of `/tmp` into `/dev/shm` by default in the container (`RUNNER_HOME_PARENT=/dev/shm`), which is writable in the hardened runner image and no longer triggers Codex’s temp-home refusal during image requests.

# 2026-04-08
- Model support: removed the no-longer-supported `gpt-5.3-codex-spark`, `gpt-5.2-codex`, `gpt-5.1-codex-max`, and `gpt-5.1-codex-mini` entries from the shared allowlist, admin config/profile/host-override pickers, OpenAI-compatible `/v1/models`, and docs. The app now only advertises `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, and `gpt-5.2`, and removed models force-upgrade to `gpt-5.4`.
- Config/host migration: saved fleet configs, profile models, per-host overrides, and `versions.cdx_model` values that still reference removed models are now backfilled/normalized to `gpt-5.4` with `medium` reasoning effort on boot, so older stored selections stop leaking back into baked config or wrappers.
- cdx wrapper: Spark lane fallback now uses `gpt-5.4-mini` instead of the removed Spark Codex model, and the wrapper version bumped to `2026.04.08-01`. Cache-bumped `dashboard.css`, `dashboard.js`, `config.js`, and `profiles.js` to `v=2026-04-08-01`.

# 2026-04-07
- cdx wrapper: older Linux hosts now resolve a compatible Python 3 interpreter before the existing `python3` callsites run, so `python3.6`, `python36`, and `platform-python` layouts work without wrapper surgery. Normal startup prerequisite installs now also ensure Python 3, legacy YUM retries `python36` when `python3` is unavailable, the RFC3339 helpers no longer rely on `datetime.fromisoformat()`, and the wrapper version bumped to `2026.04.07-01`.

# 2026-04-06
- cdx wrapper: healthy non-concurrent boots now let the startup bundle carry auth metadata/refresh too when local `auth.json` is already valid, so secure hosts avoid the extra pre-run `/auth` round trip. Older/missing-auth paths still fall back to the standalone auth sync, startup health markers only show `updated` for real local changes, and the wrapper version bumped to `2026.04.06-01`.

# 2026-04-03
- Admin UI / Joplin: fixed Joplin Server note creation/update uploads to serialize sync items without a trailing newline. Joplin’s raw-item parser was treating that extra newline as the blank separator before the properties block, which made MCP note writes fail with `Missing required property: type_`.
- Admin UI / Joplin: fixed the first-enable Joplin Server import to stay within the server pagination bounds. Initial sync now pages `/api/items/root/children` with `limit=100` instead of `200`, which avoids the Joplin Server `HTTP 400: Limit out of bond: 200` failure during activation.
- Admin UI / Joplin: removed the clipper/Web Clipper auth flow again and made the integration Joplin Server only. Settings now save `URL + email + password`, `/admin/joplin/test` opens a real Joplin Server session, the backend clears stale clipper token/request state, and the sync layer now pulls notes/folders/tags from Joplin Server sync items instead of `/auth`, `/notes`, and `/notebooks`. Cache-bumped `dashboard.js` to `v=2026-04-03-05`.
- Admin UI / Joplin: fixed `/admin/settings/joplin` so the front controller serves the admin SPA shell for that settings page instead of falling through to the JSON `Route not found` handler.
- Admin UI / Joplin: simplified the visible setup flow so the main settings panel now shows URL + sync interval + `Request Access`, while manual token paste moved behind a `Manual token fallback` disclosure instead of sitting in the default happy path.
- Admin UI / Joplin: replaced the misleading generic “API token” setup with the proper Joplin Data API / Web Clipper access flow. Settings can now save the clipper URL, trigger Joplin’s approval handshake (`/auth` + `/auth/check`), store the approved access token server-side automatically, resume polling after reloads, and fall back to manual token paste when needed. Cache-bumped `dashboard.js` to `v=2026-04-03-04`.
- Admin UI / Joplin: enabling the module after a successful connection test now runs an immediate full import of all notes plus the current notebook list, and the dashboard reports that initial sync summary (`notes`, `folders`, `errors`) instead of a vague enabled-only state. Manual `Sync now` uses the same full import path. Cache-bumped `dashboard.js` to `v=2026-04-03-03`.
- Admin UI / Joplin: cache-bumped `dashboard.js` to `v=2026-04-03-02` so browsers stop reusing stale admin bundles against the newer settings HTML and activation flow. Without the fresh JS, the Joplin controls could sit on their default `Loading…` state and never bind the config loader or save/test/enable state machine.
- Admin UI / Joplin: activation is now a real save/test/enable flow. The dashboard keeps enable/sync disabled until the saved config is complete and `/admin/joplin/test` succeeds, the backend rejects `enabled=true` unless the current saved URL+token were already verified, and changing saved connection credentials clears verification and auto-disables the module until the saved config is tested again.
- Ops/Joplin cache migration: removed the invalid default from `joplin_notes_cache.body` so MySQL 8 can complete boot-time schema migration again. This fixes the API container crash loop (`BLOB, TEXT, GEOMETRY or JSON column ... can't have a default value`) and lets the rest of the stack come up normally.
- Ops/runtime checks: fixed the quota refresh cron bootstrap to pass `AuthService` dependencies in the correct order again, and corrected the API container healthcheck so a failed `/versions` probe returns a real non-zero exit code instead of PHP helpfully printing `1` and claiming everything is fine.

# 2026-04-02
- cdx wrapper: `cdx --update` now finishes the Codex update path too instead of exiting after a wrapper-only refresh. When the wrapper has to replace itself first, it re-execs once back into `--update`, skips the second forced wrapper reinstall, and now exits cleanly when both wrapper and Codex are already current. Wrapper bumped to `2026.04.02-03`; docs/tests updated.
- cdx wrapper: startup bundle sync now falls back to legacy `POST /agents/retrieve` + `POST /config/retrieve` only when `/sync/status` or `/sync/bootstrap` are genuinely missing on an older server. Slow or failed bundle requests no longer fan out into two more 20-second startup sync calls, so a degraded server no longer turns a normal non-concurrent `cdx` launch into a long triple-wait. Wrapper bumped to `2026.04.02-02`, and the wrapper/startup-sync docs/tests now pin the endpoint-missing-only fallback behavior.
- cdx wrapper: interactive SSH launches now use a Python PTY bridge again. The bridge strips Codex keyboard-protocol noise, normalizes Enter/Ctrl input, and answers cursor-position-report probes (`ESC[6n]`) with a synthetic response so plain SSH sessions stop freezing immediately after the wrapper banner. That hang could leave a live run lock behind, causing later `cdx` invocations to drop into concurrent/read-only mode and skip auth/config/wrapper refreshes until the wedged session exited. Wrapper bumped to `2026.04.02-01`, docs refreshed, and the SSH wrapper regression test now asserts the bridge/CPR path.

# 2026-03-31
- Admin UI / runner / projects: project workspace pages now offer runner-backed draft actions for weak or empty project metadata. `/admin/projects/{slug}` can ask the runner to infer better `title`, `name`, `description`, and an optional roster draft from the current shared project snapshot, shows changed-field badges before save, and keeps the flow draft-only until the operator explicitly saves About or Roster. Added `POST /admin/projects/{slug}/assist`, runner `/projects/assist`, updated the API/overview/runner docs, and cache-bumped `projects.js` to `v=2026-03-31-02`.
- Dev tooling: refreshed `scripts/export_ai_bundle.sh` to match the newer repo-bundle exporter style. The exporter still emits `app`, `wrapper`, and `runner` bundles, but now uses component scope plus extension-based filtering, includes the current canonical docs set, excludes non-canonical prose/binary noise more aggressively, and keeps the output/cleanup format aligned with the newer `benny` bundle script.
- Admin UI / AGENTS workspace: rebuilt Settings -> Agents from scratch into a two-tab workspace. `AGENTS.md` now renders as plain text until clicked, swaps into inline editing only on demand, shows a single `Save` button only when there are unsaved changes, and drops the old cancel/publish/retention controls. The new `Backups` tab keeps only restore/delete actions, auto-moves pinned hosts back to `Global` before deleting a pinned backup, and cache-bumps `dashboard.css` plus `dashboard.js` to `v=2026-03-31-06`.
- Admin UI / AGENTS editor: fixed a false-dirty state caused by editor text normalization. The inline editor now compares normalized line endings, resets its textarea from normalized canonical content, and cache-bumps `dashboard.js` to `v=2026-03-31-05` so the AGENTS tab no longer reopens with bogus unsaved changes while the server reports `No changes to save`.
- Admin UI / AGENTS editor: fixed the AGENTS settings tab sometimes reopening in a stale inline-edit/dirty state even when nothing had changed. The yellow banner is now informational only, `Cancel` discards inline edits immediately, and routing/render refreshes normalize the editor back to preview mode whenever there are no real unsaved changes. Cache-bumped `dashboard.js` to `v=2026-03-31-04`.
- Admin UI / AGENTS bootstrap: fixed Canonical AGENTS.md saves/publishes getting silently overwritten by the checked-in repo `AGENTS.md` on later requests. Repo seeding is now bootstrap-only when canonical AGENTS storage is empty, so admin-managed versions remain authoritative once created.
- Admin UI / AGENTS editor: after a successful save the yellow AGENTS banner now disappears instead of lingering as a pseudo-draft notice. That banner is now reserved for genuinely unsaved editor changes, its action saves the current draft, and `Publish latest` is temporarily disabled while the editor is dirty. Cache-bumped `dashboard.js` to `v=2026-03-31-03`.
- AGENTS backups: canonical AGENTS.md history can now keep only the newest configured number of historical backups instead of growing forever. Settings -> Agents now exposes a `Save retention` control (`0` = unlimited), AGENTS saves/reverts/boot seeding can prune old unprotected history automatically, and currently served or host-pinned versions are never auto-deleted even when they temporarily exceed the cap. Added `POST /admin/agents/retention`, surfaced `backup_limit` in `GET /admin/agents`, and cache-bumped `dashboard.css` to `v=2026-03-31-03` plus `dashboard.js` to `v=2026-03-31-02`.
- Admin UI / runner / skills: moved fleet skill editing out of the modal and onto dedicated `/admin/skills/new` and `/admin/skills/{slug}` workspace pages. Settings -> Skills remains the registry, but `New`/`Open` now route into a full-page editor with session-only AI conversation, per-field unlock controls for AI-managed fields, changed-field badges, and a new admin/runner conversational refinement path (`POST /admin/skills/assist` backed by runner `/skills/assist`). Existing skill slugs stay locked on edit, saves still persist only through `POST /admin/skills/store`, and the admin shell cache was bumped to `dashboard.css?v=2026-03-31-01` and `dashboard.js?v=2026-03-31-01`.
- Admin UI / memories: fixed memory deletion from Settings -> Memories so the WebUI now issues an actual `DELETE` request to `/admin/mcp/memories/{id}` instead of a stray `GET` that hit the router's 404 path.

# 2026-03-30
- Runner/auth canonicalization: admin `/admin/auth/upload` and seed `/seed/auth/{uuid}` uploads now use the same runner-validation/update path as host `/auth` stores, so runner `updated_auth` can become canonical from any upload path and runner failures now block all canonical-auth-changing uploads consistently. Runner-backed skill summaries, memory summaries, and skill draft generation now resolve auth from the validated canonical payload pointer instead of decoding whichever auth row happened to be newest, and system-owned canonical auth (`source_host_id = NULL`) is now accepted for runner refresh/consumer flows without requiring a credited host id.
- cdx wrapper: fixed `Argument list too long` crashes on large usage uploads by moving usage JSON handoff from Python argv to temp-file reads in the usage post/summary/fallback helpers. This keeps end-of-run usage push stable even when logs produce very large `usages` payload arrays. Wrapper bumped to `2026.03.30-08`.
- Admin UI / scaling: the usage-scaling toggle now persists immediately instead of only flipping local UI state. The default non-Spark downgrade chain is now compressed into the `80%` to `100%` band: `gpt-5.4 high` -> `gpt-5.4 medium` -> `gpt-5.3-codex high` -> `gpt-5.3-codex medium`. The scaling editor no longer offers `gpt-5.3-codex-spark` as a target model, backend validation rejects Spark if someone tries to POST it anyway, and the `versions.version` column now migrates to `LONGTEXT` so multi-tier scaling rules actually fit in storage. Cache-bumped `dashboard.js` to `v=2026-03-30-26`.
- Admin UI: audited the async settings toggles so they no longer boot with misleading hardcoded `Disabled` copy before live state arrives. `Usage Scaling`, reverse DNS, insecure approval, auto-update, log retention, and projects now start neutral with `Loading…`, and the settings renderer uses one shared binary-state helper for consistent labels/badges. `Usage Scaling` now also seeds a default 80%/`medium` tier on first enable so the toggle cannot fall into a half-enabled, unsaveable state. Cache-bumped `dashboard.js` to `v=2026-03-30-24`.
- cdx wrapper: tightened the boot-banner alignment so the `codex orchestrator` text block hugs the ASCII logo instead of floating far to the right on wide terminals. The wrapper now measures the logo width dynamically and uses a smaller inter-column gap. Wrapper bumped to `2026.03.30-07`.
- cdx wrapper: shortened the overlong quota-limit warning copy so warn-mode launches stop printing the same quota reason twice. Daily partition warnings now use tighter `daily budget` wording, and the second line is reduced to `Quota warn mode; continuing.`. Wrapper bumped to `2026.03.30-06`.
- Admin UI: removed the outer `Usage` wrapper card around the dashboard quota lanes. The `Normal` and `Spark` lane boxes now render directly without the extra parent box, and each lane card was scaled up with more padding and spacing. Cache-bumped `dashboard.css` to `v=2026-03-30-16` and `dashboard.js` to `v=2026-03-30-23`.
- Admin UI: the fixed dashboard footer no longer treats the `today` host count as "created today". It now counts hosts active on the current day from host activity timestamps (`last_seen`, then `last_refresh`, then `updated_at`) and labels the metric as `active today`. Cache-bumped `dashboard.js` to `v=2026-03-30-22`.
- Admin UI: removed the extra `Quota cockpit` heading block from the dashboard usage card, including the `Two lanes. Two stacked bars each.` and active-lane intro copy. The quota cards now start directly with the `Normal` and `Spark` lane boxes. Cache-bumped `dashboard.js` to `v=2026-03-30-21`.
- Admin UI: removed the extra quota-header pills above the dashboard quota bars. `Active lane`, snapshot freshness, next pull timing, and Spark model/feature tags no longer sit above the bars, so the cockpit stays focused on the two lane cards and their stacked 5-hour/weekly runways. Cache-bumped `dashboard.js` to `v=2026-03-30-20`.
- Admin UI: the `Host Ready to Join` success state in the `New Host` modal now includes a `Delete Accident` action for just-created hosts, so a mistaken registration can be removed immediately without leaving the modal. Cache-bumped `dashboard.js` to `v=2026-03-30-19`.
- Admin UI: the `New Host` modal now submits on Enter, flips into a proper success state after creation, shows the installer `curl` in a dedicated follow-up view, and auto-copies that command to the clipboard with a visible retry fallback when clipboard access is blocked. Cache-bumped `dashboard.css` to `v=2026-03-30-15` and `dashboard.js` to `v=2026-03-30-18`.
- Admin UI: added `Auto Pink`, a pink theme mode that follows the same day/night cycle as normal `Auto`. The dashboard now stores `auto-pink` as a first-class preference, resolves it to `Bright Pink` by day and `Dark Pink` by night in the browser, and mirrors that preference server-side so `cdx` still renders its banner pink. Wrapper bumped to `2026.03.30-05`; cache-bumped `theme.css` to `v=2026-03-30-02`, `dashboard.css` to `v=2026-03-30-14`, `dashboard.js` to `v=2026-03-30-17`, `login.js` to `v=2026-03-30-02`, and `cli-auth-verify.js` to `v=2026-03-30-02`.
- Admin UI: reshaped the dashboard quota cockpit into lane-first cards. `Normal` and `Spark` now each get their own info box, and each box stacks the `5-hour` bar directly above the `weekly` bar so both windows for that lane read together at a glance. Cache-bumped `dashboard.css` to `v=2026-03-30-13` and `dashboard.js` to `v=2026-03-30-16`.
- Admin UI: pressing `/` on the dashboard now opens a fast host-jump modal instead of trying to behave like the hosts table filter. The overlay searches the already-loaded fleet by hostname, id, version, or status and jumps straight into the selected host detail page on Enter or click. Cache-bumped `dashboard.css` to `v=2026-03-30-12` and `dashboard.js` to `v=2026-03-30-15`.
- Admin UI: collapsed the oversized empty gutter between the dashboard graphs and the fixed footer. The dashboard now reserves footer clearance once instead of stacking bottom padding on `.app`, `main`, and `.content`, which keeps the charts visually tight to the footer without overlap. Cache-bumped `dashboard.css` to `v=2026-03-30-11`.
- cdx wrapper: when the saved admin theme is `Bright Pink` or `Dark Pink`, the wrapper now renders the ASCII boot banner in pink instead of the default orange. The dashboard mirrors theme changes into the server version store so the next host auth pull can carry that preference into `cdx`. Wrapper bumped to `2026.03.30-04`.
- Admin UI: redesigned the `New Host` modal with friendlier copy, `Hostname` wording instead of `FQDN`, a two-by-two option matrix for `Secure`, `Temporary`, `Insecure Curl`, and `VIP`, plus a more playful `Mint Installer` call-to-action. Cache-bumped `dashboard.css` to `v=2026-03-30-10` and `dashboard.js` to `v=2026-03-30-14`.
- Admin UI: pressing `[h][n]` for `Hosts -> New Host` now closes the open rail menu and lands keyboard focus directly in the FQDN field instead of leaving the menu open. The same clean handoff now applies when opening `New Host` from the rail button. Cache-bumped `dashboard.js` to `v=2026-03-30-13`.
- Admin UI: the main dashboard quota card now merges the 5-hour and weekly bars into one polished “quota cockpit” instead of two flat mini-boxes. Sprint and weekly runway now live in one richer card with active-lane context, standby-lane compare chips, and cleaner hierarchy for GPT-5.4 quota status at a glance. Cache-bumped `dashboard.css` to `v=2026-03-30-09` and `dashboard.js` to `v=2026-03-30-12`.
- Admin usage retention: dashboard quota/cost charts now read from set-aside graph-history tables instead of depending on verbose raw usage logs staying around forever. New usage/quota writes update the chart store immediately, existing history backfills once on boot or on first chart read, and Settings -> General now exposes a fourth log-retention slider for `Set-aside Graph Stats`. The fixed dashboard footer was also simplified into one inline host/version/spend sentence instead of two split cards. Cache-bumped `dashboard.css` to `v=2026-03-30-08` and `dashboard.js` to `v=2026-03-30-11`.
- Admin UI: initial `/admin/hosts/{id}` loads now render from a slim single-host detail payload instead of blocking on the full dashboard bootstrap. The host detail page paints first, then hydrates slower runner/AGENTS metadata over the admin websocket when available, with HTTP fallback when live updates are disabled. Websocket refreshes on that page still patch the active host via the dedicated detail endpoint. Cache-bumped `dashboard.js` to `v=2026-03-30-09` and `admin-ws.js` to `v=2026-03-30-01`.
- Admin UI: removed the `Insecure Window` column from `Hosts > Secure` so the secure-host list no longer wastes a column on a control that is never applicable there. The all-hosts and insecure-host views still keep the inline window toggle. Cache-bumped `dashboard.js` to `v=2026-03-30-07`.
- Branding: the admin dashboard logo and the human-facing `cdx` wrapper headers now carry the tagline `Codex to Brrr!`. The dashboard rail brand is now a two-line lockup, and the wrapper boot/pending-approval headers show the same tagline. Wrapper bumped to `2026.03.30-03`; cache-bumped `dashboard.css` to `v=2026-03-30-07`.
- Admin UI: added two new manual theme presets, `Bright Pink` and `Dark Pink`, across the admin dashboard, login, and approval pages. The new modes persist via the existing `adminTheme` preference and ship with fresh shared/admin token palettes instead of recoloring only a few accents. Cache-bumped `theme.css` to `v=2026-03-30-01`, `dashboard.css` to `v=2026-03-30-06`, and `dashboard.js` to `v=2026-03-30-06`.
- Admin UI: dashboard quota and spend graphs now live-update from admin websocket events without page reloads or chart-shell flicker. Live `token.usage`, `chatgpt.usage`, and pricing events now patch the existing Chart.js instances in place instead of tearing them down and recreating them. Cache-bumped `dashboard.js` to `v=2026-03-30-05`.
- Admin UI: the dashboard now uses a fixed footer rail for Fleet and Spend summary data instead of two separate cards under usage. The footer stays pinned like the top rail, includes the live spend trend action, and the duplicate Fleet/Spend boxes were removed from the main dashboard column. Cache-bumped `dashboard.css` and `dashboard.js` to `v=2026-03-30-04`.
- cdx wrapper: fixed the self-update restart path so `cdx` no longer prints a second status/header block after `Wrapper updated; restarting cdx to load the new wrapper.` The re-exec now suppresses the boot screen entirely, leaving a single clean header before Codex starts. Wrapper bumped to `2026.03.30-02`.
- Admin UI: fixed the remaining top-rail hover wobble for `Overview`, `Hosts`, `Logs`, `Settings`, and the username/account trigger. The 2026 nav rail now explicitly opts out of the legacy global button hover `translateY(-1px)` motion so those labels stay pixel-stable while hovered. Cache-bumped `dashboard.css` to `v=2026-03-30-03`.
- OpenAI-compatible API: `/v1/models` now advertises the real shared Codex-supported model list instead of a fake `cdx-lm-1` stub, `POST /v1/chat/completions` / `/v1/responses` / `/v1/completions` now strictly validate `model`, omitted models now resolve from the saved main config with `versions.cdx_model` as fallback, and the selected model is passed through to the runner so `codex exec` actually runs with that model. Admin API reference copy, runner docs, and API interface docs were updated to match. Cache-bumped `dashboard.js` to `v=2026-03-30-03`.
- OpenAI-compatible API: added a minimal `POST /v1/responses` compatibility adapter for non-streaming official SDK clients, and fixed `POST /v1/chat/completions` streaming to emit SDK-compatible `chat.completion.chunk` SSE payloads with `choices[].delta.content` instead of a single full completion object. Admin API reference copy and interface docs now describe the new endpoint and current streaming limits.
- Admin UI: removed the springy zoom/wobble hover animation from the main top navigation rail. Hovering primary nav items now changes color and underline state without the old `scaleX()` motion. Cache-bumped `dashboard.css` to `v=2026-03-30-02`.
- cdx wrapper: the boot-screen component markers now switch from the normal dot/star to an up-arrow marker when that component actually changed during the run. Auth refreshes, MCP config updates, and skill cleanup events are now easier to spot at a glance in the human-facing `api/auth/skills/mcp/runner` status row. Wrapper bumped to `2026.03.30-01`.
- AGENTS/sync diagnostics: host-facing `/agents/retrieve`, `/sync/status`, and `/sync/bootstrap` now expose host-specific AGENTS section metadata (`base_sha256`, optional `managed_sha256`, and per-section presence/count/reason details for Skills and Memories). This makes it possible to tell whether a client should update because of the managed tail and why a Memories block is absent (`mcp_disabled`, `host_missing`, `no_memories`, etc.) instead of guessing from the rendered file alone.
- MCP/AGENTS: served host AGENTS now try to backfill missing MCP memory summaries on demand during `/agents/retrieve` instead of silently dropping those memories from the managed `## Memories` block. When the runner still cannot produce a summary, the memory remains visible with generic fallback copy so deployed AGENTS no longer look empty just because `mcp_memories.summary` is null.
- MCP/AGENTS: host-scoped MCP memories can now store a short runner-generated `summary`, and served `POST /agents/retrieve` output may append a managed `## Memories` inventory block alongside the existing Skills block when MCP is enabled for that host. Memory summaries are derived from canonical auth through the runner’s new `/memories/summarize` endpoint, are stored in `mcp_memories.summary`, and now survive unchanged memory rewrites instead of being cleared on no-op updates.

# 2026-03-29
- Admin UI/API: fixed `Settings -> API Keys` failing with HTTP 500 on older instances whose existing `openai_api_keys` table predated the `use_count` column. `OpenaiApiMigration` now backfills the current OpenAI API-key schema in place on `scripts/migrate.php` / container restart, so upgrades heal production tables instead of only defining the right shape for fresh installs.

# 2026-03-28
- Admin UI/runner: Skills now support runner-backed draft generation from a free-text prompt inside the existing New Skill modal. The new admin-only `POST /admin/skills/generate` flow uses canonical auth plus the runner’s new `/skills/generate` endpoint to draft `slug`, metadata, and the three SKILL.md sections into the editor, but nothing is persisted until the operator clicks Save. Runner failures now surface back into the modal without auto-saving or dropping in a generic template. Cache-bumped `dashboard.js` to `v=2026-03-28-01`.
- cdx wrapper: weekly quota rows now replace the old `proj 100% at reset` wording with a clearer parenthetical estimate like `(hits 100 in ~2d 4h, before reset)` when the existing projection model expects the weekly quota to reach 100% before reset. Wrapper bumped to `2026.03.28-01`.
- Skills/AGENTS: served `POST /agents/retrieve` and startup-sync AGENTS content can now append a managed `## Skills` inventory block when canonical config enables the managed MCP server and at least one skill exists. The block is derived at serve time, so skill additions/summary changes invalidate the served AGENTS hash without rewriting canonical AGENTS history or per-host AGENTS pins.
- Skills/runner: skill create/update flows can now ask the auth runner to generate a short description from `SKILL.md` when no explicit description was supplied. Generated summaries are stored in `skills.description`, runner failures do not fail skill saves, and the runner gained a dedicated `/skills/summarize` Codex endpoint alongside `/verify`.
- Docs/tests: refreshed the API/CDX/DB/overview/runner interface docs to describe dynamic served AGENTS skill inventories and runner-backed skill summaries, and added regression coverage for runner summary payloads, skill summary persistence/fallbacks, and effective AGENTS hash/content rendering.

# 2026-03-27
- Admin UI: AGENTS.md editor visual overhaul — preview and view-modal now use the defined `.agents-preview` dark theme instead of the undefined `.code-block` class, textarea editor matches the dark theme with a blue caret and focus ring, status messages get color-coded backgrounds (green/yellow/red), empty state uses the standard `empty-state-box` pattern, serve row has a card-like background, version table separates status pills from action buttons, and the view modal shows a skeleton loading sheen while loading. Both save and delete operations now guard against double-clicks. Cancelling the editor with unsaved changes prompts for confirmation. Cache-bumped `dashboard.css` to `v=2026-03-27-03` and `dashboard.js` to `v=2026-03-27-05`.
- Admin UI/API: fixed AGENTS.md saves that could look lost while the fleet was pinned and could fan out duplicate identical versions under overlapping save requests. The dashboard now blocks duplicate inline submits and explains when a save produced a new latest draft that is not yet being served; backend AGENTS stores now serialize/dedupe identical writes instead of creating piles of same-SHA history rows. Cache-bumped `dashboard.js` to `v=2026-03-27-04`.
- Admin UI: the `t` shortcut now treats the insecure-hosts quick-action modal as a real toggle target, so pressing `t` can open or close the `Active windows` view instead of incorrectly toasting `No toggle control is active in this view.` Cache-bumped `dashboard.js` to `v=2026-03-27-03`.
- Custom prompts: removed the slash-command/custom-prompt system end-to-end. The API/admin routes are gone, startup sync now carries only AGENTS.md + config, current wrappers prune legacy local prompt directories/baselines instead of syncing or pushing them, and the content migration now drops the obsolete `slash_commands` table on boot/manual migrate. Wrapper bumped to `2026.03.27-15`.
- Admin UI: pressing the same nav prefix hotkey twice now closes the already-open rail menu instead of only opening it and leaving the prefix armed. `h`, `l`, and `s` now behave as clean toggles from the keyboard.
- cdx wrapper: macOS and other hosts without `flock` now use a portable atomic `mkdir` lock for both the normal concurrent-run guard and cron auto-update runs, instead of warning that locking is disabled. Wrapper bumped to `2026.03.27-14`.
- cdx wrapper: preserve the full ASCII boot banner after a wrapper self-update restart instead of suppressing it via `CODEX_SKIP_MOTD`. Updated wrappers now restart into the normal boot screen before Codex launches. Wrapper bumped to `2026.03.27-13`.
- cdx wrapper: print a blank line between the boot/quota summary and the Codex UI launch so interactive starts do not jam the first Codex frame directly against the wrapper output. Wrapper bumped to `2026.03.27-12`.
- cdx wrapper: fixed an interactive launch regression that could make `cdx` exit right after printing the quota summary when the final Spark `⚡︎ weekly` row needed no extra label padding. `pad_visible_text_right()` now returns success on the no-op path, so the command substitution used by the boot screen no longer trips `set -e` before Codex starts. Wrapper should be rebuilt after fragment edits.
- cdx wrapper: interactive SSH launches stop forcing `--no-alt-screen` by default on Codex `0.117.0+`. Older builds keep the legacy workaround, but current Codex now stays on normal fullscreen alt-screen unless `CODEX_SSH_ALT_SCREEN=1` explicitly re-enables the old inline mode. Wrapper bumped to `2026.03.27-11`.
- cdx wrapper: quota label width now treats the Spark `⚡︎` marker as double-width for terminal padding, so the Spark 5h/weekly bars line up with the normal-lane rows on terminals that still render the lightning glyph wide. Wrapper bumped to `2026.03.27-10`.
- cdx wrapper: hardened `cdx --update` into an always-recover path. The explicit update mode now checks only for `curl` before wrapper self-update, so stale wrappers can replace themselves even if optional Bubblewrap setup or other package prerequisites are broken locally. Wrapper bumped to `2026.03.27-09`.
- cdx wrapper: Bubblewrap prerequisite handling is now best-effort only. Linux hosts still auto-install `curl`/`unzip`, but a failed `bwrap`/`bubblewrap` package install now logs a warning and launch continues so Codex can use its vendored fallback instead of aborting startup. Wrapper bumped to `2026.03.27-08`.
- cdx wrapper: corrected Bubblewrap prerequisite mapping for `apt-get`, `dnf`, and `yum` so the missing `bwrap` command now installs the actual `bubblewrap` package across Debian/Ubuntu and RHEL-family hosts. Wrapper bumped to `2026.03.27-07`.
- cdx wrapper: fixed Debian/Ubuntu Bubblewrap prerequisite installs by mapping the missing `bwrap` command to the actual `bubblewrap` apt package name. Wrapper bumped to `2026.03.27-06`.
- cdx wrapper: Linux prerequisite auto-install now also ensures system `bwrap`/Bubblewrap is present before launch/update work, so hosts stop falling back to Codex’s vendored bubblewrap with the repeated warning banner. Wrapper bumped to `2026.03.27-05`.
- cdx wrapper: quota summary rows now pad the left label column by visible terminal width instead of raw character count, so `5h` / `weekly` bars stay aligned even when Spark rows include the `⚡︎` marker. Wrapper bumped to `2026.03.27-04`.
- cdx wrapper: switched the Spark quota marker from emoji-style `⚡` to text-style `⚡︎` in the boot summary so terminals that render the symbol double-width no longer knock the 5h/weekly quota bars out of alignment. Wrapper bumped to `2026.03.27-03`.
- Repo: removed the root-level autonomous `spawner.py` helper and its dedicated Python test/CI job, so the repository no longer ships or exercises that maintainer-only workflow. Root cleanup now also ignores generated `.phpunit.cache/` and `storage/phpstan/` artifacts so local test/static-analysis runs stop leaving untracked noise behind.
- Admin UI: self-hosted Google Inter now replaces the previous sans/display fonts across the admin login page, dashboard, and shared admin error shell, while monospace UI stays on `JetBrains Mono`. Cache-bumped `theme.css`, `dashboard.css`, `dashboard-mobile.css`, and `login.css` to `v=2026-03-27-02`.
- cdx wrapper: insecure-host approval waits now render as a single framed status box instead of repeated warning lines; the box refreshes in place every 5 seconds with `last check` and `checks` while the host is waiting for an admin to click `Enable window`. Wrapper bumped to `2026.03.27-02`.
- cdx wrapper: empty runs no longer print the post-run `Run summary` footer when no token usage was captured, so insecure-host cleanup can finish without the noisy `Run usage | no token usage captured` / unavailable-cost block on no-op sessions. Wrapper bumped to `2026.03.27-01`.

# 2026-03-26
- Admin UI: removed the temporary rail pills for websocket/mTLS status again. Cache-bumped `nav.js` to `v=2026-03-26-02` and `dashboard.js` to `v=2026-03-26-05`.
- Admin UI: added a persistent rail status indicator for the admin websocket, so the shell now shows `Live: connected` when the live websocket is healthy and degrades to connecting/offline/error states when it is not. Cache-bumped `nav.js` to `v=2026-03-26-01` and `dashboard.js` to `v=2026-03-26-04`.
- Admin UI/API: restored reliable insecure-host approval prompts by adding `GET /admin/insecure-approvals/pending` and rehydrating the admin approval queue on dashboard load plus websocket reconnect. Pending authorization requests no longer disappear just because the original live event was missed. Cache-bumped `dashboard.js` to `v=2026-03-26-03`.
- Config/MCP: fixed insecure-host managed MCP auth so `config/retrieve` no longer reuses cached baked config with an expired short-lived MCP bearer. Insecure hosts now get a freshly baked MCP token on each config fetch, which avoids post-auth MCP startup failures during `initialize`.
- Admin UI: when the dashboard is open and a new insecure-host authorization request arrives over the admin websocket, the insecure approval modal now rings a short synthesized bell once per new request burst (5s cooldown) instead of staying silently pending. Cache-bumped `dashboard.js` to `v=2026-03-26-02`.
- cdx wrapper: concurrent-run guard no longer emits duplicate pre-launch warning lines when another `cdx` process is already active; the state now stays in the compact `Concurrent` summary row with shorter copy (`Using local auth.json.`, `Local auth.json is invalid.`, `Local auth.json is missing.`). Rebuild `bin/cdx` after fragment edits.
- Admin UI: fixed the insecure-window toggle in the hosts table so clicking the inline switch no longer also opens the host detail page; row navigation now ignores interactive descendants like the toggle label/track, and the dashboard asset cache key was bumped to `v=2026-03-26-01`.
- cdx wrapper: fixed the cron auto-update execution path so `cdx --cron` now resolves its own Codex binary, current client version, and platform asset name before the GitHub release lookup/update step. The cron path also now normalizes wrapper download URLs inline instead of calling a helper that was defined later in the generated script, opens the cron lock without redirecting the rest of the run’s stderr to `/dev/null`, and defers the cron-mode dispatch until after the shared update helpers are defined in the generated wrapper. Together those fixes remove the hidden helper-scope / helper-order shell failures that could leave cron-managed hosts stuck on `could not fetch release metadata` or silent `127` exits instead of actually applying queued Codex and wrapper updates. Wrapper bumped to `2026.03.26-09`.

# 2026-03-24
- MCP/API: hardened `/mcp` JSON-RPC responses against invalid UTF-8 in project content and now emit explicit `Content-Length` for final payloads, so malformed bytes in synced project data no longer collapse tool responses into undecodable bodies for Codex streamable-HTTP clients.
- cdx wrapper: fixed a self-update decision regression that inverted shell truthiness and treated already-current wrappers as update-needed. Hosts on the current wrapper could redownload the same script every run, trigger `Wrapper updated; restarting cdx`, and then trip the restart-loop guard on the restarted pass. The helper now returns success only for real version/SHA mismatches. Wrapper bumped to `2026.03.24-10`.
- cdx wrapper: fixed two `set -e` no-op regressions that could make `cdx` quit right after the banner or after the preflight summary on interactive hosts. `apply_otel_env_from_config()` and `ensure_current_project_trusted_in_config()` now return success on no-op paths, the run-lock open no longer redirects wrapper `stderr` to `/dev/null` for the rest of the run, and interactive SSH launches surface real Codex errors again. Wrapper bumped to `2026.03.24-09`.
- cdx wrapper: when an insecure host is waiting on admin approval, the console now prints an explicit hint to open Admin and click `Enable window` for that host instead of the misleading closed-window wording. Wrapper bumped to `2026.03.24-08`.
- cdx wrapper: simplified terminal execution — removed PTY capture (`script` utility and embedded Python `pty.fork()` fallback) in favour of direct exec for TTY sessions and `tee` capture for pipe mode. Token usage for TTY sessions now comes from `~/.codex/sessions/` JSONL files (mtime-scoped discovery) instead of scraped terminal output. Removed env vars `CODEX_FORCE_PTY`, `CODEX_NO_PTY`, `CODEX_NO_SCRIPT`; removed auto-disable marker `~/.codex/.cdx_no_pty`; removed `script` from Linux prereq auto-install; removed Doctor PTY row. Interactive SSH sessions still default to `--no-alt-screen` (opt out via `CODEX_SSH_ALT_SCREEN=0`). Wrapper bumped to `2026.03.24-07`.
- Admin UI: tightened the hosts-table status pill so `Healthy` now means the host has a valid auth payload and is not on an outdated auth digest; active hosts with stale auth now show `Outdated auth` instead of being lumped into the healthy bucket. Cache-bumped `dashboard.js` to `v=2026-03-24-05`.
- cdx wrapper: `cdx --cron install` now immediately pings `POST /cron/check` after successfully writing the managed crontab entry, so the server records an initial cron check-in right away instead of waiting for the first scheduled run. Wrapper bumped to `2026.03.24-05`.
- Admin UI/API: fixed AGENTS.md history actions so the dashboard matches backend semantics. Historical rows now offer `View`, `Revert`, and `Delete`; `View` loads a read-only copy of that version, while `Revert` clones the selected historical version into a brand-new latest AGENTS.md and switches fleet serving back to `latest`. Added `GET /admin/agents/versions/{id}` and `POST /admin/agents/revert`, and renamed dashboard copy from misleading `default` labels to `pinned` where the backend is actually in locked serve mode.
- Skills/MCP: hard-cut fleet Skill delivery to MCP-only. `cdx` no longer pulls, diffs, mirrors, or pushes local Skill files; startup sync drops the `skills` block entirely, hosts now read canonical manifests through `skill://{slug}`, and upgraded wrappers prune stale `~/.agents/skills`, `~/.codex/skills`, and legacy skill baseline files. Wrapper bumped to `2026.03.24-04`.
- Config builder/feature sync: aligned the app’s `config.toml` feature registry with the current Codex CLI surface. Experimental toggles still live under `[features]`; the admin UI now exposes `tui_app_server` as `App-server TUI`, removed the obsolete bubblewrap toggle for `use_linux_sandbox_bwrap`, treats default-off experimental flags as unchecked when absent from saved config, and now accepts current upstream feature names such as `request_permissions_tool` while dropping stale app-only keys like `request_permissions`. Cache-bumped `config.js` and refreshed docs/tests.
- Admin UI: fixed the `?` keyboard help so it now opens only the compact shortcut modal instead of showing two overlapping help systems; merged the useful missing shortcuts/behavior from the larger help path into the compact flow, including `g p` for Projects settings, `g a` for Account, context-aware `n`, smarter `/` search focus, and in-panel `r` refresh behavior. Cache-bumped `dashboard.css` and `dashboard.js`.
- CoCo/spawner: aligned the Codex engine launcher with the real `codex exec --help` surface instead of the interactive top-level CLI. The spawner now supports current `exec` passthrough flags such as `--config`, `--enable`/`--disable`, `--image`, `--oss`, `--local-provider`, `--profile`, `--sandbox`, `--full-auto`, `--add-dir`, `--ephemeral`, `--output-schema`, `--color`, `--progress-cursor`, and `--json`; interactive-only flags like `--search`, `--remote`, and `--no-alt-screen` remain intentionally unsupported. Added a Python regression test for command construction.
- cdx wrapper: normal sync-capable runs now reconcile the managed auto-update cron job to match server policy in both directions. If the server enables cron-managed auto-update, `cdx` installs the missing managed cron entry automatically before treating cron as authoritative; if the server disables it, `cdx` removes the managed cron entry automatically. When cron reconciliation fails, wrapper falls back to the normal startup Codex update path instead of silently skipping updates. Wrapper bumped to `2026.03.24-03`.
- Admin UI: micro-polish on interactive elements — (1) added `transition: background 150ms ease, border-color 150ms ease, color 120ms ease` to `.config-section` sidebar buttons, which previously snapped on hover/active with no animation; (2) unified chip transition durations: both `.signal-chip` and `.chip` used mismatched staggered timings (200ms/180ms/160ms across three properties) and are now consolidated to a single `160ms ease` so all three properties animate in sync.
- Admin UI/API: expanded host auto-update status into backend-derived states so the hosts table and host detail can distinguish disabled-but-running cron, missing daily check-ins, update-needed, update-succeeded, and "new release since last check" cases with compact emoji plus detailed tooltips.
- Admin UI: the hosts table now includes an `Auto-updates` column with three compact states: `-` when cron auto-updates are not enabled, `✅` when the host has a recent cron check-in, and `⚠️` when auto-updates are enabled but the last cron check is missing or stale.
- Admin UI: the login page now prefetches and idle-warms the main admin shell (`/admin/index.html`, dashboard CSS, and dashboard JS) so the first authenticated dashboard visit is less of a cold start.
- cdx wrapper: shortened the skipped Codex auto-update note from `cron-managed auto-update enabled` to `cron-managed updates` so the `Versions` summary fits narrow terminals without losing the reason.
- Admin UI: added a rail `?` help trigger that opens a keyboard-shortcuts modal, plus real admin-shell shortcuts for `?`, `n`, `/`, `r`, and `g` navigation chords (`d/h/l/s/p/u`) so the cheat sheet reflects live behavior instead of static copy.
- cdx wrapper: fixed the `Versions` summary so skipped Codex update checks now report the real reason instead of always blaming privileges; cron-managed hosts now say `cron-managed auto-update enabled`, active-run and unsupported-platform skips stay distinct, and true privilege skips still include the detected UID. Wrapper bumped to `2026.03.24-01`.

# 2026-03-24
- Host sync/MCP API: fixed a controller helper regression that broke `/slash-commands`, `/skills`, `/agents/retrieve`, `/config/retrieve`, host lane/usage routes, and `/mcp` with HTTP 500 `Unexpected error` before auth completed; the controllers now call the autoloaded request/payload/version helper classes directly again.

# 2026-03-24
- Admin UI: fixed MCP Logs timestamp display — `initMcpLogs` was rendering raw ISO timestamp strings directly (e.g. `2026-03-24T10:15:00Z`) instead of formatting them like the API Logs and Events tables do (`24.03.26, 10:15`); added `parseTimestamp`/`formatTimestamp` helpers inside `initMcpLogs` and wired them into `formatTime`, matching the pattern already used by the other two log panels; cache-bumped `logs.js` to `v=2026-03-24-03`.

# 2026-03-24
- Tests: added `ClientVersionServiceTest` with 31 unit tests covering the pure / near-pure public surface of `ClientVersionService` — `normalizeClientVersion` (null/empty/whitespace → "unknown", strips `rust-v`/`v`/`codex-cli` prefixes, trims whitespace), `applyClientVersionOverrideForHost` (null/non-string/empty/`global`/`GLOBAL` override → unchanged, valid semver override replaces client_version with `locked` source and `enforce_exact`, prefix-stripped overrides, below-minimum overrides clamped to floor, missing key → unchanged), `latestReportedVersions` (no hosts → null, all hosts lack version → null, single host → its version, multiple hosts → max semver, prefix-stripped versions compared correctly, hosts missing key skipped), `quotaLimitPercent` (null stored → default 100, valid `80` → 80, value below min clamped to 50, non-numeric → default), and `quotaWeekPartition` (null stored → default off/0, `5` → 5-day, `7` → 7-day, unrecognised value → default); `ClientVersionService` previously had zero direct test coverage.
- Backend: extracted duplicated `hostId` and `assertSha256` helpers from six sync services (`AgentsService`, `ClientConfigService`, `MemoryService`, `ProjectCoordinationService`, `SkillService`, `SlashCommandService`) into a shared `HostServiceTrait`; no behaviour change.

# 2026-03-24
- cdx wrapper: added Runner row to `--doctor` output — the doctor report now includes a "Runner" row (between MCP and API) showing the current runner state (verified, failing, stale, or disabled), with green ✅ when healthy, yellow/red coloring when degraded, and a failure hint when `runner_tone` is red; the row is omitted when runner is entirely unconfigured with no state data. Rebuilt `bin/cdx`.

# 2026-03-24
- Admin UI: optical polish — fixed log panel inputs (search, page-size, event filters), `.badge`, and `.token-chip` using hard-coded `rgba(15,23,42,…)` backgrounds and borders that rendered near-invisible in dark mode; switched to `var(--input-bg)` / `var(--border)` / `var(--frost)` so all themes render correctly; also constrained `#mcp-status-filter` width (was inheriting a `200px` minimum from the generic panel-actions rule, making a 3-option select unnecessarily wide).

# 2026-03-24
- Admin UI: added search and status-filter to the MCP Access Logs panel — the panel previously had only a Refresh button, while API Logs and Events both offered search/filter controls; a text search input (filters by host or tool name, Escape to clear) and a success/failure select are now wired into client-side filtering against the full loaded result set; a footer entry-count line ("N entries" / "N / M entries") mirrors the status footer used by the other log views.

# 2026-03-24
- Admin UI: visual polish — (1) sticky editorial-rail nav now uses `backdrop-filter: blur(12px)` with a slightly lower background opacity (82% → was 96%) so content scrolling beneath the nav blurs through the frosted surface, matching the depth treatment already used by cards, modals, and the login panel; (2) dashboard `input`, `select`, and `textarea` elements now animate their `border-color` and `box-shadow` properties over 180 ms so focus rings and hover border changes cross-fade instead of snapping, consistent with the login page's input transitions; both changes respect `prefers-reduced-motion`.

# 2026-03-24
- cdx wrapper: fixed `dangerously_bypass_approvals_and_sandbox = true` config setting being silently ignored — the `apply_codex_cli_toggles_from_config` helper was calling `set -- "$line" "$@"` inside a bash function body, which only modifies the function's local `$@`; the `--dangerously-bypass-approvals-and-sandbox` flag was therefore never prepended to the args passed to `codex`; replaced the function wrapper with inline script-scope logic so `set --` modifies the global positional parameters. Rebuilt `bin/cdx`.
- Admin UI: hardened `hydrateRoles` in `users.js` — role keys and labels from the server were injected into `<select>` `innerHTML` without HTML-escaping; applied `escapeHtml` to both key (`value` attribute) and label (option text content) to prevent unexpected HTML injection if server-side role metadata ever contains special characters; cache-bumped `users.js` to `v=2026-03-24-05`.

# 2026-03-24
- Tests: added `RunnerValidationServiceTest` with 61 unit tests covering pure and near-pure public methods of `RunnerValidationService` — `parseTimestamp` (null/empty/invalid/valid inputs), `calculateDigest` (null/empty → null, valid → 64-char sha256, deterministic, differs on different inputs), `ensureAuthsFallback` (auths present → unchanged, synthesizes from `tokens.access_token` / `OPENAI_API_KEY`, prefers tokens over env key, skips empty token, no-token → unchanged), `buildAuthArrayFromEntries` (structure, null-field omission, optional fields, meta spreading, alphabetical target and item key sort), `canonicalizeAuthPayload` (sets correct last_refresh and auths, preserves extra keys), `canonicalAuthFromPayload` (body-JSON branch, entries fallback when body absent or invalid), `assertReasonableLastRefresh` (valid, invalid string, implausibly old, too far future, within skew window), `normalizeAuthEntries` (single entry, organization/project, alias field names, unknown fields → meta, no-auths + fallback token, throws on empty/missing token/whitespace/short/placeholder/low-entropy token/empty target), `isRunnerFailing` (fail/FAIL → true, ok/null/empty → false), `recordRunnerOutcome` (ok → runner_state=ok + last_ok + last_check when reachable; non-ok → runner_state=fail + last_fail; last_check omitted when not reachable; case-insensitive), and `resolveRunnerHost` (hostContext with id returned directly, source_host_id lookup, fallback to first host, null when no hosts, context without id ignored); `RunnerValidationService` previously had zero direct test coverage.

- Backend: reduced code duplication in `HostRepository` — extracted a private `updateHostFields` helper that handles the common `UPDATE hosts SET … WHERE id = :id` pattern (including optional `updated_at` stamping); 15 public update methods now delegate to it, eliminating ~130 lines of repetitive prepare/execute boilerplate while preserving all existing behavior.

# 2026-03-24
- cdx wrapper: improved run exit footer — (1) a `Run summary` header line now appears above the post-run usage/cost/time/sync block, consistent with how the `--doctor` report section is headed; (2) run times under 1 second now display as milliseconds (e.g. `743ms`) instead of `0s`. Rebuilt `bin/cdx`.

# 2026-03-24
- Admin UI: optical polish — (1) sidebar nav tabs (hosts, logs, settings) split their combined `:hover, :focus-visible` rule so keyboard focus now shows a visible inset accent ring instead of only a barely-perceptible background tint; (2) modal inputs marked `aria-invalid="true"` restore a proper 3 px danger-tinted focus ring when focused, matching the ring size of normal field focus.

# 2026-03-24
- Admin UI: improved form validation feedback in the Users modal — (1) username is now required client-side with an inline error and `aria-invalid` highlight before hitting the server; (2) password is required for new users; (3) the confirm-password field gets the same real-time "Passwords match / Passwords do not match" hint (aria-live) already used in the account password-change form; (4) the first invalid field is auto-focused on save; (5) field error state clears on input so there's no stale red border; (6) opening the modal now moves focus to the Name field for keyboard and screen-reader users; CSS adds a red border + glow rule for `[aria-invalid="true"]` inputs inside modals.

# 2026-03-24
- Admin UI: polish — tab navigation transitions and active indicator consistency: `.host-tab` / `.log-tab` top tabs and `.hosts-nav-link.host-tab` / `.logs-nav-link.log-tab` sidebar links now animate color, border, and background changes with a 140 ms ease transition, matching the existing `.settings-tab` behavior so hover/focus state changes cross-fade instead of snapping; the active bottom-border indicator on `.host-tab.active` / `.log-tab.active` now uses `var(--accent)` instead of `var(--text)`, consistent with all other active-selection indicators in the dashboard (sidebar links, settings tabs). New selectors added to the existing `prefers-reduced-motion` block.

# 2026-03-24
- Admin UI: fixed three bugs in `users.js` — (1) delete confirmation fell through silently when `window.__confirm` was not yet defined, because the `!window.__confirm ||` short-circuit caused the whole action to return early instead of falling back to native `window.confirm`; fixed to always show a confirmation dialog; (2) edit/create API responses lacked null guards so a missing `user` object in the response would throw `Cannot read properties of null (reading 'id')` / crash the sort comparator; both now throw a clear error that is caught and shown to the user; (3) sort comparator after create guarded against null `username` with `|| ''`; cache-bumped `users.js` to `v=2026-03-24-04`.

# 2026-03-24
- Tests: added `VersionHelperTest` with 73 unit tests covering all testable public methods of `VersionHelper` — `normalizeVersionValue` (null/bool/int/array/empty/whitespace/trim/falsy-string inputs), `normalizeBoolean` (bool pass-through, int 0/1 vs other, all truthy/falsy string aliases including case-folding and whitespace trim, unrecognized/null/array/float → null), `normalizeReverseDnsModeInput` (null → global, bool/int branching, all enabled/disabled/global string aliases, case-insensitive, unrecognized → null), `formatReverseDnsModeOutput` (same mapping but unknown strings fall back to 'global' instead of null), `modelUsesSparkQuotaLane` (null/empty/whitespace → null, spark-containing model → true, non-spark → false, case-insensitive), `resolveActiveQuotaLaneForHost` (host lane-preference wins, model_override second, global cdx_model third, explicit fallback fourth, default 'normal'; VersionRepository mocked), and `extractClientVersion`/`extractWrapperVersion` (payload-first branch: value returned/trimmed/skipped when empty, null for non-array payload); `VersionHelper` previously had zero direct test coverage.
- Backend: extracted repeated ChatGPT-usage fetch-and-hydrate block in `AuthController` into a private `fetchChatGptUsage()` helper, eliminating three identical 4-line sequences across `auth`, `syncStatus`, and `syncBootstrap`.

# 2026-03-24
- cdx wrapper: `--doctor` SSH env row now only shows terminal identifier env vars that are actually set (TERM_PROGRAM, KONSOLE_VERSION, VTE_VERSION, KITTY_WINDOW_ID, WEZTERM_VERSION, WT_SESSION); unset/empty vars are silently omitted so the row stays concise on most machines instead of printing a long chain of `n/a` and empty `KEY=` entries. Rebuilt `bin/cdx`.

# 2026-03-24
- Admin UI: optical polish — password-change form fields in the account panel now stack label-above-input (flex column) with full-width inputs, consistent padding, and a focus ring matching the rest of the dashboard; previously the label and input rendered inline side-by-side with no width constraint. Match hint colored states (ok/err) gain `font-weight: 600` and `line-height: 1.3` for legibility at 12 px.

# 2026-03-24
- Admin UI: password change form now shows a real-time "Passwords match / Passwords do not match" hint beneath the confirm field as the user types, eliminating the need to submit the form to discover a mismatch; the hint is aria-live so screen readers announce the state change; CSS uses `--success` / `--danger` tokens for theme-aware coloring.

# 2026-03-24
- Admin UI: visual polish — `.chip` and `.signal-chip` status badges now animate background, border, and color changes with a 160–200 ms ease transition, so JS-driven state flips (e.g. secure→insecure, ok→warn) cross-fade instead of snapping; a matching `prefers-reduced-motion` block disables the new transitions for users who prefer reduced motion. Login page `card-enter` animation no longer animates `filter: blur()` — the scale + opacity entrance is equally smooth without forcing a GPU compositing layer per frame; a `prefers-reduced-motion` block on the login page now suppresses the card entrance, logo-glow, and button gradient-shift animations entirely.

# 2026-03-24
- Admin UI: fixed stale empty-state message in the Users table — when `loadUsers()` cleared the users array while a non-matching filter was still active, the empty state showed "No users match the current filter." instead of "No users yet. Create the first admin to enable login."; the fix sets the correct text before early-returning from `renderUsers()` in the empty-users branch; cache-bumped `users.js` to `v=2026-03-24-03`.

# 2026-03-24
- Tests: added `ReverseDnsValidatorTest` with 37 unit tests covering all testable public methods of `ReverseDnsValidator` — `normalizeHostname` (null/empty/whitespace/dots-only inputs, case folding, trailing-dot stripping, subdomain preservation), `reverseDnsName` (IPv4 reversal, IPv6 nibble reversal, IPv4-mapped IPv6 unwrapping, invalid/non-IP rejection), and `isReverseDnsRequired` (host-level boolean/int/string overrides, recognised string aliases like `enabled`/`yes`/`on`, fall-through to global `reverse_dns_enabled` flag via `VersionRepository`); `ReverseDnsValidator` previously had zero direct test coverage.
- Backend: extracted the duplicate version-snapshot-with-host-override block in `AuthService::handleAuth` into a private `buildVersionSnapshotForHost` method; the identical 7-line block previously appeared twice in the method (once before and once after the runner preflight path).

# 2026-03-24
- cdx wrapper: `--doctor` Sync row now renders items separated by ` | ` (e.g. `auth=ok | prompts=ok | skills=ok | agents=ok | config=ok`) instead of plain spaces, matching the visual style of the Deps row and making each sync channel easier to scan. Run-exit footer (`print_run_exit_footer`) now locally computes its own `ROW_LABEL_WIDTH` from the footer's own label set so columns align tightly to "Run usage" / "Run cost" / "Run time" / "Sync" rather than inheriting the wider pre-run summary width. Rebuilt `bin/cdx`.

# 2026-03-24
- Admin UI: optical polish — panel filter inputs (hosts, users, logs) now use `var(--input-bg)` instead of a hardcoded `#fff` background, so they render correctly in dark mode instead of showing as stark white boxes; sort-link column headers now animate their label color and sort-indicator opacity with a 120 ms ease transition instead of snapping instantly on click.

# 2026-03-24
- Admin UI: Users table now has a live search filter — typing in the new filter input above the table instantly narrows the list by name, username, email, or access level; pressing Escape clears the filter; a "no users match the current filter" message is shown when the filter produces no results.

# 2026-03-24
- cdx wrapper: end-of-run usage reporting now fast-paths only the last ~256 KiB of the PTY capture for a final legacy `Token usage:` line before falling back to the older full-log/session-JSONL compatibility paths, so long interactive runs no longer need a full capture scan in the common case. `/usage` upload is now explicitly best effort with roughly a 3-second total budget across SSL-context attempts, and the stripped-line retry is skipped for slow/time-out network failures so wrapper exit stays prompt. Wrapper bumped to `2026.03.24-01` and rebuilt.
- Tests/docs: added wrapper regression coverage for tail-fast-path parsing, full-log fallback when the tail misses usage, and bounded `/usage` timeout behavior; refreshed wrapper usage docs in `docs/interface-cdx.md`, `docs/USAGE.md`, and `docs/OVERVIEW.md`.

# 2026-03-24
- cdx wrapper: `format_simple_row` now wraps ANSI-colorized text on narrow terminals — previously the fold logic was skipped whenever escape codes were present, so error/warning rows in `--doctor` and `--status` output (highlighted in red or yellow) could overflow the terminal width; the new path measures visible character width via `strip_ansi_sgr` and breaks on space boundaries, keeping value columns aligned with the label pipe just as plain-text rows do. Rebuilt `bin/cdx`.

# 2026-03-24
- Admin UI: Users table is now sortable by Name, Username, Access level, Status, and Last login — clicking a column header toggles ascending/descending order; active column shows ▲/▼ indicators reusing the existing `.sort-link`/`.sorted` styles from the hosts table; default order remains username ascending; sort state is in-memory and resets on page load.

# 2026-03-24
- Admin UI: visual polish — removed erroneous `border-radius: 12px` from the global `:focus-visible` rule in `theme.css` and `dashboard.css`; the override was forcing all keyboard-focused elements (including pill-shaped buttons with `border-radius: 999px`) to render their focus outline as a rectangle, since modern browsers follow the element's own `border-radius` when drawing outlines; also added a subtle `scale(0.97)` and `box-shadow: none` to the global `button:active` state in `dashboard.css` for more tactile press feedback.

# 2026-03-24
- Admin UI: fixed XSS in MCP logs table — `initMcpLogs` was injecting `host_fqdn`, tool name/method, `error_message`, and `created_at` directly into `innerHTML` without escaping, while `initClientLogs` and `initEventLogs` in the same file both consistently use `escapeHtml`; added `escapeHtml` inside `initMcpLogs` and applied it to all server-sourced values at the point of injection, including the catch-block error row; cache-bumped `logs.js` to `v=2026-03-24-02`.

- Tests: added `TokenUsageTrackerTest` with 52 unit tests covering all public methods of `TokenUsageTracker` — `sanitizeUsageLine` (ANSI/OSC stripping, control-char removal, token-usage prefix extraction, truncation at 1000 chars), `normalizeCommand` (defaults, case-insensitive accept, invalid-value rejection), `normalizeUsageEntry` (all fields, line-only, numeric-only, string integers with commas/underscores, negative/invalid rejection, optional cached/reasoning), `normalizeUsagePayloads` (single entry, multiple entries, non-array skipping, empty rejection, path-in-error), and `normalizeUsageCost` (null when no billable fields, rounding to 6 decimals, NaN/negative/Inf → null, zero valid); `TokenUsageTracker` previously had zero direct test coverage.

- Backend: optimized `HostAuthDigestRepository::prune()` to use a LIMIT/OFFSET query instead of fetching all digest IDs into PHP and slicing with `array_slice`; the query now returns only the rows that fall outside the retention window, reducing unnecessary data transfer on hosts with many digest entries.

# 2026-03-24
- cdx wrapper: polished `--doctor` output — the report now closes with a trailing divider line so the block is visually bounded on both ends (previously it trailed off after the last hint); the "see hints below" suffix also uses a unicode down-arrow (↓) on unicode-capable terminals for a cleaner pointer. Rebuilt `bin/cdx`.

# 2026-03-24
- Admin UI: skeleton loading screens for all three log tables (API Logs, Events, MCP Logs) — replaced the plain "Loading…" text row with animated loading sheen skeleton rows that reflect the column layout of each table, giving users immediate visual feedback about structure while data is fetching; respects `prefers-reduced-motion`.

# 2026-03-24
- Admin UI: visual polish — `button.secondary` now uses `var(--panel)` background and `var(--border)` border instead of hardcoded white/light-grey values, so secondary buttons render correctly in dark mode; settings sidebar tabs (`.settings-tab`) gained a `transition` on color, border-left-color, and background so hover state changes animate smoothly instead of snapping.

# 2026-03-24
- cdx wrapper: fixed two TOML inline-comment bugs — `toml_table_enabled` (used by `--doctor` MCP detection) now matches section headers that carry a trailing `# comment` (e.g. `[mcp_servers.cdx] # remark`) instead of falsely reporting the table as missing; `is_header` inside `ensure_project_path_trusted_in_config` also gained the same fix so section-boundary detection no longer overshoots when the next header has an inline comment, preventing potential `trust_level` mis-insertion in config.toml. Rebuilt `bin/cdx`.

# 2026-03-24
- Tests: added `PayloadHelperTest` with 41 unit tests covering all three public methods of `PayloadHelper` — `extractSyncAuthFingerprint` (defaults, auth-subkey extraction, digest validation/normalization, installation_id handling), `extractSyncAuthCandidate` (null/non-array inputs, missing key, valid/invalid candidate types), and `extractSyncHostUserInput` (flat vs. `host_user` subkey, whitespace trimming, partial fields, non-array subkey fallback); `PayloadHelper` previously had zero direct test coverage.

# 2026-03-24
- Backend: eliminated duplicated row-normalization logic in `TokenUsageIngestRepository` (extracted `normalizeIngestRow()`, used by both `recent()` and `search()`) and `TokenUsageRepository` (extracted `normalizeUsageRow()`, used by `latestForHost()`, `latestForHosts()`, and `recent()`); no behavior change.

# 2026-03-24
- cdx wrapper: the run exit footer now shows a "Run time" row with the elapsed session duration (seconds-precision for runs under a minute, e.g. `45s`; minutes/hours for longer runs, e.g. `2h 34m`); the footer block is also now closed with a matching divider line so it visually matches the opening divider. Rebuilt `bin/cdx`.

# 2026-03-24
- Admin UI: improved Profiles editor UX — deleting a profile now requires confirmation via the standard confirm dialog (shows profile name) instead of removing it silently; profile name input shows a red inline error as you type if the value contains characters outside the allowed set (`A–Z a–z 0–9 _ -`), with `aria-invalid` set for screen-reader accessibility; the error clears as soon as the name becomes valid again. Cache-bumped `profiles.js` to `v=2026-03-24-02`.

# 2026-03-24
- Admin UI: polished panel and toast entrance animations — `dashboard-hero` and `dashboard-overview-grid` now use a spring easing (`cubic-bezier(0.22, 1, 0.36, 1)`) with a slightly longer duration (500ms / 540ms) so section transitions feel snappier and more premium; toast notifications enter with a combined `translateY + scale(0.98)` from-state and the same spring easing on transform, giving them a more natural pop-in; modals gain a slightly deeper initial offset (`translateY(10px) scale(0.95)`) and spring easing on both transform and opacity for a more cohesive feel.
- Tests: fixed `CdxWrapperRunFooterTest::testWrapperFormatsRunCostWithTwoDecimalsAndCurrencySuffix` — the test was still asserting the old `%.2f$` (dollar-suffix) format string after the wrapper cost display was changed to `printf '$%s'` (dollar-prefix) with separate 2/4-decimal formatting; renamed the test to `testWrapperFormatsRunCostWithCurrencyPrefixAndVariableDecimals` and updated its assertions to match the current `format_run_cost_value` implementation (`printf '$%s'`, `%.4f` for sub-cent, `%.2f` otherwise).
- Tests: added `InsecureHostWindowServiceTest` with 34 unit tests covering all public methods of `InsecureHostWindowService` — `isTimestampActive`, `parseSessionStartedAt`, `resolveInsecureGraceUntil` (including env-override and max-clamp cases), and `enforceInsecureWindow` (secure pass-through, active window, grace-window store/retrieve distinction, fully-expired denial, and exception payload shape); `InsecureHostWindowService` previously had zero direct test coverage.
- cdx wrapper: fixed run cost display — cost is now formatted as `$1.23` (dollar sign before the amount) instead of the previous `1.23$`; values below $0.01 now display four decimal places (e.g. `$0.0012`) rather than rounding to `$0.00`. Rebuilt `bin/cdx`.

- Admin UI: added `n` keyboard shortcut to open the "new item" modal for the current panel — Hosts → New Host, Users → Add User, Settings/Slash Commands → New Command, Settings/Skills → New Skill; shortcut is listed in the `?` help modal alongside the existing `r` / `/` / `g+x` shortcuts.
- Admin UI: visual polish — nav rail hover indicator now expands to full width at reduced opacity (`scaleX(1)`, 32%) instead of the previous partial-width ghost (`scaleX(0.65)`, 28%), so hover→active is a smooth opacity-only transition; rail link text colour transition harmonized from 120ms to 160ms to match the underline timing; focus rings on modal and panel-action inputs unified to use the canonical `var(--ring)` box-shadow token (replacing inconsistent `outline: 1px solid var(--accent)`) and switched to `:focus-visible` so keyboard-only rings don't appear on mouse click.
- cdx wrapper: fixed `find_block()` in `otel_env_from_config_python` and `codex_cli_args_from_config_python` so TOML section headers with inline comments (e.g. `[otel] # my settings`) are now matched correctly; previously the regex `\]\s*$` did not accept a `#`-prefixed comment after the closing bracket, causing OTEL environment variables and `dangerously_bypass_approvals_and_sandbox` to be silently ignored when the user had a comment on the section header line. Rebuilt `bin/cdx`.
- Tests: added `ProjectNormalizerTest` with 62 unit tests covering all public methods of `ProjectNormalizer` — `normalizeSlug`, `normalizeAbout`, `normalizeRoster`, `normalizeNotePayload`, `normalizeTodoPayload`, `normalizeFilePayload`, `normalizeFeedbackPayload`, `normalizeStoredName`, and `normalizeOptionalString`; `ProjectNormalizer` previously had zero test coverage.
- Backend: eliminated N+1 query pattern in `GET /admin/hosts` — added `TokenUsageRepository::latestForHosts()` and `HostUserRepository::listByHosts()` batch methods that fetch token-usage and user rows for all hosts in two queries instead of two-per-host; `AdminOverviewController::hosts()` now uses these batch methods and also hoists the `$normalizeTs` closure out of the per-host loop.
- cdx wrapper: colorized individual sync status tokens in the `--doctor` Sync row — each status value (`ok`, `offline`, `concurrent`, etc.) is now rendered green/yellow/red instead of plain text, making it faster to spot failures at a glance. Rebuilt `bin/cdx`.

- Admin UI: unsaved-changes guard for config.toml and Profiles editors — navigating away via SPA links now shows a browser confirm dialog when either editor has uncommitted edits; closing/reloading the tab also triggers the native `beforeunload` prompt; dirty state is cleared automatically on successful save or reload; cache-bumped `dashboard.js` to `v=2026-03-24-03`, `config.js` to `v=2026-03-24-01`, `profiles.js` to `v=2026-03-24-01`.
- Admin UI: polished nav rail affordances — non-active nav links now show a faint partial underline on hover (28% opacity, 65% scale, accent colour) so the active-state indicator is telegraphed before click; the nav group dropdown panel gains a proper elevation shadow (`0 8px 24px rgba(2,6,23,0.14)` + 1px accent ring overlay) instead of being flat against the background. Cache-bumped `dashboard.css` to `v=2026-03-24-02`.
- cdx wrapper: fixed heuristic TOML validator in `--doctor` so section headers with inline comments (e.g. `[otel] # remark`) are no longer falsely reported as parse errors on Python < 3.11 without `tomli`; the fix strips the inline comment portion before the closing-bracket check. Rebuilt `bin/cdx`.
- Tests: added `ConfigNormalizerTest` with 114 unit tests covering all public methods of `ConfigNormalizer` — `normalizeString`, `normalizeBool`, `normalizeWebSearchFeature`, `normalizeApprovalPolicy`, `normalizePersonality`, `normalizeReasoningSummary`, `normalizeReasoningEffortForModel`, `normalizeInt`, `normalizeStringList`, `normalizeStringMap`, `normalizeSupportedModel`, `modelSupportsReasoningEffort`, `isSparkCodexModel`, `isDetailedOnlyCodexModel`, `normalizeModelVerbosity`, `settingsHash`, `assertSha`, and a full `normalizeSettings` integration suite; `ConfigNormalizer` previously had zero test coverage.
- Backend: reduced code duplication in `LogRepository` — extracted `buildInClauseParams()` and `normalizeActions()` private helpers so the identical IN-clause construction logic shared between `recentByActions()` and `countActionsSince()` lives in one place; added `@param`/`@return` PHPDoc annotations on the new helpers for static-analysis clarity.


- cdx wrapper: improved `--doctor` hints formatting — hints are now rendered as aligned table rows using `format_simple_row` (`Hint N  | <text>`) instead of loosely indented `  Hint N: <text>` lines, making them visually consistent with the rest of the doctor report table and enabling the existing long-line wrapping logic to apply correctly.
- Admin UI: polished interactive element transitions — default buttons now use `var(--panel)` background (theme-aware, fixes invisible text on white in dark mode), gain a `1px` lift with a soft accent shadow on hover, and snap back on press via a unified `transition` on the overhaul layer; `.ghost` buttons pick up an accent-tinted hover; nav rail active-tab underline now springs in from the center with a scale + spring easing (`cubic-bezier(0.34, 1.56, 0.64, 1)`) instead of a plain opacity fade.
- cdx wrapper: fixed Python regex in `find_block` (used by both `otel_env_from_config_python` and `codex_cli_args_from_config_python`) where raw-string double backslashes (`r'\\['`) were parsed by the regex engine as "literal backslash + character class" instead of "literal `[`", so `[otel]` and `[security]` TOML section headers were never matched — OTEL environment variables and `dangerously_bypass_approvals_and_sandbox` were silently ignored even when configured; fixed by using single-backslash raw strings (`r'\['`, `r'\]'`, `r'\s'`). Rebuilt `bin/cdx`.
- Tests: fixed `CdxWrapperSshKeyboardFilterTest::testDoctorReportsInteractiveSshDirectLaunchMode` which was checking for the removed `Doctor ssh`/`Doctor cli` label prefixes instead of the current `"SSH env"`/`"CLI"` format introduced in the 2026-03-24 doctor refactor.
- Tests: added `TomlRendererTest` with 50 unit tests covering `buildToml` (root keys, notify, features, notice, security, sandbox, shell env policy, profiles, mcp_servers, otel, custom_toml), `escapeString`, `tomlString`, `normalizeHomePath`, and `injectTrustedProjectToml` — `TomlRenderer` previously had no test coverage.

- cdx wrapper: improved `--doctor` output readability — added a divider and "Doctor report" section header, replaced the redundant "Doctor " prefix on every label with short clean names (`Deps`, `Auth`, `Sync`, `Config`, `MCP`, `API`, `Latency`, `Disk`, `Cron`, `PTY`, `SSH env`, `CLI`), added a `Result` summary line showing pass/fail count, numbered and reformatted action hints (`Hint N: …`), and dynamically recompute the label column width within the doctor section.
- Admin UI: added keyboard shortcuts for the admin dashboard — `g`+`d/h/l/s/u/a` navigate between panels, `/` focuses the active search/filter input, `r` clicks the current view's refresh button, and `?` opens a keyboard shortcuts help modal; cache-bumped `dashboard.js` to `v=2026-03-24-01` and `dashboard.css` to `v=2026-03-24-01`.
- Admin UI: fixed `r` keyboard shortcut refresh on the Hosts and Dashboard panels (was incorrectly triggering a version-check instead of a live data refresh) and on the Logs panel (now only clicks the refresh button of the currently-visible log sub-panel instead of always clicking API logs' refresh regardless of active tab); bumped `dashboard.js` to `v=2026-03-24-02`.
- Admin UI: polished button micro-interactions — dashboard buttons now lift `1px` on hover with a subtle accent shadow (matching the login page's established tactile style) and snap back cleanly on press; transition timing made uniform at `150ms cubic-bezier(0.2,0,0,1)`. Toggle switch thumbs replaced hardcoded dark-blue gradients with a neutral off-state (`#e2e8f0`) and the theme accent gradient for the on-state, so toggles now adapt to both dark and light themes.

# 2026-03-21
- cdx wrapper/setup: replaced the old `Codex Coordinator` startup ASCII art with the new `codex orchestrator` banner in the wrapper and quick-setup flow, then bumped the wrapper to `2026.03.21-02`.
- Admin UI: removed the dead `uPlot` chart path and orphaned assets, leaving the SVG quota/cost history renderer as the only supported dashboard history implementation; cache-bumped the touched admin JS/CSS bundles.
- Admin UI: fixed the `Active Windows` modal again so it respects the server-provided insecure-window active state, keeps closed insecure hosts visible with a `Window closed` status, and allows in-place re-enable/disable actions without leaving the modal.
- cdx wrapper/dev tooling: split the baked wrapper’s large embedded Python/config fragments into dedicated `bin/cdx.d/` subfragments, rebuilt `bin/cdx`, and added repo guardrails for PHPStan, shell linting, dependency-audit, contract tests, and generated-wrapper verification. Wrapper bumped to `2026.03.21-01`.

# 2026-03-20
- Model support: added `gpt-5.4-mini` across the fleet config/admin host override allowlists, config builder, profiles UI, and docs, with `low|medium|high|xhigh` reasoning-effort support; cache-bumped the touched admin JS bundles.

# 2026-03-19
- Admin UI: removed the duplicate secondary page nav strip (`Overview`, `Hosts`, `Logs`, `Settings`, `Users`) from the admin shell, leaving the main header/editorial rail as the only top-level navigation.
- Admin UI/hosts: fixed a `dashboard.js` syntax error in the host detail action bar that stopped the admin bundle from loading; host detail fields such as `WebUI Admin Port` now populate again. Cache-bumped `dashboard.js` to `v=2026-03-19-03`.
- cdx wrapper: hardened root detection for self-update management by falling back to `id -u` alongside Bash `EUID`, and the `Versions` summary now reports the detected UID when Codex update checks are skipped for lack of privileges. Wrapper bumped to `2026.03.19-03`.
- Admin UI: tightened the `Active Windows` modal again so it now shows only currently enabled insecure hosts and active domain allows; disabled host windows and inactive domain entries disappear immediately after refresh/revoke instead of lingering in the quick-action list.
- Admin UI/auth: restored the dedicated upper-right account menu and now bootstrap it directly from the already-authenticated PHP admin session, so the signed-in name, password/passkey links, and logout action no longer disappear from the header when the follow-up `/admin/auth/status` refresh call hiccups.
- Admin UI: fixed the `Active Windows` modal so `Disable all` no longer makes the host rows disappear; insecure hosts now remain visible in the modal after shutdown, show an explicit `Window closed` state, and can be re-enabled in place without leaving the view.

# 2026-03-18
- Admin UI/auth: turned the navbar brand into an account menu with nested theme selection plus `Password change`, `Passkeys`, and `Logout`; moved personal passkey management out of `Users` into new `/admin/account/{password,passkeys}` pages; added self-service `POST /admin/auth/password/change`; and replaced direct logout with a confirmation modal.
- Admin UI: reimagined the insecure-host navbar quick action into `Active Windows`, which now appears only when at least one insecure host window is currently enabled; the modal now lists only active hosts for quick disable, keeps allowed-domain revoke controls, removes the old enable/extend flow, and cache-bumps `dashboard.js`.
- Admin UI: fixed the editorial rail desktop dropdowns so the first pointer click on `Hosts`, `Logs`, or `Settings` now stays open instead of opening on focus and immediately toggling shut; keyboard focus still auto-opens the menus.
- Admin UI: compacted the editorial rail to reclaim vertical space by reducing the header padding, inner frame height, and rail item heights on desktop/mobile, so the navbar wastes less white space while keeping the same flattened menu styling.
- Admin UI: removed the last button/pill chrome from the editorial rail controls so `Hosts`, `Logs`, `Settings`, `New Host`, `Theme`, and logout now render as plain rail text/actions without bordered capsules, separator seams, or shadowed button surfaces.
- Admin UI: flattened the editorial rail further by removing the remaining navbar/flyout box shadows and switching the custom focus treatment from shadow rings to simple outlines, so the whole header reads as one flat surface.
- Admin UI: replaced the previous 2026 navbar with a clean-sheet editorial rail menu system: brand, destinations, utilities, and account controls now sit in one matte rail, desktop flyouts were rebuilt from scratch (`Hosts`, `Logs`, grouped `Settings`), the mobile nav now uses a full-height rail drawer, and the old chip/glass/button-heavy nav controller was retired entirely.
- Admin UI: removed the last pill/bubble treatment from the desktop `Hosts`, `Logs`, and `Settings` dropdown parents so they now sit as plain menu labels inside the unified header bar, with underline/open-state feedback instead of contained chips.
- Admin UI: tightened the 2026 main navbar into one unified menu shell, grouped utility controls into a shared cluster, removed the remaining bubble/pill treatment from primary nav items and header actions, and refreshed the desktop/mobile drawer styling so the whole header reads as one polished system.
- Admin UI: redesigned the top navigation from a row of separate rounded buttons into one unified app menu bar — primary nav items now use bottom-indicator active states instead of pill backgrounds, utility/action controls are visually separated from primary navigation, and the header reads as one cohesive surface rather than a collection of floating controls. Added `aria-current="page"` for active route accessibility.
- MCP/runner security: host-authenticated `/mcp` now exposes only host-safe memory/resource/project tools and no longer advertises or dispatches coordinator filesystem `fs_*` helpers; runner verification payloads were trimmed to the fields the runner actually consumes, and the MCP/runner docs were tightened to match.
- Admin UI: refreshed the 2026 desktop nav into a tighter macOS-style command bar with dropdown menus for Hosts, Logs, and Settings, restored mobile tab fallbacks inside the drawer, and cache-bumped the dashboard stylesheet.
- Admin UI: switched the dashboard shell from hash fragments to real `/admin/...` paths (`/admin/dashboard`, `/admin/hosts/*`, `/admin/logs/*`, `/admin/settings/*`, `/admin/projects/{slug}`, `/admin/users`), updated the path bootstrap/init helpers, and cache-bumped the touched admin JS bundles so reloads and deep links stay in sync.
- cdx wrapper/auth contracts: `/auth` and `/versions` now expose `versions.auto_update_enabled`, and host-level `auto_update_override` now tells `cdx` to skip per-run update checks when cron-managed auto-update is already enabled. Wrapper bumped to `2026.03.18-03`.
- Admin hosts: fixed `/admin/hosts` so it also returns `last_cron_check`, which lets the dashboard host detail show real cron auto-update check-ins instead of falling back to `Never` after successful `cdx --cron` runs.
- cdx wrapper: fixed `cdx --cron` HTTPS verification to reuse the wrapper’s relaxed Python SSL-context setup (`VERIFY_X509_STRICT` fallback disable plus explicit insecure-mode fallback), so cron auto-update checks no longer fail on hosts whose internal CA chain is accepted by curl/OpenSSL but rejected by newer Python TLS validation. Wrapper bumped to `2026.03.18-02`.
- Skills/AGENTS: the server now auto-seeds canonical AGENTS storage from the checked-in repo `AGENTS.md` on boot, so fleet MCP-first skill guidance is actually served instead of drifting in MySQL. Skill/admin/startup-sync payloads now also expose canonical `skill://{slug}` metadata plus fallback paths for clients that need to render the correct preference order.
- cdx wrapper: hardened `cdx --cron` installs by quoting wrapper/log paths, escaping cron `%` semantics, narrowing remove/install matching to the managed/current wrapper entry, degrading cleanly when `flock` is unavailable, retrying `/cron/report`, and failing closed on mismatched platform release assets. Wrapper bumped to `2026.03.18-01`.
- Host pruning: `/cron/check` now records only `last_cron_check`, so stray cron pings no longer refresh host `updated_at` and keep inactive/decommissioned hosts alive.
- Ops: slimmed `scripts/refresh-chatgpt-usage.php` down to quota-refresh work only and switched `quota-cron` health from a DB probe to a heartbeat-driven success signal.

# 2026-03-17
- Admin passkeys: fixed WebAuthn RP ID/origin fallback so admin login now prefers the canonical `PUBLIC_BASE_URL` host/origin when explicit `ADMIN_WEBAUTHN_*` overrides are unset, avoiding request-host drift behind proxies after restarts.
- Admin UI: unified the login page, dashboard shell, and admin access/error screens behind one shared theme layer with local fonts, matching glass surfaces, and themed HTML responses for mTLS/UI load failures.
- Skills/docs/admin: switched fleet guidance to a `cdx`-first model so Skills are now documented as canonical via MCP `skill://{slug}`, with synced `~/.agents/skills/<slug>/SKILL.md` copies treated as fallback-only compatibility files.
- Admin login: switched `/admin/login` to a username-first single-button flow, added `/admin/auth/login/method`, and now require passkey-enabled admins to use passkeys instead of falling back to password login.
- Admin passkeys: hardened passkey login/registration error handling so malformed WebAuthn payloads now return explicit 4xx errors instead of falling through as HTTP 500 `Unexpected error` on the login page.
- Admin hosts: fixed `/admin/hosts` so it returns each host’s `auto_update_override`, which keeps the Cron auto-update toggle from snapping back to the fleet-default visual state right after a save.
- Ops: added `scripts/export_ai_bundle.sh` to export repo-scoped AI debugging bundles for the app, wrapper, and runner surfaces, with canonical docs/tests included and secrets/runtime noise excluded.
- Admin passkeys: hardened WebAuthn policy so registration/login now require user verification (`UV`), login is username-bound via `allowCredentials` instead of username-less discoverable credentials, and registration no longer forces platform-only authenticators.
- Admin passkeys: fixed sign-counter handling so regressions log `admin.auth.passkey.sign_count_regression`, never reduce the stored counter, and still update `last_used_at`.
- Admin passkeys: made WebAuthn challenge consumption transactional/atomic, added explicit `ADMIN_WEBAUTHN_ORIGIN` support, and refreshed admin/API/login/interface docs to match the implemented passkey surface and default mTLS boundary.
- Admin ops: added `scripts/admin-passkeys.php` for Docker/Compose recovery so operators can delete an admin user’s stored passkeys without manual database edits.

# 2026-03-16
- Projects/CoCo: fixed project coordination error handling so missing/disabled project paths return proper HTTP 404/500 responses instead of crashing on reversed `HttpException` arguments, and added MCP `project_create` so `#coco` can bootstrap fresh shared slugs without raw REST fallback.
- MCP skills: `/mcp` now exposes read-only `skill://{slug}` resources for synced Skill manifests, so remote Codex clients can read managed skills like `coco` without assuming a local `~/.agents/...` path.
- cdx wrapper: fixed macOS Bash 3.2 launch paths after the IPv4-proxy wrapper update by avoiding empty `cmd_prefix` / proxy argv array expansion under `set -u`, which previously crashed `cdx ls` and other Codex launches with `unbound variable` before Codex started. Wrapper bumped to `2026.03.16-01`.
- CoCo cleanup: removed the temporary server-side retirement hook for the old `CoCo Toolkit` record and deleted the already-retired legacy DB row, leaving only the managed project-native `coco` skill in code and storage.
- Projects/CoCo cleanup: removed the temporary legacy `/project/*`, `/bootstrap`, `/b/{slug}`, and `/p/{slug}` compatibility routes again so CoCo is once more strictly project-native on `/projects/*`.
- Skills cleanup: the server now auto-retires the old stored `skills.slug = "coco"` / `CoCo Toolkit` database document by signature, leaving the managed project-native `coco` skill as the only active CoCo skill surface.
- Docs/tests: removed the temporary legacy CoCo alias docs again and flipped the router coverage so the new project-native surface stays the only supported path.

# 2026-03-15
- cdx wrapper: extended `force_ipv4` / `cdx -4` so the wrapper now launches Codex behind a short-lived local IPv4-only proxy, making Codex-side `chatgpt.com` traffic honor IPv4-only hosts in addition to the wrapper’s own sync/update calls. Wrapper bumped to `2026.03.15-01`.

# 2026-03-14
- cdx wrapper: fixed `cdx ls` / `cdx lane` on macOS Bash 3.2 by avoiding empty-array argv reset under `set -u`, which previously crashed with `lane_passthrough[@]: unbound variable` before Codex launched. Wrapper bumped to `2026.03.14-01`.
- ChatGPT usage refresh: fixed `scripts/refresh-chatgpt-usage.php` to match the current `AuthService` wiring so the `quota-cron` worker boots cleanly after the Codex version-floor changes and can keep refreshing usage snapshots.

# 2026-03-13
- Codex version policy: added an internal minimum Codex CLI floor at `0.114.0`; fleet and host pins below that are coerced upward, `/auth` and `/versions` now expose `client_version_enforce_exact`, and `cdx` only downgrades when that flag is true for an above-floor exact pin. Wrapper bumped to `2026.03.13-03`.
- cdx wrapper: restored usage capture for Codex `0.114.0+` by resolving the emitted `session id` to `~/.codex/sessions/.../*.jsonl` and reading structured `token_count` usage rows, with fallback to the new `tokens used` footer and the older `Token usage:` line format. Wrapper bumped to `2026.03.13-01`.
- Usage API/docs/tests: `/usage` now leaves `cost=null` when clients only report total tokens without billable input/output/cached splits, preventing misleading `0.00$` run-cost displays while still recording usage totals.

# 2026-03-13
- Projects/CoCo cross-server guardrails: CoCo shared handoffs are now explicitly project-only in the managed `coco` skill, bootstrap payloads, API/admin copy, and MCP docs; host-scoped `memory://...` resources are no longer described as a valid fallback for shared CoCo state.
- MCP memories: reserved keys matching `^coco(?:$|[._:-])` are now rejected with a validation error so cross-host CoCo handoffs cannot be mis-modeled in `mcp_memories`, which remain host-scoped by design.
- cdx wrapper: skill pull sync now removes stale legacy managed copies under `~/.codex/skills/<slug>` so an old pre-project `coco` skill cannot shadow the managed `~/.agents/skills/coco/SKILL.md` rollout on upgraded clients. Wrapper bumped to `2026.03.13-02`.

# 2026-03-12
- Projects/CoCo module: the managed `coco` skill now embeds the native CoCo toolkit/help directly, and project bootstrap payloads now point agents to that skill instead of a separate help page.
- cdx wrapper: managed skills that disappear from the remote list are now pruned locally on sync, so disabling the Projects module removes the auto-managed `coco` skill from clients on their next pull. Wrapper bumped to `2026.03.12-02`.
- Projects/CoCo module: added a native shared-project coordination module with admin + host REST routes under `/admin/projects*` and `/projects*`, covering project creation, about/roster updates, shared notes, todos, files, feedback, and append-only activity history.
- MCP + client rollout: `/mcp` now exposes project-aware tools/resources (`project_*`, `project://{slug}`) when the module is enabled, and enabling the module auto-publishes a managed `coco` skill to Codex clients through the normal Skills sync path.
- cdx wrapper: managed project skills now keep `managed` metadata in the Skill baseline and are skipped during wrapper-side `/skills/store` pushback, so the auto-deployed `coco` skill stays read-only on clients without generating noisy sync errors. Wrapper bumped to `2026.03.12-01`.
- Admin/UI/docs/tests: compressed Settings → Projects into a compact index with Open/Delete actions, moved the full project editors onto a dedicated `#project-detail/<slug>` admin page, marked the managed `coco` skill read-only in the Skills UI, corrected Skill sync copy to `~/.agents/skills/<slug>/SKILL.md`, and refreshed API/admin/MCP/interface docs plus regression coverage.

# 2026-03-11
- Config builder/model default: switched new top-level config drafts and new profile drafts from `gpt-5.3-codex` to `gpt-5.4`, cache-bumped both admin builder assets, and refreshed the config-builder docs/example payloads.
- Config builder/default matrix: changed the fleet config defaults so only `apps` and `multi_agent` stay on by default, while `guardian_approval`, `js_repl`, `use_linux_sandbox_bwrap`, and `prevent_idle_sleep` now start off until explicitly enabled; cache-bumped the admin config builder asset and refreshed docs/tests.
- Config builder/prevent-idle-sleep: added a first-class `Prevent sleep while running` toggle and defaulted `[features].prevent_idle_sleep = true` in normalized/rendered `config.toml`, so Codex keeps the computer awake during active threads unless explicitly disabled; cache-bumped the admin config builder asset and refreshed docs/tests.
- Config builder/guardian approval: added the upstream `Automatic approval review` feature as a first-class toggle, added `guardian_approval` to the supported feature allowlist, and defaulted `[features].guardian_approval = true` in normalized/rendered `config.toml`, so `on-request` approval prompts can be routed through the security reviewer subagent by default; cache-bumped the admin config builder asset and refreshed docs/tests.
- Config builder/bubblewrap: added a first-class Bubblewrap sandbox toggle and defaulted `[features].use_linux_sandbox_bwrap = true` in normalized/rendered `config.toml`, so the new Linux bubblewrap sandbox is enabled fleet-wide unless explicitly disabled; cache-bumped the admin config builder asset and refreshed docs/tests.
- Config builder/js_repl: added a first-class JavaScript REPL toggle and defaulted `[features].js_repl = true` in normalized/rendered `config.toml`, so the persistent Node-backed JS REPL is enabled fleet-wide unless explicitly disabled; admin copy/docs now call out the Node `>= v22.22.0` requirement, and the config builder asset was cache-bumped with refreshed tests.
- Config builder/apps: added a first-class ChatGPT Apps toggle and defaulted `[features].apps = true` in normalized/rendered `config.toml`, so `$` App usage is enabled fleet-wide unless explicitly disabled; cache-bumped the admin config builder asset and refreshed docs/tests.
- cdx wrapper: fixed self-update restart on CentOS 7 / XCP-NG Bash 4.2 by snapshotting the original argc separately from argv, so no-arg wrapper re-execs and lock metadata formatting no longer trip `set -u` on empty-array expansion; wrapper bumped to `2026.03.11-02`.
- cdx wrapper: added `cdx ls` as shorthand for `cdx lane spark` (including `--persist` and passthrough args) so hosts can jump into the Spark lane with a shorter command. Wrapper bumped to `2026.03.11-01`.

# 2026-03-10
- cdx wrapper: interactive SSH sessions now bypass wrapper PTY capture and launch Codex directly unless `CODEX_FORCE_PTY=1`, avoiding stacked-PTY rendering/input issues on hosts like `lims`; `cdx doctor` now reports `ssh-launch=direct-tty|pty-forced`, and wrapper-side usage capture may be unavailable for those SSH runs. Wrapper bumped to `2026.03.10-10`.
- cdx wrapper: removed the interactive SSH keyboard compatibility bridge and the `CODEX_SSH_KEYBOARD_FILTER` toggle, returning SSH launches to the standard PTY/direct execution paths after the bridge caused more trouble than it solved. Wrapper bumped to `2026.03.10-09`.
- cdx wrapper: fixed the SSH keyboard bridge input parser so plain `Enter` bytes are normalized to carriage return and non-CSI-u escape sequences pass through instead of stalling in the pending-input buffer; this restores prompt submission over SSH while keeping arrow/paste-style sequences from wedging input. Wrapper bumped to `2026.03.10-08`.
- cdx wrapper: fixed the SSH Python PTY paths to copy the real terminal window size into child PTYs and forward `SIGWINCH`, preventing Codex from rendering one character per line after the bridge/fallback started the UI on SSH hosts. Wrapper bumped to `2026.03.10-07`.
- cdx wrapper: fixed the interactive SSH keyboard bridge to bind input from `/dev/tty` instead of the heredoc-backed `stdin`, and keep draining the child PTY even if wrapper input goes idle; this stops plain SSH launches from immediately dropping back to the shell on insecure hosts (and other bridge-enabled SSH sessions). Wrapper bumped to `2026.03.10-06`.
- cdx wrapper: fixed insecure-host one-shot runs by deferring `--execute` launch into the normal authenticated startup path (sync/auth/update/gates) instead of short-circuiting before `/auth`; this prevents immediate unauthenticated exits after post-run `auth.json` purge. Wrapper bumped to `2026.03.10-05`.
- cdx wrapper: when a wrapper version update is pending, Codex binary update now defers until the post-restart pass so one invocation no longer installs two different Codex versions back-to-back (for example `0.113.0` then `0.112.0`); wrapper bumped to `2026.03.10-04`.
- cdx wrapper: pre-launch now idempotently force-trusts the active working directory (plus `pwd -P` when it differs) in local `~/.codex/config.toml`, preventing repeated interactive "Do you trust this directory?" prompts after Codex `0.113.0`; wrapper bumped to `2026.03.10-03`.
- Config builder/personality: added root `personality = "friendly"|"pragmatic"|"none"` support to fleet-managed `config.toml`, defaulted new/existing configs to `friendly`, and added optional profile-level overrides that inherit the root value when unset.
- Admin/docs/tests: added a dedicated config-builder personality selector, profile override control, cache-bumped `config.js`/`profiles.js`, updated config/interface docs, and expanded `ClientConfigService` coverage for root/profile personality rendering.
- cdx wrapper: replaced the earlier SSH version pin with an interactive-SSH keyboard compatibility bridge that strips Codex kitty keyboard enable/disable sequences and normalizes CSI-u Enter/Ctrl keys before launch, so prompts submit again over SSH without changing the installed Codex version. `cdx doctor` now reports SSH terminal hints plus bridge state. Wrapper bumped to `2026.03.10-02`.
- Installer/docs/tests: installer no longer downgrades Codex on SSH; wrapper/interface docs were updated for the SSH keyboard bridge, and regression coverage now locks the bridge/doctor strings into the built wrapper and installer template.

# 2026-03-09
- Config retrieve/render fix: `notice.model_migrations` now merges saved maps with default migrations, so legacy stored configs that only had `gpt-5.2-codex -> gpt-5.3-codex` also receive `gpt-5.3-codex -> gpt-5.4` and stop surfacing the interactive GPT-5.4 upgrade chooser.
- Config builder/template defaults: added `notice.model_migrations` mapping `gpt-5.3-codex -> gpt-5.4` (alongside `gpt-5.2-codex -> gpt-5.3-codex`) so Codex `0.112.0+` upgrade prompts are auto-resolved from fleet-managed `config.toml`.
- Admin UI/docs/tests: updated config-builder defaults, cache-bumped `config.js`, refreshed config/interface docs, and expanded `ClientConfigService` assertions for the new migration mapping.
- Codex `0.112.0` compatibility audit: feature normalization now drops removed/unknown `features.*` keys and keeps only currently supported Codex feature flags (while still mapping deprecated `web_search_request`/`web_search_cached` into root `web_search`).
- Admin config UI/docs: replaced stale feature toggles with current valid defaults (`fast_mode`, `unified_exec`, `voice_transcription`, `multi_agent`) and updated feature docs/contracts accordingly.

# 2026-03-06
- Security/wrapper: insecure-host baked `config.toml` no longer persists a reusable managed MCP host API key; secure hosts still use the host API key, while insecure hosts now receive a short-lived MCP bearer token backed by the new `mcp_session_tokens` store.
- cdx wrapper: hardened GitHub release-asset Codex updates by requiring a trusted SHA-256 digest from release metadata before install; missing or mismatched digests now skip the binary update instead of installing unchecked content. Wrapper bumped to `2026.03.06-03`.
- cdx wrapper: fixed deleted-skill startup sync by importing `shutil` in the embedded Python used by `skill_sync_python()`.
- Docs/tests: updated API/config/db/wrapper docs plus regression coverage for insecure-host managed MCP baking, MCP bearer auth wiring, checksum-enforced Codex updates, the new MCP token table, and deleted-skill sync imports.
- Admin dashboard: fixed `/admin/overview` crashing with `HTTP 500 {"status":"error","message":"Unexpected error"}` by restoring the `$pricingModel` closure capture before pricing lookup; added regression coverage for the route signature.
- cdx wrapper: fixed concurrent/read-only quota hydration parsing so missing `chatgpt_usage` payloads no longer break metadata refresh and numeric-string quota fields are accepted, restoring quota bar rendering when usage metadata is returned as strings; wrapper bumped to `2026.03.06-02`.
- Model support: added `gpt-5.4` to the config builder and per-host override allowlists across the API, admin UI, and validation logic, with full `low|medium|high|xhigh` reasoning-effort support.
- Pricing defaults: cost snapshots/backfills/overview calculations now target `gpt-5.4` by default and prefer `GPT54_*` env fallbacks while still honoring legacy `GPT51_*` values for backward compatibility.
- Docs/tests: refreshed interface/install/admin/README notes for the new model and pricing defaults, and added coverage for `gpt-5.4` config validation plus pricing fallback precedence.
- cdx wrapper: help-only invocations now bypass wrapper MOTD/sync/quota/footer noise and pass straight through to the real Codex CLI, so `cdx --help`, `cdx -h`, `cdx help`, and Codex subcommand help (for example `cdx exec --help`) print only upstream help text; wrapper bumped to `2026.03.06-01`.
- Docs/tests: updated wrapper interface/overview docs and added regression coverage for the early help passthrough path.

# 2026-03-05
- cdx wrapper: spark reasoning-summary guard now resolves the effective model from top-level `config.toml` defaults (including explicit profiles that inherit the root model), and execute-mode passthrough selectors (`--model` or `--profile`) now resolve Spark models the same way and inject root/profile `model_reasoning_summary=none` overrides; this closes remaining `reasoning.summary` leaks on both normal and execute paths; wrapper bumped to `2026.03.05-01`.

# 2026-03-03
- Wrapper seeding hardening: `WrapperService` now serves bundled `bin/cdx` as a fallback when `storage/wrapper/cdx` drifts but cannot be overwritten (for example ownership/capability mismatches), and logs an explicit warning instead of silently serving stale wrapper content.
- Tests/docs: added `WrapperService` coverage for non-writable storage fallback and updated wrapper source semantics in `interface-api`/`OVERVIEW` docs.

# 2026-03-02
- cdx wrapper: `cdx lane spark -- --execute "<prompt>"` now honors lane selection in execute mode (profile-first, spark-model fallback) instead of hardcoding `gpt-5.3-codex`, and applies both root/profile spark summary guards to avoid `reasoning.summary` 400s; wrapper bumped to `2026.03.02-04`.
- cdx wrapper: spark summary safeguard now also overrides profile-scoped summary keys (`profiles.<name>.model_reasoning_summary=none`) when a spark model is selected via profile, preventing `reasoning.summary` leaks from legacy profile configs; wrapper bumped to `2026.03.02-03`.
- cdx wrapper: spark summary safeguard is now profile-aware; when `lane spark` (or explicit `--profile`) resolves to a profile whose model is `gpt-5.3-codex-spark`, wrapper injects `--config model_reasoning_summary=none` and avoids OpenAI 400 `unsupported_parameter` (`reasoning.summary`) failures; wrapper bumped to `2026.03.02-02`.
- cdx wrapper: hard-cut Skill sync local path from `~/.codex/skills` to `~/.agents/skills` (baseline moved from `~/.codex/.skill-baseline.json` to `~/.agents/.skill-baseline.json`), and removed flat-file Skill scanning fallbacks so local Skill discovery is directory-only (`<slug>/SKILL.md`); wrapper bumped to `2026.03.02-01`.
- Docs/contracts: updated README, usage/API docs, and wrapper interface docs to reflect `~/.agents/skills` storage and clarify that `/skills/store` persists canonical `SKILL.md` markdown content.
- Tests: expanded wrapper Skill-format assertions to lock `.agents/skills` usage and reject the legacy `.codex/skills` path.

# 2026-02-28
- cdx wrapper: post-run auth push change detection now compares both `last_refresh` and `auth.json` SHA-256 content, so same-timestamp auth/token updates still upload (including concurrent-guard runs) and fleet hosts do not get stranded on stale auth; wrapper bumped to `2026.02.28-02`.
- cdx wrapper: spark summary safeguard now also applies when users explicitly pass `--model gpt-5.3-codex-spark` (not only lane/host model injection), preventing OpenAI 400 `unsupported_parameter` errors for `reasoning.summary`; wrapper bumped to `2026.02.28-01`.
- Docs/tests: updated wrapper reasoning-summary coverage and `interface-cdx` model-summary behavior notes for explicit spark model selection.

# 2026-02-27
- Codex 0.105/0.106 compatibility: config normalization now maps legacy `features.web_search_cached` to root `web_search="cached"` and continues mapping `features.web_search_request` to `web_search="live"`.
- Config builder/runtime cleanup: obsolete feature keys (`steer`, `experimental_windows_sandbox`, `enable_experimental_windows_sandbox`) are now ingest-compatible but removed from normalized/rendered config output.
- Admin config UI: removed obsolete Steer and Windows sandbox switches, added `voice_transcription` feature toggle, and cache-bumped `config.js` to `v=2026-02-27-01`.
- cdx wrapper: when lane/host model injection selects `gpt-5.3-codex-spark`, wrapper now also injects `--config model_reasoning_summary=none` to match current Codex CLI/API behavior; wrapper bumped to `2026.02.27-01`.
- Tests/docs: updated config/wrapper coverage for spark summary handling + obsolete key dropping and refreshed config/wrapper/overview interface docs to match current behavior.

# 2026-02-23
- Security/network trust: added explicit forwarded-header trust gating via `TRUST_X_FORWARDED` + `TRUSTED_PROXY_CIDRS`; client IP and base-url/origin resolution now honors `X-Forwarded-*` only from trusted proxy source IPs.
- Security/host routing: added production-facing `PUBLIC_BASE_URL` policy controls (`PUBLIC_BASE_URL_REQUIRED`, `STRICT_HOST_VALIDATION`) and tightened MCP origin behavior with opt-in request-host auto-allow (`MCP_ALLOW_REQUEST_HOST_ORIGIN`).
- Runner hardening: added optional API->runner shared-secret authentication (`AUTH_RUNNER_SHARED_SECRET` / `RUNNER_SHARED_SECRET`) and hardened auth debug dumps so they require dual opt-in and are disabled in production.
- Crypto/key management: added staged key-rotation support for auth secretbox encryption (`AUTH_ENCRYPTION_KEYS`, `AUTH_ENCRYPTION_ACTIVE_KID`) with backward-compatible decrypt support for legacy ciphertext format.
- Startup/runtime behavior: added `scripts/migrate.php` and boot flags (`RUN_MIGRATIONS_ON_BOOT`, `RUN_BACKFILLS_ON_BOOT`) so schema/backfill work can be moved out of request-path in production.
- Container/deploy hardening: switched compose project naming to `codex-orchestrator`, reduced runtime image packages/extensions, and added compose hardening defaults (`read_only`, `tmpfs`, `cap_drop: [ALL]`, `no-new-privileges`) for API/runner sidecars.
- Admin/UI/docs polish: unified visible product naming on admin pages, self-hosted login fonts (no Google Fonts dependency), refreshed security/install/MCP/runner/interface docs, and expanded regression coverage for trusted-proxy IP resolution, runner shared-secret checks, and encryption key rotation.

# 2026-02-22
- Admin websocket hardening: dashboard live-refresh routing now uses explicit action/domain constants with a codified unknown-action fallback (`overview` + `hosts`), websocket client parsing now validates event envelopes and seeds reconnect cursors from `/admin/ws/info` `last_event_id`, admin dashboard HTML cache-bumped updated `dashboard.js`/`admin-ws.js` assets, and new regression tests now lock script wiring/order plus websocket client/route metadata contracts.
- Startup sync/API: added `POST /sync/status` and `POST /sync/bootstrap` plus `StartupSyncService` to batch startup pull diffs/payloads for prompts, Skills, AGENTS.md, and config; wrapper now attempts bundled startup pull first and falls back to legacy per-resource sync on older servers; added contract schemas/fixtures/tests for both endpoints; wrapper bumped to `2026.02.22-03`.
- cdx/CI: split wrapper monolith fragments (`bin/cdx.d/02-auth.sh`, `bin/cdx.d/05-main.sh`) into ordered concern-focused parts, added a built-wrapper ShellCheck gate (`shellcheck -S warning -e SC2034 bin/cdx`), and added `scripts/verify-wrapper-version-bump.sh` to require `WRAPPER_VERSION` bumps when `bin/cdx` changes; wrapper bumped to `2026.02.22-02`.
- API/docs/testing: added executable interface contracts for critical host responses (`docs/contracts/auth-retrieve.schema.json`, `auth-store.schema.json`, `versions.schema.json`, `usage-ingest.schema.json`) with fixture validation (`tests/ContractSchemasTest.php`), live `AuthService` contract coverage (`tests/AuthServiceContractResponsesTest.php`), auth deny reason contract checks (`tests/AuthReasonContractsTest.php`), and a docs drift gate (`scripts/verify-interface-contracts.php`) wired into CI.
- Installer: `curl .../install/<token> | bash` now ends with a compact post-install quickstart block (`cdx --version`, first `cdx` sync/auth run, and `cdx --execute` example) so hosts get immediate usage guidance at install completion.
- Host registration: insecure `POST /admin/hosts/register` now accepts optional `duration_minutes` (0–480) so newly created/rotated insecure hosts can immediately use the configured allow-window duration instead of always starting from the fixed 30-minute default; admin New Host now sends the current Insecure Host Window slider value and cache-bumps the dashboard asset version.
- cdx: run-lock scope now appends the caller UID (`<installation-or-api-scope>-u<uid>`) so stale root-owned files in `/tmp` do not disable concurrent-guard locking for non-root users on shared hosts; wrapper bumped to `2026.02.22-01`.

# 2026-02-21
- cdx: concurrent-guard runs now still push changed `auth.json` at exit and still report token usage to `/usage`; guard messaging now clarifies only pre-run sync/update mutations are skipped. Wrapper bumped to `2026.02.21-03`.
- Admin config builder: added a `Multi-agents` feature toggle and defaulted `[features].multi_agent = true` in rendered/normalized `config.toml`; cache-bumped `config.js` asset version.
- cdx/config: reserved Codex top-level subcommands from profile shorthand so `cdx cloud|features|...` always passes through to Codex (explicit `--profile <name>` still works for colliding profile names); wrapper bumped to `2026.02.21-02`.
- Config builder: removed deprecated `approval_policy=on-failure` from admin UI and added server-side normalization that auto-migrates stored/rendered root/profile approval policy values from `on-failure` to `on-request`.
- cdx: fixed wrapper self-update restart on macOS/legacy Linux by guarding empty original argv under `set -u` (preserves original args when present, falls back to no-arg re-exec when empty, and hardens lock metadata argv formatting); wrapper bumped to `2026.02.21-01`.

# 2026-02-20
- cdx: fixed run-footer column alignment by keeping the `Run cost` label ASCII-only and moving the Unicode `💰` marker into the cost value text; wrapper bumped to `2026.02.20-02`.
- Admin hosts/logs/settings: left-rail menus now use a nav-height-aware sticky top offset so they remain below the main header bar while scrolling.
- cdx: run-footer cost display now formats `/usage` `data.cost` as two decimals with a trailing dollar sign (for example `0.43$`) on the `Run cost` line; wrapper bumped to `2026.02.20-01`.

# 2026-02-19
- Admin hosts/logs: removed the same outer left/right content gutter as Settings so left rails sit flush to the viewport edge on both pages.
- Admin logs: replaced the old top `API/MCP/Events` selector with a left-rail view selector (matching the new hosts/settings rail pattern) and kept mobile on a sticky segmented selector.
- Admin hosts: replaced the old top `All/Secure/Insecure/Unprovisioned` selector with a left-rail filter box (matching settings rail styling) and kept mobile on a sticky segmented selector.
- Admin settings: normalized settings-panel spacing by removing per-panel top margin inside the settings content column, aligning the main table/panel start line with the left rail.
- Admin settings: aligned the left rail vertical start with page content by restoring a settings-specific sidebar top offset (`top: 16px`) while keeping the outer left gutter removed.
- Admin settings: removed the remaining outer gutter in the Settings view so the left rail aligns to the browser edge (settings-only override for `.app`/`.content` spacing).
- Admin settings: tightened left-rail spacing so the settings nav sits flush at the rail's top-left edge (removed sticky top offset, list gaps, and pill-style item insets).
- Admin settings: flattened the left sidebar menu to a single level (removed the `Advanced` subsection) and removed extra top/left inset spacing so nav items align flush with the rail.
- Admin settings: replaced the flat settings tab row with a cleaner IA (desktop left rail + mobile sticky segmented scroller), while preserving existing `#settings/<tab>` hash routes and panel behavior.
- Admin dashboard: removed the hero copy block (`2026 Mission Control` / `Fleet At A Glance`) from the top dashboard info box.
- Admin hosts: re-added the `🍪` marker in the `Authorized Hosts` list for the host that last submitted the current canonical `auth.json` (`auth_source=true`), restoring quick visual attribution.
- Admin dashboard: replaced the top menu bar with a scoped 2026 navigation layer (`data-nav-version="2026"`) featuring a cleaner desktop command bar, explicit `Overview` entry, and a mobile hamburger off-canvas drawer/backdrop flow while preserving existing nav IDs/actions (`New host`, theme toggle, logout) and hash-based panel routing.
- Admin websocket live updates: expanded push-driven refresh coverage across the full admin SPA (Overview, Hosts/Host Detail, Settings panels, Users, Config Builder, Profiles) using action-targeted `log.created` routing with debounced in-flight guards; dashboard now refreshes host-backed stats with live `/admin/hosts` data, config/profile editors hold unsaved local edits and show a remote-update notice, and settings mutations now emit explicit log actions (`admin.api.state`, `admin.cdx_silent`, `admin.reverse_dns`, `admin.insecure_approval`, `admin.codex_version`, `admin.quota_mode`, `admin.prune_policy`) so connected clients stay in sync via server push.
- Admin dashboard graphs: replaced uPlot modal-first charts with inline Chart.js panels on the main dashboard (quota + cost) including range presets (7/30/60/90/180), zoom/pan, previous-period compare overlays, line/stacked mode toggle, pinned keyboard selection, legend visibility persistence, CSV export, and backend queryable history endpoints (`from`/`until`, interval/group/lane/window filters).
- Auth API: `/auth` `command:"store"` submissions are now always evaluated as candidate auth payloads even when insecure-host windows are closed; retrieve/window gating behavior remains unchanged and store still enforces normal API-key/IP/reverse-DNS/installation plus runner validation checks.
- Admin dashboard: rebuilt the Overview layout for a calmer compact flow (mission strip first, ordered card matrix), consolidated conflicting dashboard CSS layers into one canonical rule set, and normalized equal-height card behavior across ChatGPT usage, KPI cards, and Ops Radar in both light/dark themes with tuned mobile stacking.
- cdx: redesigned end-of-run output into a compact footer (`Run usage`, `Run cost`, `Sync`), removed noisy raw `Usage push | ...` / `Auth push | ...` lines, and added a dedicated `💰` run-cost line populated from `/usage` `data.cost` (ASCII fallback label when Unicode is unavailable); wrapper bumped to `2026.02.19-01`.
- Admin hosts: fully redesigned the `Authorized Hosts` list for lower visual noise; rows now focus on hostname, status, last seen, Codex version, and a single insecure-window toggle (removed IP/added/auth-meta/wrapper clutter from list rows; details remain on host pages).
- Admin hosts: replaced the host detail modal with dedicated host detail pages at `/admin/hosts/{id}` and reorganized the content into visual sections (`Action Items`, `Features`, `Stats`, `Infos`) with deep-linkable URLs.
- Admin routing: added HTML dispatch for `GET /admin/hosts/{id}` through `public/admin/index.php` so direct host detail links resolve without falling through API routes.
- Docs/tests: updated host-detail interface references (`docs/OVERVIEW.md`, `docs/interface-api.md`, `docs/interface-cdx.md`) and added UI routing coverage for the dedicated host detail page shell.

# 2026-02-18
- Skills: added "Checkmk Deploy Verify" skill manifest with `#checkmk` trigger plus mandatory pre/post Checkmk agent verification and Dockerized git-copy workflow guidance.

# 2026-02-16
- cdx: auth summary now reflects successful `store` uploads as `valid` (instead of lingering `upload_required` from the pre-store retrieve result), so healthy hosts no longer look stuck in upload-required state; wrapper bumped to `2026.02.16-12`.
- cdx: Quota `Active lane` now marks Spark with a fastness hint (`spark ⚡` on UTF-8 terminals, `spark (fast)` fallback on non-Unicode terminals).
- cdx: removed the `| <n> day partition` suffix from the Daily allowance note in Quota output; it now shows only `allowance <n>%/day` to reduce line noise.
- cdx: summary packing defaults tuned for readability: Quota now prints one bar/metric per line (`SUMMARY_ITEMS_PER_ROW_QUOTA=1`), while Versions defaults to two entries per row (`SUMMARY_ITEMS_PER_ROW_VERSIONS=2`) to avoid overlong lines (e.g., keeps `AGENTS.md` with `config.toml`).
- cdx: add first-class lane steering via `cdx lane` (`normal|spark`, optional `--persist`, and `clear --persist`), plus host lane persistence endpoints (`GET/POST /host/lane`) and host-level `lane_preference`; wrapper now maps host/command-selected lanes to profile-first (`[profiles.normal|spark]`) with model fallbacks, and wrapper version bumped to `2026.02.16-11`.
- cdx: summary blocks now render aligned padded columns instead of raw tab joins, and Quota defaults to one metric per row (`SUMMARY_ITEMS_PER_ROW_QUOTA=1`) so quota bars line up cleanly across lines; wrapper bumped to `2026.02.16-10`.
- cdx: fixed summary rendering exit-on-start regression caused by tabbed row packing (`set -e` with `(( packed_count++ ))`), aligned quota graph labels, and added non-active lane (Spark/Normal) 5h + weekly bar rows in the Quota block; wrapper bumped to `2026.02.16-09`.
- cdx: compact summary blocks now pack up to three tab-separated entries per line across Health/Versions/Usage/Quota/Result sections (override with `CODEX_SUMMARY_ITEMS_PER_ROW`); wrapper bumped to `2026.02.16-08`.
- cdx: add Linux `yum` fallback support for RHEL-family prerequisite installs (including legacy CentOS 7/8/9 paths), map `script` to `util-linux` for `dnf`/`yum`, and add wrapper package-manager coverage tests; wrapper bumped to `2026.02.16-07`.
- cdx: redesigned the boot summary into human-readable `Health`/`Versions`/`Usage`/`Quota`/`Result` sections, improved quota bar presentation with Unicode+ASCII fallback, condensed non-active quota lane output into an `Other lane` line, and switched insecure clean-sync result text to `Synced on insecure host; auth refreshed.`; wrapper bumped to `2026.02.16-06`.
- Quotas: capture and normalize both ChatGPT quota lanes from `/wham/usage` (normal top-level `rate_limit` plus Spark from `additional_rate_limits`), persist Spark lane columns in `chatgpt_usage_snapshots`, and expose lane-aware payloads (`normal_window`, `spark_window`, `active_quota_lane`) while keeping legacy `primary_window`/`secondary_window` compatibility.
- cdx: quota enforcement is now active-lane aware (`normal` vs `spark`), summaries include lane context + other-lane snapshot, and wrapper auth sync now parses dual-lane quota payloads; wrapper bumped to `2026.02.16-02`.
- cdx: split alternate-lane quota summaries out of `Usage` into dedicated rows (`Quota (Spark@s)` / `Quota (Normal@s)`), so call/token usage stays isolated; wrapper bumped to `2026.02.16-04`.
- cdx: table-summary label width now auto-sizes per render so the `|` separators stay aligned across `Core`, `Usage`, and quota rows; wrapper bumped to `2026.02.16-05`.
- Admin dashboard: ChatGPT usage card and quota history now render both normal and Spark lanes (including Spark history points when available).
- Admin dashboard: restored the legacy two-card quota layout (`5-hour` + `weekly`) and now stacks Spark bars under normal bars inside each card.
- Admin auth UX: replaced dashboard login overlay with a dedicated `/admin/login` page (bright glass UI), added server-side redirects between `/admin/` and `/admin/login` based on session state, and removed password-reset UI/API paths (`/admin/auth/password/request|reset` now return `410 Gone`).
- Admin routing: fixed direct hits to `/admin/login` and `/admin/` that reached `public/index.php` by dispatching both routes through `public/admin/index.php`, preventing `Route not found`.
- Admin config/profiles/host overrides: add `gpt-5.3-codex-spark` with reasoning levels `low|medium|high|xhigh` (UI label: `xhigh (Extra high)`).
- Config/API: enforce strict model allowlist for fleet model fields and `/admin/hosts/{id}/model` overrides (`gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2-codex`, `gpt-5.1-codex-max`, `gpt-5.2`, `gpt-5.1-codex-mini`); dead models are no longer accepted.
- cdx: `--execute` now launches with `--model gpt-5.3-codex` (removed dead `gpt-5.1` default for that path); wrapper bumped to `2026.02.16-01`.
- Ops: manually verified `codex --help` against local Codex `v0.101.0` and confirmed wrapper-injected flags still match the current CLI surface (no runtime flag audit added).

# 2026-02-14
- Config: managed `[mcp_servers.cdx]` entry now includes `startup_timeout_sec = 30` to reduce Codex MCP startup timeouts when the coordinator is slow to respond.
- API: reduce per-request overhead by running schema migrations once per deployed schema hash (sentinel under `storage/wrapper/`), gating legacy encryption/backfill routines behind `versions` flags, avoiding `daily_preflight` DB writes on requests where no preflight work was performed, and skipping runner preflight on `/versions` and `/mcp` (improves `/versions` healthcheck latency and host startup when runner is red).
- Runner: bump the auth-runner bundled Codex CLI to `rust-v0.101.0` and always run probes in a per-request temp `$HOME` (cleaned up after each run) to fix `mcp startup: no servers` probe failures and avoid persisting `~/.codex/auth.json` inside the runner container.

# 2026-02-13
- cdx: Linux prerequisite auto-install now checks/installs `script` (util-linux) alongside `curl`/`unzip` when wrapper-managed dependency installation is allowed, so PTY capture support is provisioned automatically; wrapper bumped to `2026.02.13-18`.
- cdx: concurrent-guard runs now do a read-only `/auth` retrieve (no auth store/local auth write) to keep Quota 5h/week/day lines fresh instead of showing `n/a` from stale local-only state; wrapper bumped to `2026.02.13-17`.
- cdx: when concurrent guard is active, boot summary output is now compacted to a single concurrent-guard line plus quota lines (suppresses Core/Versions/Result noise for that path); wrapper bumped to `2026.02.13-16`.
- Admin dashboard: removed forced desktop horizontal scrolling for table wrappers and tuned Fleet Skill registry column sizing (narrower Description cap + fixed Actions width) so per-skill `Edit`/`Delete` stay visible without horizontal scroll.
- Admin dashboard: hardened Skills/Prompts action-column visibility by making table wrappers horizontally scrollable at all desktop widths and rendering row actions inside a dedicated `.table-actions` container; cache-bumped dashboard CSS/mobile CSS/JS.
- cdx: non-TTY stdout launches no longer rewrite argv by forcing `exec`; wrapper now preserves user subcommands/args verbatim and fails fast with a hint to use `cdx --execute` when interactive no-arg launch is attempted without a TTY; wrapper bumped to `2026.02.13-15`.
- Admin dashboard: fixed Fleet Skill registry action visibility by styling shared `table-wrapper` containers like `table-wrap` (restoring horizontal overflow/layout on narrower screens) and labeling the final Skills column as `Actions` so Edit/Delete controls are discoverable.
- Admin dashboard: Mission Control year label now renders from the live calendar year, removed the embedded Fleet At A Glance subtitle + inline refresh/new-host buttons, and moved the Fleet At A Glance card below the primary dashboard grid.
- cdx: add a host-wide active-run guard to prevent concurrent wrapper mutation storms; secondary runs now skip auth/sync/update writes (and insecure-host auth purge), launch Codex with valid local auth, and support explicit override via `--allow-concurrent-sync`; wrapper bumped to `2026.02.13-14`.
- Admin dashboard: Fleet Skill registry now has a strict edit mode (existing entries open as `Edit skill`, slug is locked during edits to avoid accidental clone-via-rename, save action is labeled `Save changes`, and status feedback distinguishes no-op saves) plus explicit delete actions (`Delete` in table rows and a modal `Delete` button while editing).
- cdx: harden `--uninstall` for multi-user hosts; when additional registered host users exist and the wrapper cannot escalate (`root`/passwordless `sudo -n`), uninstall now fails fast instead of attempting partial cleanup; wrapper bumped to `2026.02.13-13`.
- cdx: honor `NO_COLOR` by disabling ANSI colors even on TTY output, and auto-enable a compact minimal output mode when `TERM=dumb` (suppresses MOTD and prints concise Core/Result summary); wrapper bumped to `2026.02.13-12`.
- cdx: expand Linux prerequisite auto-install package-manager detection to include `pacman`, `zypper`, and `apk` (in addition to `apt-get`/`dnf`), including package-name translation for `python3` on Arch-family hosts; wrapper bumped to `2026.02.13-11`.
- Admin dashboard: removed the Mission Pulse “Action needed” card, moved ChatGPT Account to the top of the dashboard flow ahead of the four KPI cards, and reformatted Ops Radar into a 3x2 desktop grid (with responsive collapse on smaller screens).
- cdx: add wrapper-only `cdx status` and `cdx doctor` commands (no Codex launch) with summary-only and extended diagnostics modes, plus actionable doctor hints and API `/versions` reachability probe; wrapper bumped to `2026.02.13-10`.
- cdx: add a shared embedded Python HTTP utility (`CODEX_PY_HTTP_UTIL`) and refactor auth/prompt/skill/AGENTS/config/usage sync snippets to reuse one force-IPv4 + TLS-context + JSON-request implementation, reducing duplicated network code and drift; wrapper bumped to `2026.02.13-09`.
- cdx: npm-based Codex updates now honor privilege context (`root` direct install, `sudo -n` when available, otherwise user install), aligning update behavior with uninstall handling on root-owned global npm prefixes; wrapper bumped to `2026.02.13-08`.
- cdx: portability hardening for mixed Linux/macOS hosts: replaced GNU-only `sort -V` comparisons with Python-backed version compare, switched ANSI stripping to runtime-detected `sed -r`/`-E`, and replaced direct `sha256sum` calls with a portable hash helper (`sha256sum`/`shasum -a 256`/`openssl`/`python3` fallback); wrapper bumped to `2026.02.13-07`.
- cdx: make local sync writes atomic for `auth.json`, `AGENTS.md`, `config.toml`, and prompt/skill baseline files (`.prompt-baseline.json`, `.skill-baseline.json`) using temp file + `fsync` + replace; wrapper bumped to `2026.02.13-06`.
- cdx: tighten PTY fallback retry guard so direct rerun only happens when the PTY launch failed *and* output matches known TTY-incompatible patterns; avoids accidental second runs on successful commands; wrapper bumped to `2026.02.13-05`.
- cdx: fix non-TTY command dispatch so explicit Codex subcommands are no longer rewritten as `exec ...` (prevents cases like `cdx exec ... | cat` becoming `codex exec exec ...`); wrapper bumped to `2026.02.13-04`.
- cdx: preserve interactive TTY behavior when PTY capture is disabled/fails (avoid `tee` pipe fallback that can trigger `stdout is not a terminal`), and auto-disable PTY capture on hosts where Codex reports TTY-incompatible PTY output (`~/.codex/.cdx_no_pty`, override with `CODEX_FORCE_PTY=1`).
- Admin dashboard: full 2026 visual overhaul for Overview (mission control hero, pulse score, ops radar, richer fleet/cost/runtime cards, and updated mobile layout).
- Admin new host modal: the “Run on the target host” copy button now shows inline feedback (`Copying…`, `Copied`, `Copy failed`).

# 2026-02-12
- Admin config: add `model_provider` and `local_provider` controls to the config.toml builder to match the current Codex CLI flags.
- cdx: refresh bootup summary styling (modern header + divider + wrapped rows) while keeping existing status content.

# 2026-02-11
- Config: add notice model migration defaults to map `gpt-5.2-codex` to `gpt-5.3-codex`.
- Config: add `[security] dangerously_bypass_approvals_and_sandbox` toggle (wired into `cdx` to add `--dangerously-bypass-approvals-and-sandbox` when enabled).

# 2026-02-09
- Fixed admin "Enable window" actions for insecure hosts (host enable/disable + approval approve/deny/allow-domain) returning HTTP 409 due to incorrect route parameter handling.

# 2026-02-06
- Admin config: default model switched to `gpt-5.3-codex` and model pickers now include `gpt-5.3`/`gpt-5.3-codex`.

# 2026-02-08
- Security: remove un-gated `public/admin/mtls-debug.php` endpoint that echoed request headers.
- Security: constrain outbound cURL redirects to HTTPS in pricing + ChatGPT usage fetchers.
- Maintenance: remove unused `src/Http/Router.php` (router isn’t used outside `public/index.php`).
- Admin UI: start visual refresh (new theme tokens for light/dark/auto, header polish, and a sectioned Config layout with search).
- Admin dashboard: add a Fleet Health header with quick actions (refresh, new host).
- Admin hosts: improve table scanability with clearer badges and grouped KPI rows.
- Admin hosts: host detail modal now highlights “Problems” at the top when something needs attention.

# 2026-02-02
- cdx: pick `script` flags per platform and only run PTY capture when stdin/stdout are TTYs (fixes macOS `script` errors).
- cdx: avoid `script -c` on macOS and guard wrapper restart args to prevent unbound variable crashes.
- cdx: avoid unbound `SCRIPT_SUPPORTS_C` by keeping script detection out of subshells.

# 2026-02-01
- cdx: macOS compatibility for installer + wrapper (apple-darwin assets, Homebrew auto-install for missing python3/curl/unzip, bash 3.2-safe wrapper).

# 2026-01-31
- Admin auth: rehash admin passwords on successful login when hashing params change.
- Admin auth: reject password-reset emails with suspicious header injection input.
- Admin dashboard: remove unused WebAuthn helper code paths.
- Admin config: replace `web_search_request` with `web_search` (live/cached/disabled), while keeping legacy mapping for existing configs.
- Admin config: render `web_search` at the top level (string enum) instead of under `[features]` to match current Codex config schema.

# 2026-01-30
- cdx: add `-4` flag to force IPv4 for all wrapper network calls (sync, usage, update/download).

# 2026-01-28
- Admin config: render `steer = true|false` under `[features]` in fleet config.toml.
- Config: bake a trusted-project stanza into per-host config.toml using the caller's username/home to suppress Codex trust warnings.

# 2026-01-26
- cdx: honor `force_ipv4` for Python-based sync/usage HTTPS calls so IPv4-only hosts don't stall on IPv6.
- Insecure hosts: allow long-running sessions to upload refreshed auth after the window closes (bounded by `INSECURE_SESSION_MAX_MINUTES`).
- Admin hosts: add a 🍪 badge for the host that last submitted the current auth.json.
- Admin config: add steer conversation toggle (default on) to render `steer = true` in fleet config.toml.
- Admin config: move the Steer conversation toggle into the Security & Features card.
- Admin dashboard: move the Estimated total trend control into a 📊 icon beside the currency label.
- Admin hosts: move the status pill into a Status column and swap the insecure toggle to an iPhone switch.
- Admin hosts: stop showing "Pruning soon" when host pruning is set to never.
- Admin hosts: show insecure enabled hosts as Can login/Outdated instead of Locked.
- Insecure domain auto-allow rules now auto-revoke once their window expires.
- Admin memories: add delete button alongside each memory row.
- Admin memories: reveal delete buttons on row hover or focus.

# 2026-01-25
- Admin hosts: allow per-host AGENTS.md version pinning in the host modal (default follows fleet setting).
- API: add per-host AGENTS.md override field and endpoint for host-specific pins.
- Admin agents: prompt for a replacement version when deleting AGENTS.md versions that are pinned by hosts.
- Admin agents: show how many hosts are pinned to each AGENTS.md version.
- Admin agents: replace “pin” wording with “default” in AGENTS.md editor copy.
- Admin host modal: swap Reverse DNS to an iPhone-style toggle and place it beside the Codex CLI version picker.
- Docs: emphasize admin login in install/usage guides and treat mTLS as an advanced topic.
- Admin hosts: hide the “Locked” health pill in the host table.
- Admin hosts: collapse host-table status chips to a single pill.
- Admin dashboard: center the summary cards and shorten the wrapper check timestamp text.
- Admin hosts: color the Outdated pill green when auth is current and orange when auth is stale.
- Admin hosts: fix host-tab active state contrast in dark mode.

# 2026-01-19
- Skills: added "Git Commit" skill manifest to the fleet registry.
- Skills: added "Checkmk Local Checks" skill manifest to the fleet registry.
- AGENTS.md: added versioned storage with pinned vs latest serving, plus delete controls in the admin editor and new admin endpoints.

# 2026-02-10
- Skills: added "SSH Login" skill manifest to the fleet registry.
- Admin new host modal: "Run on the target host" command box now follows theme toggle (light/dark/auto); cache-bumped dashboard.css.
- Admin UI: normalized settings, usage charts, and mobile cards to theme tokens so light/dark/auto stays consistent; cache-bumped dashboard.css/dashboard-mobile.css.

# 2026-01-18
- Admin dashboard: toast notifications now honor light/dark/auto theme colors; cache-bumped dashboard.css.
- Admin dashboard: 2026 polish pass (bullet meters + theme toggle w/ auto light/dark tokens + softer usage window sections + restored overpay note); cache-bumped dashboard.css/dashboard-mobile.css/dashboard.js.
- Admin dashboard: 2026 visual pass (calmer background, no outer mega-card, split Hosts/Version, consistent focus ring + typography); cache-bumped dashboard.css/dashboard-mobile.css/dashboard.js.
- Admin UI: switched admin pages to a ChatGPT-style dark theme.
- Admin dashboard: restyled the Estimated Total cost card for a cleaner plan/utilization layout.
- Admin dashboard: combined Hosts, Version, and Validation Service into one summary card.
- Admin header: show "Christian Reiss 🔐" in the header and make the lock icon the logout action.
- Admin settings: moved mTLS status to Settings → General and removed the header pill.
- Admin logs: fixed `#logs` deep link so only logs render (dashboard panel now stays hidden).
- Admin dashboard: merged input/output/cached tokens into a single summary box and removed the redundant total tokens card.
- Admin header: removed the Dashboard nav item; the Codex Coordinator logo now routes to the dashboard.
- Admin dashboard: unified visual overhaul (palette, typography balance, reimagined command bar, refreshed main dashboard layout, cards, tables, and modals); cache-bumped dashboard.css/dashboard-mobile.css.
- Admin header: display the logged-in user name next to mTLS status; cache-bumped admin-auth.js and dashboard.css.
- Admin users: show relative last login timestamps below the absolute date in the Users table; cache-bumped users.js and dashboard.css.
- Admin users/login: require password confirmation in reset and user password flows; cache-bumped admin-auth.js and users.js.
- Admin users: remove the add/edit user modal close button (use Cancel or backdrop instead).
- Admin users: hide the "Wipe users" button until at least one user exists.
- Admin users: switch the Active toggle in the user modal to the iPhone-style switch.
- Admin login: show password recovery panel under the login modal (no longer hidden behind the overlay); cache-bumped admin-auth.js and dashboard.css.
- Admin: add admin login, user management, roles, and password recovery (userless bootstrap when no admins exist).
- Admin: insecure approval modal now uses the current insecure window duration when enabling hosts.
- Admin dashboard: insecure hosts modal live-updates via websocket events and refreshes countdowns while open.
- Installer: stop auto-running `cdx` after curl | bash; users run it manually when ready.
- Admin UI: refined the dark palette to better match ChatGPT's dark theme (neutral backgrounds, subdued surfaces).
- Admin UI: reverted palette to the original colors while keeping the new layout.
- Admin dashboard: removed the "over/under plan" copy so Estimated Total is a straight plan comparison.
- Admin header: moved the logged-in name to the far-right slot in the menu bar.
- Admin dashboard: centered the Estimated Total amount in the cost card.
- Admin dashboard: shortened the Validation line in the summary card to a compact status/timestamp.

# 2026-01-15
- Admin dashboard: fallback to SVG rendering when uPlot fails so history charts still load.
- cdx wrapper: surface reverse DNS denial reason in auth sync output; wrapper bumped to 2026.01.15-01.
- Auth: add reverse DNS enforcement for `/auth` (global setting with per-host overrides); requests now require forward A/AAAA + PTR match when enabled.
- Admin dashboard: add Reverse DNS Enforcement toggle + per-host override selector; cache-bumped dashboard.js v=2026-01-15-01.
- Installer: Unknown / not found in code (current installer prints manual next-step `cdx` commands and does not auto-run `cdx`; superseded by 2026-01-18 installer behavior).
- Auth: add trailing insecure-host grace window for final auth/usage pushes after the window expires (configurable via `INSECURE_GRACE_MINUTES`, default 60); explicit disable clears grace.
- Admin dashboard: refine uPlot usage + cost charts with consistent tick splits and hide the default legend; cache-bumped dashboard.js v=2026-01-15-03 and dashboard-mobile.css v=2026-01-15-01.
- Hosts: rename stored IP columns to `ip4`/`ip6` (auto-migrated from legacy `ip`/`ip_alt`), and surface the new fields in admin API/UI.

# 2026-01-14
- Auth: allow secure dual-stack hosts to bind one IPv4 + one IPv6 without enabling roaming; admin UI now shows the secondary IP when present.
- Admin insecure approvals: allow domain auto-allow rules (modal action + toggler revoke) so matching subdomains can auto-open insecure windows.
- Admin dashboard: remove the ChatGPT Account refresh button (websocket/live refresh remains).
- Admin insecure approvals: clicking outside the approval modal or pressing Esc now cancels the request to avoid stuck pending approvals.

# 2026-01-13
- Admin dashboard: remove per-host Codex version row from the host detail modal (fleet always uses the latest wrapper).
- Admin dashboard: ChatGPT 5‑hour/weekly reset timers now tick locally between refreshes, keeping “Resets in …” and time meters live.
- Insecure hosts: optional admin approval gate (Settings → General) that prompts via websocket, exposes approve/deny endpoints, and lets cdx wait/poll for approval when the window is closed.
- cdx wrapper: wait/poll for insecure host approvals when enabled; wrapper bumped to 2026.01.13-02.
- Admin dashboard: filter “CDX refused” toasts to known hosts/fqdns to avoid noise from unknown keys.
- Admin dashboard: emit “CDX refused” toasts for denied `/auth` requests tied to known hosts (disabled host, IP mismatch, installation mismatch, insecure window closed).
- Admin dashboard: “CDX authorized” toasts now include relative time in the message.
- Admin dashboard: emit “CDX authorized” toasts on successful `/auth` retrieve (websocket test hook).
- Admin dashboard: add websocket-driven toast framework (auto-dismiss + manual close), new `/admin/toasts` endpoint, cache-bumped dashboard.js v=2026-01-13-03 and dashboard.css updated.
- Admin dashboard: Overview info cards live-update via websocket events (hosts, versions, tokens, cost, runner, ChatGPT); cache-bumped dashboard.js v=2026-01-13-02.
- Admin dashboard: ChatGPT 5-hour/weekly usage boxes live-update via websocket events; cache-bumped dashboard.js v=2026-01-13-01.
- Admin: add optional websocket event stream for live dashboard updates (`admin_events` table, `/admin/ws/info` bootstrap, `scripts/admin-ws.php`, admin-ws.js hook).
- Admin dashboard: remove hover lift on header nav buttons (menu bar, Toggler, New host); cache-bumped dashboard.css v=2026-01-13-03.
- Admin dashboard: remove button glow across all hover states; cache-bumped dashboard.css v=2026-01-13-02.
- cdx wrapper: disable prompt-toolkit cursor position reports under PTY capture unless the env is already set, avoiding interactive cursor errors on some terminals; wrapper bumped to 2026.01.13-01.
- cdx wrapper: compress the Result line on clean insecure-host runs to reduce repeated noise; wrapper bumped to 2026.01.13-03.
- Ops: add docker-compose `admin-ws` service and document enabling `ADMIN_WS_ENABLED` for live admin toasts/websocket updates.

# 2026-01-12
- cdx wrapper: enforce baked FQDN at runtime (override with `CODEX_ALLOW_FQDN_MISMATCH=1`), bumped wrapper to 2026.01.12-01.
- Admin hosts: add “Disable all” in Insecure hosts modal and hide bulk actions unless ≥2 active insecure hosts; cache-bumped dashboard.js v=2026-01-12-02.
- Admin hosts: fix the Insecure hosts “Extend all” button (binds reliably, shows how many hosts were extended) and cache-bump dashboard.js v=2026-01-12-01.
- Config builder: clamp verbosity to “medium” for gpt-5.1-codex-max (UI and server), avoiding unsupported text.verbosity values.
- Auth: insecure hosts now rebind their stored IP to the current client when the insecure window (or grace) is active, eliminating “IP bound” failures after toggling; logs emit `auth.insecure_ip_override`.

# 2026-01-08
- Admin dashboard: cost total stays neutral when API spend is below plan, and the overpay callout is shortened to "Overpaying by X%!"; cache-bumped dashboard.js v=2026-01-08-04.
- Admin dashboard: cost over‑plan callout uses neutral styling and explains the API-vs-plan mismatch; cache-bumped dashboard.js v=2026-01-08-03.
- Admin hosts: remove avg/last refresh subline from the Hosts header; cache-bumped dashboard.js v=2026-01-08-02.
- Admin auth: add a one-time seed command (curl | bash) that uploads local `~/.codex/auth.json` via `/seed/auth/{uuid}`; tokens expire after `AUTH_SEED_TOKEN_TTL_SECONDS` (default 900s) and invalidate on first POST; new `auth_seed_tokens` table + admin UI wiring; cache-bumped dashboard.js v=2026-01-08-01.

# 2026-01-07
- Admin hosts: insecure window duration now supports a log-ish 0–8h (0–480 min) range for enable actions; API clamping updated; cache-bumped dashboard.js v=2026-01-07-01.

# 2025-12-25
- Admin config builder: added background terminal experimental feature toggle; cache-bumped config.js v=2025-12-25-03.
- Admin hosts: pruning indicator now honors Settings → General inactivity window (0 disables) instead of hard-coded 30 days; cache-bumped dashboard.js v=2025-12-25-02.
- Admin config builder: added switches for Codex 0.77 experimental feature flags (unified exec, RMCP OAuth, sandbox assessment, ghost commit, Windows sandbox); cache-bumped config.js v=2025-12-25-01.

# 2025-12-19
- Admin config builder/profiles/host overrides: add `gpt-5.2-codex` as a selectable model with low/medium/high/xhigh reasoning; server now forces reasoning summaries to `detailed` for that series just like other codex-specific models.
- cdx wrapper: detect Codex versions that lack `--reasoning-effort`, skip passing the flag, and emit a warning instead of failing the launch; wrapper bumped to 2025.12.19-01.

# 2025-12-18
- cdx wrapper: remove the duplicate insecure-host bootstrap warning and collapse the insecure-host result summary to "Codex to brrrr (insecure host)"; wrapper bumped to 2025.12.18-06.
- cdx wrapper: preserve argv across wrapper self-update restart so `cdx resume` (and other non-flag first args) survive the re-exec; wrapper bumped to 2025.12.18-05.
- Installer: choose the musl (static) Codex release asset on older glibc (<2.39) so CentOS 7 / Debian 11-class hosts don’t require `libssl.so.3`.
- Admin hosts/installer: “Allow insecure curl (-k)” now persists as a per-host `curl_insecure` flag and bakes `CODEX_SYNC_ALLOW_INSECURE=1` into the `cdx` wrapper (disables TLS verification for sync when you intentionally run self-signed); installer still bakes `CODEX_INSTALL_CURL_INSECURE=1` into the piped `bash` so wrapper + Codex downloads reuse `curl -k`; cache-bumped dashboard.js v=2025-12-18-02.
- Installer: use `cdx --wrapper-version` during install so it doesn’t run a full sync/codex launch (avoids surprising SSL failures during bootstrap).
- cdx wrapper: guard the Usage summary `token_bits` join so runs under `set -u` don’t crash with `token_bits[@]` unbound (affects hosts before the first token usage sync), fix baked-placeholder sentinels so per-host overrides (`model_override`, `reasoning_effort_override`, `force_ipv4`, `secure`, `installation_id`, `cdx_silent`) don’t get reset after baking, and allow wrapper self-update to pass `curl -k` when `CODEX_SYNC_ALLOW_INSECURE=1`; wrapper bumped to 2025.12.18-04.

# 2025-12-17
- Admin settings: Skill modal now shows validation/saving status inline, so slug/manifest errors are visible instead of hiding underneath the Fleet Skill registry panel.
- Admin settings: Fix the Fleet Skill registry “New” button so it always opens the modal and surfaces an error when the manifest input is missing instead of silently doing nothing.
- Admin settings: Fleet Skill registry now lives under Settings → Skills (tab after Profiles); the standalone `#skills` hash redirects to `#settings/skills`, and dashboard.js is cache-bumped to v=2025-12-17-04.
- Skill system: new `/skills` endpoints + `skills` table mirror slash-command behaviors (list/retrieve/store/delete) with `SkillService`, admin dashboard gets a Skills tab + modal editor, `cdx` syncs `~/.codex/skills` (pull + push) with offline-safe baselines, docs/README updated, and wrapper bumped to 2025.12.17-01.

# 2025-12-15
- Config builder: clamp `model_reasoning_summary` to `detailed` for `gpt-5.1-codex*` (OpenAI only accepts `reasoning.summary=detailed`); cache-bumped config.js v=2025-12-15-20.
- Admin hosts: added “Temporary host” provisioning (`POST /admin/hosts/register` body `temporary=true`) with a sliding 2-hour idle expiry (pruned 2h after the last successful host contact), backed by `hosts.expires_at` and `host.pruned` reason `expired`; cache-bumped dashboard.js v=2025-12-15-20.
- cdx wrapper: fixed token-usage parsing crashing on Python 3.9 (AlmaLinux 9) due to Python 3.10-only type hints (`str | None`); wrapper bumped to 2025.12.15-03.
- cdx wrapper: fixed `cdx --uninstall` failing (cmd_uninstall was invoked before the wrapper had defined its helpers); wrapper bumped to 2025.12.15-02.
- Installer: fixed insecure host registration emitting install tokens without an API key (which could 500 on `curl .../install/<token> | bash`).
- cdx wrapper: suppress duplicate boot summary/compat lines when the wrapper self-updates and re-execs (you now only get one header); wrapper bumped to 2025.12.15-01.

# 2025-12-14
- Admin settings/memories: wired the delete action to the numeric memory `record_id` (UI buttons now work, show host/key metadata, and disable when missing), documented the admin delete endpoint/field, and cache-bumped dashboard.js v=2025-12-14-13 + dashboard.css v=2025-12-14-11.
- Admin settings/memories: fixed the Memories tab not rendering (bad JS wiring + missing DOM ref). Loader now targets the Settings → Memories panel, wires `memoriesTableWrap`, and host filter passes `host_id`; cache bump to dashboard.js v=2025-12-14-12.
- Admin settings: fixed Settings → config.toml (and other settings tabs) sticking around when navigating back to the dashboard (HTML nesting bug: Settings panel-set was closed early).
- Admin settings/profiles: profile rows are now collapsed by default (click to expand) and the per-profile feature toggles render in a 2×2 grid; cache bump to dashboard.css/profiles.js v=2025-12-14-10.
- Admin dashboard: Validation Service card now shows the host that last wrote the current canonical auth.json (source FQDN + stored time); cache bump to dashboard.js v=2025-12-14-07.
- cdx wrapper: boot summary now shows MCP status, shortens Runner to icon-only, and moves the week-partition indicator from Core → Quota day; wrapper bumped to 2025.12.14-03.
- Admin settings/hosts: Codex Version selectors now omit GitHub prereleases (alpha/beta) and only list full releases, while still including the currently targeted/pinned/in-use version for visibility; cache bump to dashboard.js v=2025-12-14-04.
- Admin hosts: removed all row background coloring in the Authorized Hosts table (rows are now transparent; no secure/insecure/unprovisioned shading); cache bump to dashboard.css/dashboard-mobile.css v=2025-12-14-08.
- Profiles: added a Settings → Profiles tab to add/edit/delete `config.toml` profiles (model, reasoning effort, approval policy, sandbox mode, plus stream/search/image/network toggles). Config builder no longer embeds profile editing; per-profile TOML now includes nested `[profiles.<name>.features]` + `[profiles.<name>.sandbox_workspace_write]`. `cdx <profile>` is now shorthand for `--profile <profile>` when the profile exists; removed the old `cdx shell`/`cdx code` model presets; wrapper bumped to 2025.12.14-03; cache bump to dashboard.js/config.js/profiles.js v=2025-12-14-06.

# 2025-12-13
- Admin hosts: added per-host Codex CLI version override (“Global” or pinned semver) that overrides the fleet policy; pinned hosts get `client_version_source=locked` so `cdx` enforces the exact version; cache bump to dashboard.js v=2025-12-13-09.
- Admin settings: added a Codex version selector (Latest/recent releases) that can pin the fleet to a specific Codex release; when pinned (`client_version_source=locked`) the `cdx` wrapper enforces the exact target version (upgrade or downgrade); wrapper bumped to 2025.12.13-02; cache bump to dashboard.js v=2025-12-13-08.
- Config builder: fixed `config.toml` generator settings “disappearing” when `client_config_documents` had non-canonical/legacy rows (prefer `id=1` when present, tolerate double-encoded JSON settings).
- Admin hosts: when a host is flagged “Outdated auth”, the “Can login” chip is now suppressed (no more contradictory status); cache bump to dashboard.js v=2025-12-13-04.
- Admin access: fixed `requireAdminAccess()` enforcing `ADMIN_ACCESS_MODE=mtls` (removed stale `mtls_only` check) so `/admin/*` is denied when mTLS headers are missing.
- Admin hosts: hosts table row backgrounds now use a single neutral zebra stripe (removed status-based row gradients); cache bump to dashboard.js v=2025-12-13-03.
- Config sync: `/config/retrieve` now applies per-host `model_override` + `reasoning_effort_override` to the baked `config.toml` (`model`, `model_reasoning_effort`) so `~/.codex/config.toml` matches the host’s effective defaults.
- Admin hosts: model/reasoning overrides now auto-save on select (no Save button) and are baked into the per-host `cdx` wrapper download; wrapper bumped to 2025.12.13-01; cache bump to dashboard.js v=2025-12-13-02.
- Admin hosts: fixed `/admin/#hosts` deep link scrolling the Authorized Hosts table to the top (hiding the All/Secure/Insecure tabs); cache bump to dashboard.css/dashboard.js v=2025-12-13-01.
- Admin insecure-hosts “Toggler” modal: fixed enabled hosts showing “Online: expired” by returning timezone-aware `insecure_enabled_until` timestamps from `/admin/hosts/insecure`.
- Admin settings: fixed Canonical AGENTS.md panel leaking onto the Dashboard after navigating away from Settings → Agents (HTML nesting bug).

# 2025-12-12
- Admin dashboard: Estimated Total now auto-selects Plus/Pro from the ChatGPT usage stats; removed the manual plan toggle buttons; savings badge is now inline (“X% Saved!”).
- Admin hosts: fixed the Insecure Hosts “Toggler” enable button requiring two clicks by using the server-provided active flag for toggle state.
- Ops/debug: `public/mtls-debug.php` now returns 404 unless `CODEX_DEBUG=1`.
- Auth runner: probe now uses `-s read-only` and no longer bypasses approvals/sandbox.
- Repo: filled GPLv3 appendix placeholders in `LICENSE` with 2025 + Christian Reiss.
- Admin settings: configurable inactive-host pruning window (0–60 days) now overrides `INACTIVITY_WINDOW_DAYS`.
- Admin logs: Client Reports cost column now rounds to 2 decimals; cache bump to logs.js v=2025-12-12-04.
- Admin hosts: VIP indicator is now a plain 👑 (no badge/pill) in the Authorized Hosts list and host detail modal; cache bump to v=2025-12-12-03.
- Admin dashboard: added Plus/Pro plan pricing (`CHATGPT_PLUS_PLAN_COST`, `CHATGPT_PRO_PLAN_COST`) and color-coded monthly “Estimated Total” vs plan with a “% saved this month” badge.
- Admin access: removed `ADMIN_REQUIRE_MTLS`/`DASHBOARD_ADMIN_KEY` and standardized on `ADMIN_ACCESS_MODE=mtls|none`.
- Admin access: accept colon/dash formatted mTLS fingerprints from proxies (normalize to hex before validating).
- Admin config builder: fixed “Save & Deploy” HTTP 422 sha mismatch when saving immediately after edits (stale preview SHA); the save flow now uses the *saved* sha for optimistic concurrency (instead of the preview hash), and admin assets are cache-busted so browsers actually pick up the fix.
- Admin insecure-hosts “Toggler” modal now shows remaining online time under enabled host FQDNs.
- Removed admin passkey/WebAuthn system: deleted passkey endpoints, DB table, dashboard UI, and related dependencies. Admin access is now enforced via mTLS only (`ADMIN_ACCESS_MODE=mtls`).
- Config builder UI now shows the actual save error (HTTP status + validation details) instead of only “Save failed”.
- Admin config builder: hide `codex-coordinator` from the “Configured MCP servers” list so only operator-added MCP servers are shown (managed entries remain injected per-host).
- cdx wrapper: when `[otel]` is present in `config.toml`, export `OTEL_*` env vars before launching `codex` so traces can be shipped via OTLP without per-host glue.
- Admin Agents: AGENTS.md now always renders the full file contents, and the Edit button opens a working editor modal (previously the modal markup was missing).
- Admin Agents: replaced the modal editor with inline click-to-edit and a dedicated Save button on `#settings/agents`.
- Admin hosts: add per-host `cdx` model + reasoning-effort overrides (defaults to the fleet-wide config when unset).

# 2025-12-10
- Passkey enrollment/auth now accepts base64url (no more "invalid character" errors) and tolerates http/https origins for the resolved host; client `id` serialization aligns with rawId.

# 2025-12-08
- Settings consolidated into a single tabbed page (Settings/Agents/Slash commands/Memories/config) via embedded subpages; header menu now links directly to Settings. Cache bump to dashboard.css v=2025-12-08-22.
- Settings tabs now inline real content (Agents/Prompts/Memories) instead of iframes; config builder still uses config.js but lives in-page. Header menu still flat. Cache bump to dashboard.css v=2025-12-08-29.
- Added hero/info boxes to Hosts and Settings to match Logs (title + subtitle, no extra controls).
- Settings tabs wired with embed-aware nav (nav.js cache bump to v=2025-12-08-06) so each tab loads its page without showing nested headers.
- Dashboard hero/info box removed; tightened spacing between nav, menu, cards, quota section, hosts and logs bottom padding; cache bump to dashboard.css v=2025-12-08-21.
- Logs dropdown removed (plain link), added on-page tabs for Client vs MCP logs, and cache bumped to dashboard.css v=2025-12-08-17.
- Hosts UI merged into a single page with on-page tabs (All/Secure/Insecure/Unprovisioned), hosts menu entry is now a simple link (no dropdown), and assets cache-bumped to v=2025-12-08-16 / dashboard.js v=2025-12-08-06.
- Header nav simplified to plain text (no pills, no hover fill, no underline), dropdown kept minimal, and lower menu hidden; cache bump to v=2025-12-08-15.
- Admin nav underline forced neutral (no shadows/gradients) and cache bumped to v=2025-12-08-13 to squash lingering green glow on Hosts/Logs/Settings dropdown triggers.
- Admin nav dropdown triggers stripped to plain text (appearance reset, no background image/shadow/filter) with another cache bump to purge lingering green glow on Hosts/Logs/Settings.
- Admin nav pill styles fully removed (no hover background/green glow); dropdown links now sit above content and use underline-only active state.
- Admin nav bar restyled to a flat, square, underline-only look (no neon pills/shadows), with neutral dropdowns and a fresh CSS cache buster so the new styles load immediately.
- Admin nav bar flattened to plain text links with square hover dropdowns (no gradients/shadows, dropdowns sit flush under the trigger) so Hosts/Logs/Settings stop looking like glowing bubbles.
- Added dedicated admin pages for Hosts, Memories, Settings (alongside existing Agents/Prompts/Logs) so every menu item opens a real subpage instead of query-driven views.
- Dashboard cost cards moved out of the ChatGPT section: input/output/cached token totals and estimated total USD now show as top-level info boxes alongside Hosts/Versions/Tokens (with cost trend button).
- Admin dashboard hero is back (Dashboard · Fleet overview) with a square, flush menu bar (`Overview/Hosts/Logs/Agents/Slash commands/Memories/Settings`) wired to the existing `?view=` routes; active highlighting now covers the new tabs.
- Admin dashboard: split AGENTS.md and Slash Commands into dedicated pages (`/admin/agents.html` and `/admin/prompts.html`) instead of embedding them on the dashboard/hosts views; navigation links now point to the standalone editors.
- cdx quota summary now lists 5h, day, and week in that order (aligning with the daily allowance view) and bumps wrapper to 2025.12.08-01.

# 2025-12-07
- Added Quota Policy week partition (Off/7d/5d) that splits the weekly ChatGPT window into a daily allowance; `/admin/quota-mode` + `/auth` now carry `quota_week_partition`, dashboard gets a selector, and `cdx` shows a third quota bar that obeys warn/deny policy.
- Admin MCP access log table now shows UTC timestamps as `dd.mm.yyyy, hh:mm:ss`, resolves host IDs to FQDNs, and opens a detail modal when you click a row so you can inspect request/error context without squinting at the list view.
- Admin config builder: fixed change detection so settings-only updates (e.g., toggling managed MCP injection) persist even when the rendered TOML hash stays the same; the UI now sends the rendered sha256 on save, keeps the blank reasoning-summary option truly blank, and hides the managed `cdx` MCP entry just like other reserved servers.
- MCP streamable HTTP now advertises underscore tool names (`memory_store|memory_retrieve|memory_search`) that satisfy the MCP/OpenAI tool regex (`^[a-zA-Z0-9_-]+$`); dot aliases remain accepted for calls, and coverage was added to guard the naming rules.
- MCP resource browsing/templates added: `/mcp` now implements `resources/templates/list`, `resources/list`, and `resources/read` for host memories (`memory://{id}` URIs, text/plain), so MCP clients can enumerate or fetch stored notes.
- MCP `memory_store` now accepts a bare string payload in MCP `tools/call` (`arguments: "note text"`), wrapping it as `content` for convenience; still validates full object bodies.
- MCP `memory_search` also accepts a bare string payload and maps it to `query`, so `arguments: "foo"` works alongside the object form.
- Added MCP method aliases `list_tools`/`call_tool` (and dot variants) plus capability flags (`tools.list`/`tools.call`) so clients using either naming scheme are supported.
- Added MCP aliases for resource templates: `list_resource_templates` and `resources.templates.list` now map to `resources/templates/list`.
- Added MCP resource creation (`resources/create`, aliases `resources.create` and `create_resource`) that writes `memory://{id}` URIs to the memory store from text content.
- Added MCP aliases for resource listing: `list_resources` and `resources.list` now map to `resources/list`.
- Added MCP aliases for resource reading: `read_resource` and `resources.read` now map to `resources/read`.
- Added MCP resource update (`resources/update`, aliases `resources.update` and `update_resource`) to overwrite a `memory://{id}` with new text content.
- Added MCP resource delete (`resources/delete`, aliases `resources.delete` and `delete_resource`) which overwrites the memory with empty content to mark deletion; true DB delete can follow later if desired.
- Added MCP tool `fs_read_file` (alias `fs.read_file`) to read text files rooted at the app directory; includes path normalization and outside-root guard.
- Added MCP tool `fs_write_file` (alias `fs.write_file`) to write text files under the app root with create/overwrite flags and path escape protections.
- Added MCP tool `fs_list_dir` (alias `fs.list_dir`) to list directory entries under the app root with optional glob filtering.
- Added MCP tools `fs_file_exists` / `fs_stat` (aliases `fs.file_exists`, `fs.stat`) to check existence and stat paths under the app root with size/mtime/type metadata.
- Added MCP tool `fs_search_in_files` (alias `fs.search_in_files`) to find string matches under a root with optional glob filters and capped results.
- Added MCP memory tools `memory_append` / `memory_query` / `memory_list` (dot aliases supported) for scoped note storage, querying, and listing with per-resource tagging.
- MCP memory tool responses are now returned as MCP `content` blocks (text payload) to satisfy clients expecting CallToolResult.content.
- Added MCP resource tools (`resource_read|create|update|delete|list`, dot aliases) that wrap the resource endpoints and return MCP content blocks.
- `fs_search_in_files` now matches glob filters against filenames and relative paths (e.g., `src/Database.php`).
- MCP reasoning summary now normalizes per model: `gpt-5.1-codex-max` is forced to `detailed`; other models accept `auto|concise|detailed`; invalid/`none` values are stripped.

# 2025-12-06
- Fixed the admin config builder to only emit valid `reasoning.summary` values (`auto|concise|detailed`), drop legacy `none`, and normalize previously stored configs so OpenAI no longer rejects uploads.
- Repaired `ClientConfigService::retrieve` (broken PHP parse, restored baked/base SHA logic + cache) and added coverage for reasoning summary normalization.
- Removed the Model Providers section (we only ship ChatGPT/OpenAI), so builder no longer accepts provider blocks and server drops `model_providers` entries when rendering config.toml.
- Defaults box now only asks for Model + Reasoning Effort + Reasoning Summary; default profile and model provider inputs were removed since we always target ChatGPT.
- Notices are now always hidden (gpt5 migration + rate-limit nags), with the toggles removed from the builder UI.
- Feature toggles now have human-readable labels while keeping their underlying config keys intact.
- Dropped the OTEL environment input from the MCP/Telemetry card; OTEL environment now defaults to blank.
- Managed MCP now uses native HTTP (no npm): baked config injects `[mcp_servers.cdx] url="{base}/mcp" http_headers = { Authorization = "Bearer {host_api_key}" }`, replacing the broken `npx codex-orchestrator-mcp` bridge.
- `/config/retrieve` now bakes `config.toml` per host using that host’s API key for the managed MCP entry, returns both `baked sha256` and `base_sha256`, and only ships content when the baked hash changes (host API key rotation forces a refresh); docs/tests updated.
- Added a dedicated admin config builder page (`/admin/config.html`) that captures every known `config.toml` knob (model/provider/profile, approval policy, sandbox, features/notices, shell env policy, model providers/profiles, MCP servers, OTEL, custom blocks) with live server-side rendering + SHA/size preview and one-click deploy to hosts.
- Added an iPhone-style toggle in the config builder to prefill a managed `codex-memory` MCP server pointing at this coordinator (npx command + API base); hosts get it baked automatically unless disabled, with per-host API key injected at config sync time (no key stored server-side).
- Added canonical `config.toml` storage (`client_config_documents` table) with `/config/retrieve` for hosts and `/admin/config` + `/admin/config/render|store` for admins; docs (API/DB/cdx/overview/README) updated accordingly.
- `cdx` now syncs `~/.codex/config.toml` from the server (warns on offline/missing-config, deletes local files when the server reports `missing`); wrapper bumped to 2025.12.06-01.
- Covered the new ClientConfigService with unit tests.
- Rebranded the admin dashboard and logs page titles to “Codex-Coordinator” instead of “Codex-Auth” so the UI matches the product name.
- Added MCP-compatible memory storage for Codex: `/mcp/memories/store|retrieve|search` reuse host API keys, persist notes in MySQL with full-text search over content/tags, and support tagged filtering so Codex MCP clients can sync memories across sessions.
- Added an Admin dashboard Memories panel (filter by host/tags/query, limit results) to browse stored MCP memories without shell access.
- Documented the new memory API (API/DB/cdx source-of-truth docs, README) and covered MemoryService with unit tests.

# 2025-12-05
- Rebuilt the Quota Policy card into an Operations & Settings panel that now hosts the quota toggle, API kill switch, runner trigger, seed auth.json action, and version check instead of scattering those controls across the header; the entire panel is collapsible (hidden by default) to keep the dashboard compact.
- Moved the insecure-host enable window slider into the same Operations & Settings panel, persist the selection locally (2–60 minutes), and pass it along whenever an insecure host is re-enabled.
- Expanded the AGENTS.md editor modal with a wider layout and taller textarea so editing lengthy instructions isn’t cramped.
- Removed the AGENTS.md SHA display from the dashboard meta line to keep that info box focused on update time and size.
- Added a quota limit slider under Quota Policy (50–100%, default 100%) so admins can warn or hard-stop Codex runs before hitting 100% usage; `/admin/quota-mode` now persists both `hard_fail` and `limit_percent`, `/auth` responses include `quota_limit_percent`, and the logs page no longer shows the orphaned API toggle.
- Updated `cdx`/wrapper summary and quota logic to honor the new `quota_limit_percent` threshold (and new env override `CODEX_QUOTA_LIMIT_PERCENT`), raising warnings or blocking launches once the configured percent is used.
- Hosts can now be marked VIP via the dashboard or `/admin/hosts/{id}/vip`; VIP hosts always run in warn-only mode regardless of the global quota setting, carry a “VIP” chip in the UI, and the flag is included in `/auth` responses + docs.
- Fixed the wrapper’s quota summary logic so it no longer uses `local` outside a function (`bin/cdx`/`storage/wrapper/cdx`), preventing the `/usr/local/bin/cdx: line 3629: local: can only be used in a function` error when running on insecure hosts.
- Admins can now pick a 2–60 minute insecure-host window via the dashboard slider; `/admin/hosts/{id}/insecure/enable` accepts `duration_minutes`, the server persists `insecure_window_minutes`, `/auth` extends windows by that duration (default 10), and docs/UI/CHANGELOG were updated accordingly.
- Added canonical AGENTS.md storage on the server with `/agents/retrieve` for hosts and `/admin/agents` (+ dashboard modal) for admins; hosts replace `~/.codex/AGENTS.md` on every sync and delete stale copies when the server copy is cleared.
- Dashboard now shows an AGENTS.md panel with inline preview + edit modal so project instructions can be updated without shell access.
- cdx pulls AGENTS.md alongside slash commands (python required), handles offline/missing-config gracefully, and surfaces sync status in the boot summary; wrapper bumped to 2025.12.05-01.
- Updated source-of-truth docs (API/DB/cdx) and README to reflect server-managed AGENTS.md instead of the old manual sync script.

# 2025-12-04
- Reformatted ChatGPT quota reset labels to read naturally (e.g., “Resets in 5 days (Tuesday)” and richer sub-48h phrasing) instead of the old “5d 13h 54m to reset” timer text.
- Added `scripts/sync-agents.php` to sync the repo’s `AGENTS.md` into `~/.codex/AGENTS.md` (honors `CODEX_HOME`) so Codex always picks up the latest project instructions with a single command.
- Rebuilt the ChatGPT Estimated Total cost modal with hoverable tooltips, a detailed per-day panel, and a scrolling day-by-day table so you can see exact dates and values instead of guessing from the old coarse chart.
- Added a Slash Commands “New Command” button that opens the creation modal empty, so fresh prompts can be authored without editing an existing entry first.

# 2025-12-02
- Applied the grok.com neon black theme across the admin dashboard + Client Logs views (desktop + mobile) so both screens match the new Grok-branded look-and-feel.
- Rebuilt the Grok theme using the `/root/grok.html` charcoal + teal palette so every dashboard/logs surface (backgrounds, nav, cards, chips, logs, toggles, mobile) now matches grok.com with zero neon gradients left.
- Iterated on the admin styling twice: first with a charcoal/blue corporate pass, then all the way to a light, airy OpenAI-inspired look (white cards, soft shadows, subtle accents) and restored the OpenAI logo in both dashboard + logs headers, keeping desktop/mobile in sync.
- Reshaped the ChatGPT usage summary so the Input/Output/Cached cards mirror the Estimated Total box and now show Today/Week/Month token counts (no more per-card cost rows or USD heading).
- Estimated Total now reports actual ChatGPT costs (using pricing_day/week/month_cost + currency) with Today/Week/Month cost chips instead of duplicating token counts.
- Simplified the Authorized Hosts table headers so the sort controls look like standard clickable text (no chunky buttons) for easier scanning.
- Converted the Authorized Hosts column sorters to plain text links (with keyboard support) so the remaining “button bubble” chrome is gone across browsers.
- Updated table hover highlights to a light orange accent so row selection/hover states match the airy theme instead of the previous dark blue wash.
- Restyled the Authorized Hosts table to stick with the green accent palette (header gradient + green row fills/hover states) so the list feels cohesive with the rest of the admin look.
- Swapped all button hover states (nav + standard + “ghost” controls such as Logs/Seed/New Host) to the green accent gradient so the old blue dip is gone.
- Tweaked the cdx CLI (bin + seeded wrapper) so insecure hosts treat expected auth refreshes as normal: no more “updating auth / auth outdated” noise in the command/result/auth rows, and the auth status tone stays green unless there’s a real problem.
- cdx shell/code launchers: Unknown / not found in code (current wrapper does not implement `cdx shell` or `cdx code`; superseded by later profile shorthand + `--execute` flows).
- Boot summary rows are now deduplicated, sorted, and easier to read while keeping the quota bars untouched.
- Fixed `cdx --execute` so `--skip-git-repo-check` is passed after `exec`, matching Codex CLI expectations.
- Fixed cdx runner telemetry so the status line reflects the fresh verification time immediately after the runner is triggered.
- cdx now shows “auth runner just verified” when the runner completed within ~90 seconds, replacing “<1m ago”; wrapper version bumped to 2025.12.02-01.
- Admin dashboard adds a “Quick: Insecure hosts” menu action (only visible when insecure hosts exist) that opens a scrollable modal listing insecure hosts (FQDN + enable/disable) with active windows pinned to the top.
- Added `GET /admin/hosts/insecure` for a minimal insecure-hosts list suitable for quick UI actions.

# 2025-12-01
- Estimated Total card no longer repeats the month-to-date total in its header, relying on the breakdown chips below.
- cdx now treats `/auth` HTTP 5xx/network outages as offline, keeping cached auth usable and surfacing the offline reason instead of hard failures.
- Slash command sync reports API outages/HTTP 5xx as offline (warn) and the wrapper version is bumped to 2025.12.01-03.
- Token usage ingests now compute and persist per-entry/aggregate costs from configured pricing (with backfill for existing rows) and expose a Cost column + currency on the Client Logs page.
- Auth runner preflight now runs every ~8 hours (first non-admin request per window) instead of once per UTC day, still refreshing the cached GitHub client version; interval configurable via `AUTH_RUNNER_PREFLIGHT_SECONDS` (default 28800s).
- Restyled the ChatGPT month-to-date cost cards with balanced tokens/cost lines and a dedicated total header, replacing the squished four-box layout.
- Estimated Total graph now opens a dedicated 60-day cost trend (input/output/cached) instead of reusing the quota chart placeholder.
- Added a stats icon to the ChatGPT estimated total card to mirror the weekly limit affordance.
- ChatGPT estimated total icon now opens the quota trend chart, matching the weekly limit graph control.
- Authorized Hosts table headers are now clickable to sort (toggle ascending/descending) by host, last seen, client, wrapper, or IP.
- Refreshed the ChatGPT estimated total card with a highlighted primary figure and chips for Today/Week/Month breakdown.
- Admin overview now includes daily token/cost totals for the dashboard, and the ChatGPT cost card shows Today/Week/Month estimates without the previous “includes” blurb.
- Added bash 4.2-safe guard for wrapper release tag selection to prevent `candidate_tags[@]` nounset errors during Codex refresh, and bumped wrapper version to 2025.12.01-02.
- Installer now selects the extracted Codex binary (skipping the tarball) and tolerates empty user lists on bash 4.2 by guarding array expansion in cdx, preventing nounset crashes during install/version checks.
- Fixed installer curl invocation to avoid `curl_flags[@]` unbound variable errors on older bash releases (e.g., CloudLinux 7) when IPv4 forcing is unset.
- Fixed installation UUID bootstrap to reuse existing `.env` values and avoid chmods that broke web-user access, preventing API 500s when env files were unreadable.
- Added installation UUID enforcement (server + baked cdx) to prevent cross-instance mixups; `/auth` rejects mismatched `installation_id`, installers/cdx carry the UUID.
- Added persistent IPv4-only host toggle (admin API + dashboard) that clears IP binding and bakes wrappers/installers with `curl -4`; cdx fetches updates over IPv4 when set.
- Aligned Logs header button styling with other admin controls.
- Installation UUID now auto-generates at boot/migration via shared helper, ensuring `.env` is populated across entrypoints without manual edits.
- Dashboard now shows weekly and month-to-date cost estimates side-by-side (using pricing + token usage) instead of daily totals.
- ChatGPT usage cost card now renders separate lines: “X$ this Week” and “Y$ this Month” for clearer readability.
- Weekly cost now uses the ChatGPT weekly limit window start (when available) instead of a naive trailing 7-day slice for more accurate estimates.
- Backups: the `mysql-backup` sidecar now runs by default, writes to `${DATA_ROOT}/backups`, and replaces the host cron helper; `docker compose up` automatically schedules nightly dumps (tuned via `DB_BACKUP_*` env vars) and setup/docs were updated accordingly.
- cdx wrapper: pass per-host reasoning effort via `--config model_reasoning_effort=...` (current Codex CLI standard) instead of the legacy `--reasoning-effort` flag; wrapper bumped to 2025.12.29-01.
- cdx wrapper: accept token-only auth.json (tokens.access_token or OPENAI_API_KEY) during local validation so fresh `codex login` files aren’t deleted before sync; wrapper bumped to 2026.01.02-01.
- Auth: `/auth` store now runs the auth runner before persisting; runner failures/unreachable responses reject the upload (admin `/admin/auth/upload` still bypasses the runner).
- Auth: when `last_refresh` matches canonical but the digest differs, `/auth` retrieve now asks the host to upload and runner‑validated stores may update canonical on timestamp ties.
- Admin config builder: write/read `features.experimental_windows_sandbox` (Codex 0.79+), drop the deprecated `enable_experimental_windows_sandbox` key from generated configs; cache-bumped config.js v=2026-01-07-02.
- cdx wrapper: sync Skills as `~/.codex/skills/<slug>/SKILL.md` (directory format) with frontmatter metadata parsing; wrapper bumped to 2026.01.09-01.
# 2026-03-24
- Cron auto-update now tracks and updates the `cdx` wrapper as a first-class component: `/cron/check` returns wrapper update instructions, cron self-updates the wrapper before Codex, and `/cron/report` accepts partial Codex/wrapper version reports.
- Dashboard and host version contracts now expose `reported_wrapper_version`, and cron health treats Codex and wrapper drift as one combined auto-update state.
