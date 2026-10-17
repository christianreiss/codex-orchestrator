---
title: Engines, Settings, and API keys
section: Admin workspace
verified: 2026-10-17
sources: frontend/src/routes/(providers)/engines/+page.svelte, frontend/src/lib/components/settings/EngineMasterSwitches.svelte, api/src/routes/admin/engines/index.ts, api/src/services/engine-switch.ts, frontend/src/routes/(access)/settings/+page.svelte, frontend/src/routes/(access)/access/+page.svelte, frontend/src/lib/components/api-keys/ApiKeysSection.svelte, frontend/src/lib/components/api-keys/ApiConfigure.svelte, frontend/src/lib/legacy-admin-routes.ts, frontend/src/lib/components/policies/AuthorizationPolicy.svelte, frontend/src/lib/components/policies/TogglePolicy.svelte, frontend/src/lib/components/policies/CleanupPolicy.svelte, frontend/src/lib/components/authoring/HooksEditor.svelte, frontend/src/lib/constants/models.ts, frontend/src/lib/components/library/SkillSourceSheet.svelte, frontend/src/lib/api/skillSources.ts, frontend/src/lib/components/settings/QuickModelDefaults.svelte, frontend/src/lib/components/settings/ClaudeFleetSettings.svelte, frontend/src/lib/components/command-palette/commands.ts, api/src/routes/admin/settings/index.ts, api/src/routes/admin/config/index.ts, api/src/routes/admin/skill-sources/index.ts, api/src/services/mattpocock-skills.ts, api/src/ops/mattpocock-skills-worker.ts, api/src/services/model-defaults.ts, api/src/services/agents.ts, api/src/services/skills.ts, api/src/services/skill-provenance.ts, api/src/services/mcp-resources.ts, api/src/services/memories.ts, api/src/services/client-config.ts, api/src/services/config-normalizer.ts, api/src/services/client-versions.ts, api/src/services/host-auth.ts, api/src/db/migrations/0007_add_skill_provenance.sql, wrappers/cxx/internal/persona/claude/lifecycle/collections.go
---

Grok Build is supported as the third engine (`cgx`); see [Grok Build](cgx) for
subscription login, centralized renewal, native receiver, and gateway details.

Configuration is organized under **Engines** (in the Providers hub), **Settings**, and the **API keys** section of **Access**, with separate destinations for people, agent rules, skills, memories, and projects. This article describes their controls and the environment variables that require deployment configuration.

Every write here names a capability: the fleet settings are `settings.manage` (owner, admin, fleet operator), the Claude client editor and the proxy inference defaults are `content.manage` (owner/admin), issuing or revoking API keys is `keys.manage` (owner/admin), and the authorization posture is `security.manage_authorization` (owner/admin). Reads are open to every role. Settings-service mutations publish a `settings.changed` WebSocket event and log an `admin.*` audit row. Saving the Claude fleet editor goes through `ClientConfigService`, publishes the same event for actual config changes, and uses sha256 conflict detection.

---

## Appearance

Use the sun/moon button in the header to choose **Light**, **Dark**, or **System**. Changes apply immediately and are saved through `/admin/theme`, so they survive reload and match the **Appearance** section of Account (`/account#appearance`), which is the only place with the full theme options. System follows changes to the operating system preference. If saving fails, the header restores the previous choice and displays the error.

## Finding configuration controls

Use these canonical destinations from the sidebar or command palette:

| Destination | URL | Contents |
|---|---|---|
| **Engines** | `/engines` | Engine master switches (Codex, Claude, Grok on/off for the whole fleet), then one section per engine with its state and usage, default model and effort, the **Only current models** policy, the CLI version, and a collapsed **Advanced** block (native settings, Codex silent mode and compaction, Claude client settings); below those, **Usage limits**, **Usage-based scaling**, and **Host agent rollout**. |
| **Settings** | `/settings` | Fleet-wide behaviour in three sections. **Hosts** (`#hosts`): update hosts automatically (auto-update), look up host names (reverse DNS), allow temporary-access requests (insecure approval), let agents set up new hosts, and remove inactive hosts. **Agents** (`#agents`): agent sessions, how agents treat API keys pasted in chat, the model-tier self-check, and role checks (authorization mode). **Data retention** (`#retention`): remove old logs automatically and session housekeeping. |
| **API keys** (in Access) | `/access#api-keys` | Issued keys first; **Configure** opens *Service availability & routing*: the **Routing** table, **Backend defaults**, and the global **All API traffic** control. |

Each engine's section on Engines (`/engines#codex-defaults`, `#claude-defaults`, `#grok-defaults`; the former Quick Settings page redirects to `/engines#defaults`) saves the default model and effort immediately ("Selections save automatically"). Selecting a model also selects its catalog default effort; only supported effort levels appear, and models without effort support show **No effort setting**. A failed save restores the confirmed selection and refreshes the server state before another change, and a failed read offers **Retry** (for example *Retry Codex defaults*). Clients receive defaults on their next sync; per-host exceptions (host overrides) take precedence.

Rarely changed settings sit in each engine's collapsed **Advanced** disclosure, which opens by itself when a link such as `/engines#claude-client` points inside it. **Usage limits** is `/engines#quota-enforcement`, **Usage-based scaling** is `#scaling-rules`, and **Host agent rollout** is `#cxx-rollout`. The **Per-host exceptions** button in the page header opens Hosts, where individual model and version choices take precedence over fleet defaults.

Old `/settings?tab=…`, `/policies`, `/api-keys`, `/quick-settings`, and `/authoring/settings` bookmarks redirect to the corresponding destination (`/authoring/settings` goes to `/engines#claude-client`).

### Only current models

Under **Engines → Current models**, enable **Only current models** separately
for Codex, Claude or Grok. The default is off. Each model family keeps its newest
version, so Sol, Astra, Luna and Terra remain available independently; the same
applies to Claude families and Grok Standard/Fast variants.

New managed starts and API inference requests upgrade older selections within
their family. Saved preferences remain intact, and switching off restores the
full list. Hosts need cxx 0.9.94 or newer and a configuration sync. Offline hosts
use their last signed setting. Running sessions keep their model; direct
provider binaries are outside this policy.

### General

#### API state

`GET /admin/api/state`, `POST /admin/api/state` — global API kill-switch (the **All API traffic** control under **Access → API keys → Configure**). The GET is not gated by the kill-switch itself, so the current state is always readable.

#### Auto-update

`GET /admin/auto-update`, `POST /admin/auto-update` — boolean flag, shown in Settings → Hosts as **Update hosts automatically**. Fleet default for background wrapper and CLI upgrades. Individual host rows can override this. From cxx 0.8.2, maintenance checks every 15 minutes and launches can queue a missed check without waiting; starting or finishing a session never runs an installer inline. Turning auto-update off keeps content/auth sync and the shared schedule working.

#### Reverse DNS

`GET /admin/reverse-dns`, `POST /admin/reverse-dns` — boolean flag, shown in Settings → Hosts as **Look up host names**. Controls global reverse-DNS strictness; individual hosts can override via `POST /admin/hosts/{id}/reverse-dns`.

#### API keys in chat

`GET /admin/api-keys-in-chat`, `POST /admin/api-keys-in-chat` — boolean flag under *Settings → Agents*, shown as **Tell agents how to treat keys pasted in chat**. A fleet instruction injected into the managed Codex, Claude, and Grok documents; see [Agent rules](/admin/manual/instructions).

#### Access control

`GET /admin/authorization`, `POST /admin/authorization` — the enforcement posture for roles, `compatible` or `strict`, under *Settings → Agents → Role checks* (authorization mode). The GET also lists every request the matrix *would* have refused while the fleet ran in `compatible`, so the switch is informed by your own traffic. Both directions need `security.manage_authorization`; see [Roles and capabilities](/admin/manual/roles).

#### Insecure approval

`GET /admin/insecure-approval`, `POST /admin/insecure-approval` — boolean flag, presented in Settings → Hosts as the **Allow temporary-access requests** switch (insecure-host approvals; on is manual approval, off rejects the request workflow). It is stored in `versions`, echoed as `insecure_approval_enabled` on `GET /admin/overview`, and written to the audit trail; nothing in `api/src/services` reads it back — the approval queue (`GET /admin/insecure-approvals/pending`) is listed and ruled on regardless of its value.

#### Prune policy

`POST /admin/prune-policy` — shown in Settings → Hosts as **Remove inactive hosts**; sets `inactivity_days` (integer 0–60), stored as `inactivity_window_days`. There is no paired GET for this endpoint. The deletion logic for hosts inactive longer than this threshold lives in `HostAuthService.pruneInactiveHosts` (`api/src/services/host-auth.ts`), but as of this verification it is not invoked by any scheduled job or cron — the setting is stored and echoed back on the fleet overview, but nothing currently calls the pruning method automatically. Treat this as a stored policy value rather than an active enforcement mechanism until a caller is wired up.

#### Log retention

`GET /admin/log-retention`, `POST /admin/log-retention` — Settings → Data retention, **Remove old logs automatically**: one boolean and four day-window integers (labelled *API logs*, *MCP logs*, *Events*, and *Graph statistics* in the form):

| Field | Description |
|---|---|
| `enabled` | Master switch for retention pruning. |
| `days_logs` | Retention window for log rows. |
| `days_mcp` | Retention window for MCP rows. |
| `days_events` | Retention window for event rows. |
| `days_graph_stats` | Retention window for graph-stats rows. |

### Engine master switches

The first section of **Engines** has one switch per engine. Switching an engine off **suspends** it for the whole fleet; nothing is deleted:

- Hosts refuse to launch it (`<Engine> is disabled fleet-wide by the administrator.`), stop its maintenance ticks (no CLI updates, no managed sync) and its messaging receiver. Its CLI, its local files and the host's engine assignment stay; sessions already running are not killed and run out on their own.
- The server stops refreshing, verifying and polling its accounts, hands out no new leases, refuses seeding, installers and adding it to a host, and stops AI assist when it is Codex.
- Every exposed API whose **backend** is that engine answers `503`. An API named after the engine but routed to another backend keeps serving; an API cannot be routed onto a switched-off engine.
- Model defaults, instructions, skills and other configuration stay editable.

Switching it back on resumes hosts on their next launch or maintenance tick (within 15 minutes) without a reinstall. After a long pause an account may need re-seeding, since its tokens were not refreshed meanwhile. All three engines may be off at once; the admin console never depends on one. Each change is confirmed in a dialog, audited as `admin.engine.state`, and shows who changed it last. API: `GET /admin/engines/state`, `POST /admin/engines/{engine}/state` with `{enabled}`.

### Codex

#### Codex engine

The Codex on/off switch is under **Engine master switches** above. `GET/POST /admin/openai/state` is the separate switch for the `/v1` exposed API only (the **Routing** table under **Access → API keys → Configure**).

#### Fleet model and effort

`GET /admin/model-defaults/{engine}`, `POST /admin/model-defaults/{engine}` with `engine=codex` — read or set the fleet-wide Codex CLI model together with its model-dependent persistent effort. POST accepts strict `{ model, reasoning_effort? }`; leaving effort unset selects the model default. The canonical config uses Codex's native `model` and `model_reasoning_effort` keys. The fleet default is `gpt-6-astra` at `medium`; the endpoint's returned `catalog` supplies each model's available efforts and selection default.

| Model | Persistent effort choices | Default |
|---|---|---|
| GPT-6 Astra | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | `medium` |
| GPT-5.6 Sol | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | `low` |
| GPT-5.6 Terra | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | `medium` |
| GPT-5.6 Luna | `low`, `medium`, `high`, `xhigh`, `max` | `medium` |
| GPT-5.5 | `low`, `medium`, `high`, `xhigh` | `medium` |
| GPT-5.3 Codex Spark | `low`, `medium`, `high`, `xhigh` | `high` |

#### Codex version

`POST /admin/codex-version` — pin the fleet-wide Codex CLI version to a semver string or `'latest'`. There is no paired GET for this endpoint.

`POST /admin/versions/check` — poll upstream for newer CLI versions (write-only, no GET).

#### Codex silent mode

`GET /admin/cdx-silent`, `POST /admin/cdx-silent` — boolean flag. Baked into the wrapper config so hosts go quiet on next sync.

#### Quotas

`GET /admin/quota-mode`, `POST /admin/quota-mode` — three fields. The server accepts `week_partition` only as one of the strings `off`, `5`, `7`; the **Usage limits** section of Engines (`/engines#quota-enforcement`) sends exactly those strings (*Off*, *5-day*, *7-day*).

| Field | Type | Description |
|---|---|---|
| `week_partition` | string: `'off'` \| `'5'` \| `'7'` | Rolling window length (off, 5-day, or 7-day). |
| `hard_fail` | boolean | Whether exceeding the quota hard-blocks the host. |
| `limit_percent` | integer 50–100 (default 95) | Percentage of the quota ceiling that triggers enforcement. |

#### Scaling

`GET /admin/scaling`, `POST /admin/scaling` — configures `UsageScalingService` rules (`api/src/services/usage-scaling.ts`).

### Claude

#### Claude engine

The Claude on/off switch is under **Engine master switches** above. `GET/POST /admin/claude/state` is the separate switch for the `/anthropic/v1` exposed API only.

#### Fleet model and effort

`GET /admin/model-defaults/{engine}`, `POST /admin/model-defaults/{engine}` with `engine=claude` — read or set the fleet-wide Claude Code model and persistent effort. The shared request field is named `reasoning_effort`, but the canonical Claude `settings.json` partial uses the native `model` and `effortLevel` keys.

| Model | Persistent effort choices | Default |
|---|---|---|
| Fable 5.1 | `low`, `medium`, `high`, `xhigh` | `high` |
| Fable 5 | `low`, `medium`, `high`, `xhigh` | `high` |
| Opus 5 | `low`, `medium`, `high`, `xhigh` | `high` |
| Opus 4.8 | `low`, `medium`, `high`, `xhigh` | `high` |
| Sonnet 5 | `low`, `medium`, `high`, `xhigh` | `high` |
| Opus 4.7 | `low`, `medium`, `high`, `xhigh` | `xhigh` |
| Sonnet 4.6 | `low`, `medium`, `high` | `high` |
| Haiku 4.5 | none | none; `effortLevel` is omitted |

Claude Code documents `low`, `medium`, `high`, and `xhigh` as persistent `settings.json` values; `max` is session-only and is therefore not offered by this fleet control. Unsupported model/effort combinations are rejected rather than silently stored.

On a new installation, GET displays the effective Sonnet 5 / `high` default without writing a config row. The first Save persists the pair; until then Claude hosts inherit Claude Code's own defaults.

#### Claude API defaults

Claude API proxy defaults (default model and max tokens used when proxying Claude API calls) are controlled by a separate endpoint: `GET /admin/claude/settings`, `POST /admin/claude/settings`. Fields:

| Field | Type | Constraints |
|---|---|---|
| `default_model` | string | Must be a supported Claude model; default `claude-sonnet-5`. |
| `max_tokens` | integer | 256–200 000, default 8 192. |

Supported proxy models are `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-opus-4-7`, `claude-sonnet-4-6`, and `claude-haiku-4-5-20251001`.

This endpoint controls only API proxy behaviour. It is independent from the fleet Claude Code `model` / `effortLevel` directly above and does not change managed CLI sessions.

#### Claude version

`GET /admin/claude/version`, `POST /admin/claude/version` — set the fleet-wide pinned Claude CLI version. The POST body is `{ selection }`: either a semver string (e.g. `2.1.170`) or `'latest'`/`'auto'` to clear the pin. There is no separate `locked` boolean in the request; the response reports the resulting `locked_version` and `locked_at`.

#### Fleet settings.json

The **Claude client settings** editor at `/engines#claude-client` (inside the Claude section's **Advanced** disclosure) builds and publishes the `settings.json` partial delivered to Claude Code hosts. The wrapper deep-merges fleet-owned settings while preserving user-authored settings outside those paths. It is separate from the Claude API proxy defaults above.

**Endpoints:** `GET /admin/claude/config` (read current config) and `POST /admin/claude/config/store` (write). Writes are tracked by sha256 for conflict detection.

**Editable fields:**

| Field | Notes |
|---|---|
| `advisorModel` | Dropdown — Off, Opus, Sonnet, Fable (`ADVISOR_MODELS`; Haiku is not offered because Claude Code's own advisor picker ranks it below every model it could advise); marked experimental. The pair is validated against the binary's rule that the advisor must rank at or above the fleet model. |
| `env` | Key-value pairs written to the `env` block. |
| `permissionMode` | Dropdown of `CLAUDE_PERMISSION_MODES`; writes `permissions.defaultMode` in the delivered settings.json. Fleet default is `'auto'` (`DEFAULT_CLAUDE_PERMISSION_MODE`) — every managed host auto-approves tool calls unless pinned to `'default'` or another mode. |
| `permissions` | Allow, ask, and deny lists. |
| `statusLine.command` | String; type is fixed to `'command'`. The optional siblings Claude Code accepts (`padding`, `refreshInterval`, `hideVimModeIndicator`) survive a save. Any `statusLine` suppresses the fleet's default `cxx claude-quota-statusline`, so a malformed one used to take Claude quota telemetry offline silently; it is validated now. |
| `hooks` | Event → hook list, edited via `HooksEditor`. Events are `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`, `Notification`, `SubagentStop`, `PreCompact`, `PostCompact` (`HOOK_EVENTS`). Each entry is serialized in the shape the CLI parses — `{ matcher?, hooks: [{ type: "command", command }] }`; the editor still reads the older `{ matcher, commands[] }` shape back, so a stored document migrates on its next save. |

A live read-only preview of the rendered `settings.json` is shown alongside the editor. Saving this editor re-reads and preserves the canonical fleet `model` / `effortLevel`, so an older open form cannot overwrite a model-default change.

### Grok

#### Grok engine

The Grok on/off switch is under **Engine master switches** above. `GET/POST /admin/grok/state` is the separate switch for the `/grok/v1` exposed API only.

#### Fleet model and effort

`GET /admin/model-defaults/{engine}`, `POST /admin/model-defaults/{engine}` with `engine=grok` — read or set the fleet-wide Grok Build model and persistent reasoning effort. The canonical config is Grok's native `~/.grok/config.toml`, using `[models].default` and `[models].default_reasoning_effort`. The fleet default is `grok-4.7` at `high`; explicit Grok host provisioning creates these defaults when no Grok config row exists yet.

| Model | Persistent effort choices | Default |
|---|---|---|
| Grok 4.7 (`grok-4.7`) | `low`, `medium`, `high`, `xhigh` | `high` |
| Grok 4.7 Fast (`grok-4.7-build-fast`) | `low`, `medium`, `high`, `xhigh` | `high` |
| Grok 4.6 (`grok-4.6`) | `low`, `medium`, `high`, `xhigh` | `high` |
| Grok 4.5 (`grok-4.5`) | `low`, `medium`, `high` | `high` |

These are native supported IDs; subscription availability is provider-owned. Codex lanes/profiles and Claude client settings do not apply, and Grok subscription quota is not tracked.

#### Grok version

`GET /admin/grok/version`, `GET /admin/grok/version/lock`, `POST /admin/grok/version` — the fleet-wide Grok Build CLI version, kept separate from Codex and Claude. The POST body is `{ selection }`: `'latest'`/`'auto'` clears the pin; otherwise a semver of at least `1.0.46`. The response reports `locked_version` and `locked_at`.

#### Grok API gateway

The **Grok API gateway** card under *Access → API keys → Configure → Backend defaults → Grok* configures the Grok backend — used by `/grok/v1` and by any other exposed API routed to Grok (see [Keyboard shortcuts and API reference](/admin/manual/shortcuts-api)):

- `GET /admin/grok/state`, `POST /admin/grok/state` — `{ disabled }`, stored as `grok_api_disabled` and shown as the `/grok/v1` row's **Enabled** switch in the **Routing** table. It gates only `/grok/v1`, independently of the other APIs and of which backend serves it.
- `GET /admin/grok/settings`, `POST /admin/grok/settings` — **Gateway default model** (`default_model`, a supported Grok model; default `grok-4.7`), used when a request names no model. Any field other than `default_model` and `disabled` is refused with 400 `unsupported_parameter`; there is no max-tokens setting.
- `GET /admin/grok/models`, `POST /admin/grok/models/{model}/toggle` with `{ enabled }` — per-model switches. A disabled model is left out of the model list of every API routed to Grok (`/grok/v1/models` by default) and rejected at inference with 403 `model_disabled`; managed Grok Build hosts are unaffected.

Gateway keys (`sk-cgx-`) are issued in the API keys list of the Access page (use the **Grok** filter, then **New key**). They are orchestrator gateway keys, not xAI API keys; see [Grok Build](cgx).

---

## Other configuration destinations

The following areas each have their own destination (a hub, page, or section).

### People (admin users)

The **People** section of the Access page (`/access#people`).

Full CRUD for admin accounts (`api/src/routes/admin/users/index.ts`), `users.read` to list and `users.manage` (owner/admin) to change:

- `GET /admin/users` — list all users.
- `POST /admin/users` — create. Body: `{ username, password, access_level, name, email }`. Minimum password length (12) is enforced by `AdminAuthService.validatePasswordOrThrow`.
- `POST /admin/users/{id}` — update.
- `DELETE /admin/users/{id}` — delete (refuses if this would leave zero active `owner`/`admin` accounts).
- `POST /admin/users/wipe` — delete every user except the caller.

See [Roles and capabilities](/admin/manual/roles) for the roles on offer and what each may do.

### Agent rules (fleet instructions)

The **Agent rules** page in the Library (`/library/agent-rules`).

Served to hosts via `POST /agents/retrieve`. Endpoints in `api/src/routes/admin/config/index.ts`:

- `GET /admin/agents` — current active version + version history.
- `GET /admin/agents/versions/{id}` — body of a specific version.
- `POST /admin/agents/compose` — compose the builder's modules and custom instructions into a preview.
- `GET /admin/agents/render`, `POST /admin/agents/render` — the effective per-host document.
- `POST /admin/agents/store` — save a new version.
- `POST /admin/agents/serve` — pick which version to serve (latest / pinned / none).
- `POST /admin/agents/revert` — revert to an earlier version.
- `POST /admin/agents/retention` — how many old versions to keep.
- `DELETE /admin/agents/versions/{id}` — delete one version.
- `GET`/`POST /admin/agents-generation-mode` — the Generated / Manual / Disabled switch (in the settings routes).
- `GET`/`POST /admin/response-verbosity` and `/admin/agent-policy-profiles*` — the verbosity dial and security posture profiles that live on the same page.

`AgentsService` (`api/src/services/agents.ts`) reconciles serve mode, latest version, and canonical content hash. The page itself is described in [Agent rules](/admin/manual/instructions).

### Skills (Library)

The **Skills** type of the Library (`/library?type=skills`).

Skills are the canonical command library, served over MCP as `skill://{slug}` resources. Endpoints in `api/src/routes/admin/config/index.ts`:

- `GET /admin/skills` — list.
- `GET /admin/skills/{slug}` — skill detail.
- `POST /admin/skills/generate` — request a new draft from the runner.
- `POST /admin/skills/assist` — request targeted edits from the runner.
- `POST /admin/skills/store` — save.
- `DELETE /admin/skills/{slug}` — delete.

#### Optional Matt Pocock source

The **Import from repository** button on the Skills list opens an *Import skills from a repository* panel that can import
`https://github.com/mattpocock/skills` through the same canonical Skill system.
It is **off by default** and performs no outbound request while off. This is an
external instruction supply chain: review the linked repository before enabling
it, especially before allowing later upstream changes to reach the fleet.

- **Include in fleet** controls the subscription. Fresh source state defaults
  **Auto-update** on; a preference set while disabled is preserved when the
  source is enabled.
- Re-enabling first validates the retained server cache. A complete cached
  revision is restored without contacting GitHub; a missing, incomplete, or
  damaged cache is fetched again from the immutable upstream SHA.
- **Auto-update** checks every six hours while both switches are on. Turn it off
  to pin the current last-known-good revision.
- **Check now** forces a refresh for an enabled source even when auto-update is
  off.
- The panel reports `disabled`, `ok`, or `error`, the upstream plugin version,
  immutable revision, Skill/file counts, check/sync times, and the last error.

The admin API is exact and source-specific:

- `GET /admin/skill-sources/mattpocock` is readable by every authenticated admin
  role and returns
  `{source,repository,ref,enabled,auto_update,status,revision,upstream_version,skill_count,file_count,last_checked_at,last_synced_at,last_error}`.
- `POST /admin/skill-sources/mattpocock` requires owner/admin, accepts a
  non-empty body containing one or both strict booleans
  `{enabled?,auto_update?}`, and returns the same state.
- `POST /admin/skill-sources/mattpocock/refresh` requires owner/admin, accepts
  no body, runs the manual check, and returns the same state on success.

A refresh resolves `main` to an immutable commit SHA, admits exactly the paths
declared by upstream `.claude-plugin/plugin.json` under its two safe Skill roots,
and advances only after every manifest, support file, digest, and the MIT license
notice validate. Failure leaves the previous last-known-good revision served.
Imported detail rows show their source and are read-only in the ordinary editor;
their provenance is `source_type: github:mattpocock/skills`, repository/path/SHA,
and `source_license: MIT`. Each complete bundle includes the upstream root notice
as `LICENSE.mattpocock` (MIT License, Copyright (c) 2026 Matt Pocock).

Codex reads imported manifests at `skill://<slug>` and support files at
`skill://<slug>/<path>`; Skills with upstream
`disable-model-invocation: true` are labelled **Explicit user invocation only**.
Claude receives a native, atomically replaced
`~/.claude/skills/<slug>/` directory through cxx 0.7.3. Before advertising a
cached bundle digest, cxx verifies the exact managed directory tree and every
owned file; missing, modified, symlinked, or unexpected entries withhold the
digest so the next bootstrap self-heals from the canonical bundle. Incoming
content is installed only after manifest, per-file, and recomputed complete
bundle digests match. Invalid cross-slug ownership records are quarantined and
cannot authorize overwrite or pruning. Turning inclusion off immediately
removes the source from the served Codex catalogue and makes Claude prune only
those fleet-owned directories at its next bootstrap. The cached server
rows/files and last-known-good metadata remain for re-enable; unrelated Skills
are untouched.

### Memories (Memory Atlas)

The **Memories** type of the Library (`/library?type=memories`).

Host, project, and shared memory in one workspace over the unified `/admin/memories/*` routes (`api/src/routes/admin/memories/index.ts`); the older `GET /admin/mcp/memories` list and `DELETE /admin/mcp/memories/{id}` remain for compatibility. See [Memories and the Memory Atlas](/admin/manual/memories); the host-side surface is the MCP `memory_*`, `project_memory_*`, and `shared_memory_*` tools (see [mcp](/admin/manual/mcp)).

### Secrets, Git merges, Shared files, Agents, and Messages

Each module has its own destination and its own article: [Secrets](/admin/manual/secrets) (a section of Access), [Git Director](/admin/manual/git-director) (Git merges), [File Transfer](/admin/manual/transfers) (Shared files), [Agents and agent sessions](/admin/manual/agent-portal), and [Agent Messaging](/admin/manual/agent-messaging) (Messages).

### /projects — Projects module

`GET /admin/projects/state` and `POST /admin/projects/state` (`api/src/routes/admin/projects/index.ts`) flip the Projects module on/off. See [projects](/admin/manual/projects) for the full surface.

### Codex config.toml document

The Codex `config.toml` builder. Endpoints in `api/src/routes/admin/config/index.ts`:

- `GET /admin/config` — current canonical config + per-host overrides.
- `POST /admin/config/render` — render a TOML body from a structured form.
- `POST /admin/config/store` — commit a new canonical version served via `POST /config/retrieve`.

`api/src/services/config-normalizer.ts` enforces valid model/reasoning-effort/personality shapes; `ClientConfigService` (`api/src/services/client-config.ts`) materialises the TOML a given host should receive given its overrides.

---

## Environment variables (deployment-time only)

The following variables are read from the process environment at startup. They cannot be changed at runtime through the admin UI. Set them in the deployment environment (Docker env, systemd unit, `.env` file, etc.).

| Variable | Description |
|---|---|
| `ADMIN_ACCESS_MODE` | `'cookie'` \| `'open'` — whether `/cli/auth/verify` requires an admin session. Does not gate `/admin/*`. |
| `ENCRYPTION_ACTIVE_KEY` | Required. Active encryption key for at-rest data. |
| `ENCRYPTION_KEYS`, `ENCRYPTION_ACTIVE_KID` | Key rotation support. |
| `AUTH_RUNNER_URL` + `AUTH_RUNNER_SHARED_SECRET` | Runner integration. |
| `MCP_OPERATOR_TOKEN` | Grants operator capability to MCP callers. |
| `MCP_FS_ROOT` | Enables `fs_*` MCP tools, confined to this directory. |
| `TRUST_X_FORWARDED` | Trust `X-Forwarded-*` headers from a reverse proxy. |
| `TRUSTED_PROXY_CIDRS` | CIDRs allowed to set forwarded headers. |
| `STRICT_HOST_VALIDATION` | Enforce strict hostname validation. |
| `DEFAULT_HOST_ENGINES` | Default engine set for new hosts (default: `'codex'`). |
| `SMTP_*` | Email delivery configuration. |
| `GPT51_*_PER_1K`, `CLAUDE_*_PER_1K` | Per-token pricing overrides for usage accounting. |
| `PRICING_URL`, `PRICING_CURRENCY` | External pricing source and currency. |
| `ADMIN_WEBAUTHN_RP_ID`, `ADMIN_WEBAUTHN_ORIGIN` | WebAuthn passkey login configuration. |
| `PUBLIC_BASE_URL`, `CODEX_SYNC_BASE_URL` | Public-facing URL roots. |
| `INSTALLATION_ID`, `DATA_ROOT` | Instance identity and data directory. |

---

## Source references

- frontend/src/routes/(providers)/engines/+page.svelte (engine sections, anchors, grouped controls)
- frontend/src/routes/(access)/settings/+page.svelte (fleet-wide behaviour: Hosts, Agents, Data retention)
- frontend/src/routes/(access)/access/+page.svelte, frontend/src/lib/components/api-keys/ApiKeysSection.svelte, frontend/src/lib/components/api-keys/ApiConfigure.svelte (service availability, routing, proxy toggles, issued keys)
- frontend/src/lib/components/policies/AuthorizationPolicy.svelte, frontend/src/lib/components/policies/TogglePolicy.svelte, frontend/src/lib/components/policies/CleanupPolicy.svelte (the Settings rows)
- frontend/src/lib/components/settings/QuotasSection.svelte (Usage limits; sends `off`/`5`/`7`)
- frontend/src/lib/components/authoring/HooksEditor.svelte, frontend/src/lib/constants/models.ts (hook shape, `HOOK_EVENTS`, `ADVISOR_MODELS`)
- frontend/src/lib/legacy-admin-routes.ts (compatibility redirects)

- `frontend/src/lib/components/settings/ClaudeFleetSettings.svelte` — fleet `settings.json` editor
- `frontend/src/lib/components/command-palette/commands.ts` — configuration destinations and actions
- `api/src/routes/admin/settings/index.ts` — settings API endpoints
- `api/src/services/model-defaults.ts` — engine catalogs and model/effort persistence
- `api/src/services/grok-models.ts` — Grok catalog, efforts, gateway model toggles
- `api/src/routes/admin/grok/index.ts` — Grok gateway state, default model, model toggles, keys
- `frontend/src/lib/components/settings/GrokEngineSection.svelte`, `frontend/src/lib/components/settings/GrokVersionSection.svelte` — Grok API gateway card and Grok version control
- `api/src/routes/admin/config/index.ts` — agents, skills, memories, profile builder, fleet Claude config
- `api/src/routes/admin/users/index.ts`
- `api/src/routes/admin/projects/index.ts`
- `api/src/services/agents.ts`
- `api/src/services/skills.ts`, `api/src/services/skill-drafts.ts`, `api/src/services/skill-manifest.ts`
- `api/src/services/memories.ts`, `api/src/services/mcp-memories.ts`
- `api/src/services/client-config.ts`, `api/src/services/config-normalizer.ts`
- `api/src/services/client-versions.ts` — version lock read/write shape (no `locked` request field)
- `api/src/services/host-auth.ts` — `pruneInactiveHosts`; confirms the prune-policy setting has no scheduled caller
- `api/src/services/usage-scaling.ts`

### Session housekeeping

**Settings → Data retention → Session housekeeping** (`/settings#retention`) sets retention and disk budgets separately for Codex, Claude and Grok. Defaults are automatic removal enabled, 30 days retention, 5 GiB per engine/local user and a minimum of 7 days inactivity when under budget pressure. A host's detail page can inherit the fleet rule or save a full override. Disabling removal preserves configured values.

cxx performs deletion locally during idle maintenance, including associated session history and search indexes. Active sessions, pins, open goals, queued work and fleet resume/wake bindings remain protected. Protected or young sessions can exceed the budget. Removed sessions cannot be resumed. Preview with `cxx housekeeping run --dry-run`; use `cxx housekeeping pin UUID --engine ENGINE` for sessions you want to retain.
