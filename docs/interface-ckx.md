# ckx — Kimi Code fleet wrapper

From cxx 0.9.180, `cxx doctor` checks the local PATH commands without loading
signed config, contacting the API or starting background services. Use
`cxx doctor --fix` to repair recognized legacy transition scripts when a stale
`cdx`, `clx`, `cgx` or `ckx` fails with HTTP 401 despite a current `cxx`.
Both historical `INSTALL_MODE=shim` and `INSTALL_CONTEXT=transition` formats
are recognized. Update, cron and startup alias reconciliation publish `cxx`
before migrating scripts, including when the binary is already current.
Repair replaces a recognized script only when its sibling `cxx` targets the
running installation; custom launchers and other installations are preserved.
The full engine doctor includes a Launchers row and suggests the local repair.
Run `cxx codex|claude|grok|kimi doctor` for full engine diagnostics.

Kimi is the fourth engine (`kimi`). The wrapper persona is `ckx` (relative
alias of the one `cxx` binary, like `cdx`, `clx` and `cgx`); the managed native
command is `kimi`. The supported CLI is **Kimi Code CLI** (MoonshotAI
`kimi-code`, TypeScript, shipped as a native binary). The archived Python
`kimi-cli` (PyPI, `~/.kimi`) is not supported and is never installed.

Grok (`docs/interface-cgx.md`) is the structural template: Kimi uses the same
server-owned subscription refresh with access-only host projections, native
on-disk Skills, a private managed home and server-polled usage. The
differences are listed under *Intentional deltas*.

## Contract (verified against merged code 2026-11-12)

### Identity

| Item | Value |
|---|---|
| Engine id / constant | `kimi` / `ENGINE_KIMI` (`api/src/util/engine.ts`), `config.EngineKimi` (Go) |
| Label | `Kimi Code` |
| Wrapper persona / alias | `ckx` (versioned `ckx-x.y.z`); `cxx kimi …` |
| Native command / PATH shim | `kimi` → `~/.cxx/native-bin/kimi` → `cxx native kimi -- …` |
| Gateway key prefix | `sk-ckx-` |
| Gateway surface | `/kimi/v1` (OpenAI-shaped). `versions.kimi_api_disabled` is seeded `1` (off): Kimi's terms for subscription-backed third-party gateways are unclear, so the operator opts in |
| Agents document state id | `4` (codex 1, claude 2, grok 3) |
| Receiver protocol id | `kimi-hooks-v1` |
| Activity source | `kimi-hooks` |
| Wrapper config file / env | `ckx.json`, `CKX_CONFIG_PATH`; env prefix `CKX_`; binary override `CKX_KIMI_BIN` |
| Terminal theme colour | amber (`#f59e0b` family); frontend token `--persona-kimi` |

### Database (migration `0130_kimi_engine.sql`, baseline and `schema.ts` in the same commit)

- `hosts`: `kimi_client_version VARCHAR(64)`, `kimi_client_version_override VARCHAR(64)`,
  `kimi_wrapper_version VARCHAR(64)`, `kimi_auth_digest VARCHAR(128)`,
  `kimi_model_override VARCHAR(128)`, `kimi_reasoning_effort_override VARCHAR(32)`,
  `kimi_last_refresh VARCHAR(100)` — all NULL, same shape as the `grok_*` columns.
- `kimi_auth_refresh_state`: identical columns to `grok_auth_refresh_state`.
- `kimi_usage_snapshots` (PK `account_id`): `plan_name VARCHAR(128)`,
  `plan_fetched_at`, `plan_error_code VARCHAR(48)`,
  `five_hour_used_percent DOUBLE`, `five_hour_resets_at`,
  `weekly_used_percent DOUBLE`, `weekly_resets_at`,
  `month_total_used_percent DOUBLE`, `month_total_resets_at`,
  `month_code_used_percent DOUBLE`, `month_code_resets_at`,
  `extra_usage_json TEXT`, `fetched_at`, `checked_at NOT NULL`,
  `error_code VARCHAR(48)` (timestamps `VARCHAR(100)`).
- `versions` seed rows: `api_surface_backend_kimi = kimi`, `kimi_api_disabled = 1`.
- Code-created `versions` keys: `kimi_engine_disabled`, `kimi_models_disabled`,
  `kimi_default_model`, `client_version_kimi`, `client_version_lock_kimi`,
  `wrapper_version_kimi`, `wrapper_sha256_kimi`, `wrapper_url_kimi`, runner state
  `*_kimi`, `kimi_engine_destroy`, `owner_engine_actor_kimi`.

### Canonical auth payload (server-side, secretbox-encrypted)

```json
{
  "kimi_code": {
    "access_token": "…", "refresh_token": "…",
    "expires_at": 1762950000, "expires_in": 900,
    "scope": "kimi-code", "token_type": "Bearer"
  },
  "device_id": "<as minted in the seeding login's KIMI_CODE_HOME/device_id>",
  "oauth_host": "https://auth.kimi.com",
  "base_url": "https://api.kimi.com/coding/v1",
  "last_refresh": "RFC3339"
}
```

- Both official regions are supported: `auth.kimi.com` + `api.kimi.com/coding/v1`
  (default) and `auth.kimi.ai` + `api.kimi.ai/coding/v1` (global). Any other
  endpoint pair is rejected with `kimi_endpoint_unsupported`. kimi-code derives
  a scoped credential key for every endpoint except the default one
  (`resolveKimiCodeRuntimeAuth`: `oauth/kimi-code-env-<sha256(JSON.stringify({oauthHost,baseUrl}))[:16]>`),
  so for the global region the wrapper and runner write the identical
  access-only projection both as `credentials/kimi-code.json` and under the
  scoped key, and the provider's `oauth.key` names the scoped key. For the
  supported `.ai` pair it is exactly
  `oauth/kimi-code-env-0e4f99c69cc27850`, stored as
  `credentials/kimi-code-env-0e4f99c69cc27850.json`.
- `device_id` is stored as minted by kimi-code (`identity.ts`, a UUID); refresh
  sends `X-Msh-Platform: kimi_code_cli`.
- Seeding always uses a dedicated device login in a throwaway `KIMI_CODE_HOME`
  (`ckx login` / seed script), then uploads `credentials/kimi-code.json` plus
  `device_id`. The seeding home is deleted afterwards so exactly one refresher
  (the server) holds the refresh token.
- Refresh (server only, `kimi-auth-owner`): `POST {oauth_host}/api/oauth/token`,
  form `client_id=17e5f671-d194-4dfb-9706-5516cb48c098&grant_type=refresh_token&refresh_token=…`,
  headers `X-Msh-Platform: kimi_code_cli`, `X-Msh-Version`, `X-Msh-Device-Id: <device_id>`,
  `X-Msh-Device-Name`, `X-Msh-Device-Model`, `X-Msh-Os-Version`. The response
  rotates the refresh token (a response without `refresh_token` is an error).
  The owner refreshes when fewer than `max(300 s, expires_in/2)` remain, fenced
  by `kimi_auth_refresh_state` exactly like Grok.
- Host projection (served by `/auth` retrieve and the communicator) drops the
  refresh token and pins expiry to zero:
  `{"access_token":"…","refresh_token":"","expires_at":0,"expires_in":0,"scope":"kimi-code","token_type":"Bearer"}`
  plus `device_id`. Verified against kimi-code 2.5.3 source and binary:
  `expires_at == 0` means the CLI never refreshes on its own and re-reads the
  file on every request; on a 401 it fails with "has no refresh_token;
  re-login required" without tombstoning the file. The wrapper rewrites
  `credentials/kimi-code.json` whenever the canonical access token changes.

### Host files (private managed home, `KIMI_CODE_HOME`)

| File | Owner | Content |
|---|---|---|
| `config.toml` | fleet-owned paths, user keys preserved | `default_model`, `default_permission_mode` (`manual`/`yolo`/`auto`), `telemetry=false`, `auto_session_title=false`, `disable_feedback_survey=true`, `[providers."managed:kimi-code"]` (`type="kimi"`, `base_url`, `oauth={storage="file",key="oauth/kimi-code"}`), `[models."kimi-code/<id>"]`, `[thinking] effort`, `[[hooks]]` for the receiver |
| `credentials/kimi-code.json` (0600) | wrapper | access-only projection above |
| `device_id` (0600) | wrapper | canonical `device_id` |
| `AGENTS.md` | wrapper | private per-launch copy of fleet instructions plus the current launch identity (digest in `~/.ckx/state`, the Kimi state dir mirroring Grok's `~/.cgx/state`) |
| `skills/` | wrapper (`skillstore`) | native fleet Skills (`kimi_skills` bundle field, `/skills?engine=kimi`) |
| `mcp.json` | wrapper | `{"mcpServers":{…}}` with the fleet MCP and `cxx-agent` |

Process environment for every managed start: `KIMI_CODE_HOME=<private home>`,
`KIMI_DISABLE_TELEMETRY=1`, `KIMI_CODE_NO_AUTO_UPDATE=1`.

### Host config (signed `/wrapper/v2/config`)

- Engine enums gain `kimi`; options gain `kimi_model_override` and
  `kimi_reasoning_effort_override` (effort `low|high|max`).
- Sync bundle field `kimi_skills` (same item shape as `grok_skills`).

### CLI installation

`https://code.kimi.com/kimi-code/binaries/<version>/manifest.json` →
`platforms["<os>-<arch>"]` (`linux-x64`, `linux-arm64`, `darwin-x64`,
`darwin-arm64`) `.filename` and `.checksum` (sha256 hex). Download
`…/binaries/<version>/<filename>` (bare binary; the host redirects to
`cdn.kimi.com`), verify sha256, install to `~/.cxx/engines/kimi/<version>/kimi`,
probe `kimi --version`, prune with `enginestore`. Latest pointer:
`https://code.kimi.com/kimi-code/latest` (plain text). Pin: `2.5.3`
(2026-11-10). No Node runtime is required.

### Usage and quota

Server-side, per account: `GET {base_url}/usages` with
`Authorization: Bearer <canonical access token>`. Response
`{usages:{limit_5h,limit_7d,limit_month_total,limit_month_code:{used_ratio,reset_time}}, …}`
(`limit_7d` exists only on legacy plans). The 5 h window is the short quota
window and the 7 d window the long one, so Kimi takes part in quota
observation, `quota_get`, warnings and hard-fail like Codex and Claude.

### Non-interactive use (runner, host daemon, Wake)

`kimi -p "<prompt>" --output-format stream-json [-m <alias>] [-S <session>]`.
Prompt mode already runs in Never Ask mode: 2.5.3 rejects `-p` combined with
`--auto` (`Cannot combine --prompt with --auto.`), so headless starts never pass
`--auto`/`--yolo`. The prompt travels as argv (no prompt-file option). Its ceiling is **100000
UTF-8 bytes**, not characters: the server (`assertHeadlessPrompt`, daemon/Wake
admission), wrapper worker/daemon (`validateKimiPrompt`) and gateway adapter
(`assertRunnerPrompt`) reject over-limit content before native execution.
A 25000-emoji prompt is exactly 100000 bytes; 25001 is rejected. Kimi 2.5.3 also rejects `-p` with `--plan`. The server returns
`422 permission_mode_engine_unsupported` for daemon plan starts; wrappers reject
stored Kimi plan operations before execution, never dropping the constraint.

Native session ids have the form `session_<UUID>` (keep the prefix everywhere:
resume `-S session_<UUID>`, transcript checks, server native-id validation).
Store layout: `$KIMI_CODE_HOME/sessions/wd_<cwd-slug>_<sha12>/session_<UUID>/state.json`
plus `agents/main/wire.jsonl`. The final stream-json `meta` event
`session.resume_hint` carries `session_id` and the resume command. stream-json
reports no token usage and no stop reason. Hook stdin `prompt` is an array of
content parts (`[{"type":"text","text":"…"}]`), not a string. (Verified with
2.5.3 against a mock provider, 2026-11-12.)
Exit 1 with a one-line `error:` on stderr on failure. stdout begins with
`{"role":"meta","type":"system.version","version":"…"}`.

### Per-launch identity

`agentportal.AppendKimiIdentityArgs` writes the current launch identity into
`AGENTS.md` inside the **private per-launch `KIMI_CODE_HOME`**. It replaces only
the delimited `cxx:launch-identity` block, preserving the copied fleet document;
argv stays unchanged. It works for new and resumed sessions. `--agent-file`
binds an agent at session creation and cannot be combined with `-S`, so it is
not the identity transport. The durable base-home instructions are never
replaced by another session's identity.

### Receiver (`kimi-hooks-v1`)

Kimi has no idle-session injection channel (no MCP Channels, no App Server
queue, ACP is client-driven). Delivery uses native hooks that the wrapper
writes into `config.toml`:

- `UserPromptSubmit`: stdout is appended to the turn's context. Payload carries
  `session_id`, `cwd`, `prompt`; fires in TUI and `-p` mode.
- `Stop` (blockable): when queued peer messages exist the hook blocks the stop
  and returns them as the continuation message, so the model handles them
  before ending the turn.
- Model-initiated `agent_listen` stays available.

Full managed hook table (`internal/kimi/runtime.go`, `[[hooks]]`, each
`timeout = 30`; executable is the running cxx binary, shell-quoted):

| Event | Command suffix | Purpose |
|---|---|---|
| `UserPromptSubmit` | `agent poll --hook UserPromptSubmit --dialect kimi` | Peer/portal ring and turn activity |
| `Stop` | `agent poll --hook Stop --dialect kimi` | Block to continue pending peer/portal work, otherwise idle |
| `SessionStart` | `agent native-session` | Bind the native `session_<UUID>` to this launch |
| `TurnStarted` | `agent activity-event` | Working |
| `PreToolUse` | `agent activity-event` | Working/tool activity |
| `PostToolUse` | `agent activity-event` | Working/tool completion |
| `PostToolUseFailure` | `agent activity-event` | Working/tool failure |
| `PermissionRequest` | `agent activity-event` | Waiting for approval |
| `PermissionResult` | `agent activity-event` | Working after approval result |
| `StopFailure` | `agent activity-event` | Idle after stop failure |
| `Interrupt` | `agent activity-event` | Idle after interruption |
| `SessionEnd` | `agent activity-event` | Idle at session end |

The two poll commands are:
`cxx agent poll --hook UserPromptSubmit --dialect kimi` and
`cxx agent poll --hook Stop --dialect kimi`. The `kimi` dialect maps the
existing Claude ring onto Kimi's hook protocol: `UserPromptSubmit` prints the
pending-message notice as plain text on stdout and exits 0; `Stop` with pending
deliveries prints the continuation text on stderr and exits 2 (block);
nothing pending, or any error, is an empty exit 0 (Kimi hooks fail open).

The same ring includes operator portal deliveries via mailbox entries with
`source: "portal"`, independently of peer messages. `agent_listen` reads the
original through `agent_receiver_*` and acknowledges presentation; a ring is
not an acceptance or completion receipt. Poll hooks fail open on errors, and
an already announced portal delivery does not repeatedly block Stop.

### Gateway (`/kimi/v1`)

The OpenAI-shaped surface (`/models`, `/chat/completions`, `/responses`) uses
Kimi-scoped `sk-ckx-` keys and the surface/backend routing contract. It starts
disabled (`kimi_api_disabled=1`) pending operator opt-in because subscription
gateway terms are unclear. It never silently selects Grok/Claude/Codex when
Kimi was selected. The runner writes a dedicated inference-only agent file
with `tools: []` and the supplied system text, then starts `-p` with
`--agent-file`; gateway calls do not resume an existing session. Native
stream-json provides no usage or stop reason: adapters preserve unknown usage
and reject controls requiring exact telemetry instead of inventing values.

### Admin API and dashboard shapes

- `/admin/kimi/*` mirrors `/admin/grok/*` (keys, state, settings, models,
  config, version and lock) with `kimi` substituted; `/admin/hosts/:id/kimi-version`
  mirrors the Grok route.
- Account usage for `engine = "kimi"` (Accounts, Dashboard, `/quota`):
  `{"plan_name": string|null, "windows": [{"kind": "five_hour"|"weekly"|"month_total"|"month_code", "used_percent": number, "resets_at": string|null}], "fetched_at": string|null, "checked_at": string, "error_code": string|null}`.
  `five_hour` maps to the short quota window and `weekly` to the long one.

## Intentional deltas

- No idle push: a message to an idle interactive Kimi session waits until the
  next prompt or turn end (shown as delivery timing `after_turn`).
- No OS sandbox exists in Kimi; posture projects only `default_permission_mode`
  and `[[permission.rules]]`.
- Gateway surface disabled by default (see Identity); no native stream-json usage or stop reason.
- The server is the single refresher; local canonical auth reconciliation is explicitly refused.
- Live verification of device login, refresh and `/usages` requires a Kimi Code
  subscription credential, which the fleet secret store did not hold on
  2026-11-12; those paths are built from the 2.5.3 source and covered by mocks.

## CLI surface

| Command | Behavior |
|---|---|
| `run` (default) | Sync and launch Kimi with its leased access-only private runtime. |
| `resume` | Resume the native `session_<UUID>` with `-S`. |
| `sync` / `auth-sync` | Sync signed config, instructions and native Skills. |
| `status` | Report installation, API and auth readiness. |
| `doctor` | Diagnose config, binary, runtime and auth readiness. |
| `update` | Update shared cxx and the pinned verified Kimi binary, then sync. |
| `cron` | Shared host maintenance schedule. |
| `uninstall` | Remove managed Kimi content and installation with session fencing. |
| `login` | Dedicated throwaway device login and canonical server seed. |
| `logout` | End the managed auth binding. |
| `auth-upload-auto` | Accepted no-op; hosts own no canonical refresh token. |
| `auth-reconcile` | Explicitly refused: the server owns canonical refresh. |
| `help` | Wrapper help without launching or authenticating. |

## Parity exemptions

Audit base: `511b4486e`, 2026-11-12. The requested case-insensitive Grok-without-Kimi gate contained **332 files**. Every file was classified: **83 corrected/current files** and **249 exemptions** below (250 since the 2026-11-12 libc selection added `libcselect/reconcile.go`). Exemptions are scoped to the stated reason, not permission for a new engine enumeration to omit Kimi. New runtime behavior is checked separately from historical/provider-only fixtures.

Reproduce the gate (excluded build artifacts and changelog stay untouched):

```sh
git grep -il grok -- . ':!*.lock' ':!public/admin/**' ':!CHANGELOG.md' | xargs grep -Li kimi
python3 scripts/check-engine-parity.py
```

### Corrected files from the original gate

- `.env.example`
- `AGENTS.md`
- `advisor/bootstrap.py`
- `api/README.md`
- `api/src/services/chatty/actions.ts`
- `api/src/services/host-agents-extra.ts`
- `api/src/services/host-skills.ts`
- `api/src/services/managed-reboot-safe-skill.ts`
- `api/src/services/managed-wake-cron-skill.ts`
- `api/test/integration/admin-settings/config-revision-db.test.ts`
- `api/test/integration/admin-settings/config-revision.test.ts`
- `api/test/integration/secrets/db.test.ts`
- `api/test/integration/shared-memories/db.test.ts`
- `api/test/unit/contract/frontend-model-catalog-parity.test.ts`
- `api/test/unit/contract/frontend-model-constants.test.ts`
- `api/test/unit/contract/frontend-model-registry.test.ts`
- `api/test/unit/contract/wrapper-cli-surface.test.ts`
- `api/test/unit/routes/frontend-path-coverage.test.ts`
- `api/test/unit/services/advisor.test.ts`
- `api/test/unit/services/agent-receiver-state.test.ts`
- `api/test/unit/services/codex-compaction-default.test.ts`
- `api/test/unit/services/model-defaults.test.ts`
- `api/test/unit/services/model-policy.test.ts`
- `api/test/unit/services/model-registry.test.ts`
- `api/test/unit/services/model-tiers.test.ts`
- `api/test/unit/services/secrets.test.ts`
- `api/test/unit/services/workflow-tool-schemas.test.ts`
- `docs/ADMIN.md`
- `docs/INSTALL.md`
- `docs/MCP.md`
- `docs/NATIVE_CONFIG_SCOPES.md`
- `docs/README.md`
- `docs/USAGE.md`
- `docs/agent-chat.md`
- `docs/agent-coordination.md`
- `docs/agent-messaging-timing.md`
- `docs/agent-roles.md`
- `docs/agent-supervisor.md`
- `docs/android-companion.md`
- `docs/auth-resilience.md`
- `docs/chatty.md`
- `docs/communicator-resident-runtime.md`
- `docs/contracts/auth-retrieve.schema.json`
- `docs/contracts/auth-store.schema.json`
- `docs/contracts/sync-bootstrap.schema.json`
- `docs/contracts/sync-status.schema.json`
- `docs/contracts/versions.schema.json`
- `docs/external-clients.md`
- `docs/file-transfers.md`
- `docs/host-runtime-policy.md`
- `docs/interface-cdx.md`
- `docs/interface-cgx.md`
- `docs/interface-clx.md`
- `docs/model-registry.md`
- `docs/owner-cutover.md`
- `docs/prompts/engine-maintenance.md`
- `docs/prompts/feedback-sweep.md`
- `docs/reboot-resume.md`
- `docs/resource-admission-plan.md`
- `docs/rtk.md`
- `docs/skills/README.md`
- `docs/smart-queue.md`
- `docs/workflows.md`
- `docs/wrapper-v2-architecture.md`
- `frontend/e2e/admin-git-commit.spec.ts`
- `frontend/src/lib/api/hostDaemons.ts`
- `scripts/deploy.sh`
- `wrappers/README.md`
- `wrappers/cxx/internal/agentbus/permission_mode_test.go`
- `wrappers/cxx/internal/agentbus/session_name_test.go`
- `wrappers/cxx/internal/authreconcile/reconcile.go`
- `wrappers/cxx/internal/authreconcile/reconcile_test.go`
- `wrappers/cxx/internal/config/engine_drift_test.go`
- `wrappers/cxx/internal/emergency/emergency_test.go`
- `wrappers/cxx/internal/enginedestroy/enginedestroy_test.go`
- `wrappers/cxx/internal/launchpad/launchpad_test.go`
- `wrappers/cxx/internal/launchpad/safety_test.go`
- `wrappers/cxx/internal/launchpad/view_test.go`
- `wrappers/cxx/internal/launchpad/weekly_test.go`
- `wrappers/cxx/internal/modelpolicy/policy_test.go`
- `wrappers/cxx/internal/persona/codex/orchestrator/bundle_test.go`
- `wrappers/cxx/internal/skillstore/store.go`
- `wrappers/cxx/internal/terminalui/update_block_test.go`

### Grok assets (1)

| Path | Reason |
|---|---|
| `frontend/scripts/readme-shots/cgx.ansi` | Captured Grok terminal illustration, not an engine enumeration. |

### Grok provider implementations, installers and tests (103)

| Path | Reason |
|---|---|
| `api/scripts/check-grok-mcp.ts` | Grok-only implementation of check grok mcp; Kimi has its own provider path. |
| `api/src/ops/grok-usage-worker.ts` | Grok-only implementation of grok usage worker; Kimi has its own provider path. |
| `api/src/routes/admin/grok/index.ts` | Grok-only implementation of index; Kimi has its own provider path. |
| `api/src/routes/grok-v1/index.ts` | Grok-only implementation of index; Kimi has its own provider path. |
| `api/src/services/grok-auth-lock.ts` | Grok-only implementation of grok auth lock; Kimi has its own provider path. |
| `api/src/services/grok-auth-owner.ts` | Grok-only implementation of grok auth owner; Kimi has its own provider path. |
| `api/src/services/grok-auth.ts` | Grok-only implementation of grok auth; Kimi has its own provider path. |
| `api/src/services/grok-models.ts` | Grok-only implementation of grok models; Kimi has its own provider path. |
| `api/src/services/grok-native-fields.ts` | Grok-only implementation of grok native fields; Kimi has its own provider path. |
| `api/src/services/grok-native-settings.ts` | Grok-only implementation of grok native settings; Kimi has its own provider path. |
| `api/src/services/grok-native-structures.ts` | Grok-only implementation of grok native structures; Kimi has its own provider path. |
| `api/src/services/grok-usage.ts` | Grok-only implementation of grok usage; Kimi has its own provider path. |
| `api/test/integration/admin-settings/grok-engine.test.ts` | Grok-only test/fixture for grok engine.test; Kimi has its own provider path. |
| `api/test/integration/admin-settings/grok-version.test.ts` | Grok-only test/fixture for grok version.test; Kimi has its own provider path. |
| `api/test/integration/control-plane/grok-response-capture.test.ts` | Grok-only test/fixture for grok response capture.test; Kimi has its own provider path. |
| `api/test/integration/grok-custom-context.test.ts` | Grok-only test/fixture for grok custom context.test; Kimi has its own provider path. |
| `api/test/integration/provider-accounts/grok-owner.test.ts` | Grok-only test/fixture for grok owner.test; Kimi has its own provider path. |
| `api/test/integration/provider-accounts/grok-usage.test.ts` | Grok-only test/fixture for grok usage.test; Kimi has its own provider path. |
| `api/test/integration/v1/grok.test.ts` | Grok-only test/fixture for grok.test; Kimi has its own provider path. |
| `api/test/unit/services/grok-170-settings.test.ts` | Grok-only test/fixture for grok 170 settings.test; Kimi has its own provider path. |
| `api/test/unit/services/grok-177-settings.test.ts` | Grok-only test/fixture for grok 177 settings.test; Kimi has its own provider path. |
| `api/test/unit/services/grok-auth.test.ts` | Grok-only test/fixture for grok auth.test; Kimi has its own provider path. |
| `api/test/unit/services/grok-custom-context.test.ts` | Grok-only test/fixture for grok custom context.test; Kimi has its own provider path. |
| `api/test/unit/services/grok-native-settings.test.ts` | Grok-only test/fixture for grok native settings.test; Kimi has its own provider path. |
| `api/test/unit/services/grok-native-structures.test.ts` | Grok-only test/fixture for grok native structures.test; Kimi has its own provider path. |
| `api/test/unit/services/grok-permission-rules.test.ts` | Grok-only test/fixture for grok permission rules.test; Kimi has its own provider path. |
| `api/test/unit/services/grok-usage.test.ts` | Grok-only test/fixture for grok usage.test; Kimi has its own provider path. |
| `frontend/src/lib/assets/engines/grok.svg` | Grok-only implementation of grok; Kimi has its own provider path. |
| `frontend/src/lib/components/dashboard/GrokUsage.svelte` | Grok-only implementation of GrokUsage; Kimi has its own provider path. |
| `frontend/src/lib/components/settings/GrokEngineSection.svelte` | Grok-only implementation of GrokEngineSection; Kimi has its own provider path. |
| `frontend/src/lib/components/settings/GrokVersionSection.svelte` | Grok-only implementation of GrokVersionSection; Kimi has its own provider path. |
| `runner/grok.py` | Grok-only implementation of grok; Kimi has its own provider path. |
| `runner/install-grok.mjs` | Grok-only implementation of install grok; Kimi has its own provider path. |
| `runner/test_grok.py` | Grok-only test/fixture for test grok; Kimi has its own provider path. |
| `runner/test_install_grok.py` | Grok-only test/fixture for test install grok; Kimi has its own provider path. |
| `wrappers/cxx/internal/agentbus/grok_native_canary_test.go` | Grok-only test/fixture for grok native canary test; Kimi has its own provider path. |
| `wrappers/cxx/internal/agentbus/grok_queue.go` | Grok-only implementation of grok queue; Kimi has its own provider path. |
| `wrappers/cxx/internal/agentbus/grok_queue_test.go` | Grok-only test/fixture for grok queue test; Kimi has its own provider path. |
| `wrappers/cxx/internal/agentbus/grok_reaper_main_test.go` | Grok-only test/fixture for grok reaper main test; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/commands.go` | Grok-only implementation of commands; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/communicator.go` | Grok-only implementation of communicator; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/doctor.go` | Grok-only implementation of doctor; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/doctor_leftovers_test.go` | Grok-only test/fixture for doctor leftovers test; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/exit_report_test.go` | Grok-only test/fixture for exit report test; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/help_safety_test.go` | Grok-only test/fixture for help safety test; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/identity_launch_test.go` | Grok-only test/fixture for identity launch test; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/login.go` | Grok-only implementation of login; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/login_lifetime_test.go` | Grok-only test/fixture for login lifetime test; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/login_test.go` | Grok-only test/fixture for login test; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/main.go` | Grok-only implementation of main; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/main_test.go` | Grok-only test/fixture for main test; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/maintenance_test.go` | Grok-only test/fixture for maintenance test; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/managed_cleanup.go` | Grok-only implementation of managed cleanup; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/managed_cleanup_test.go` | Grok-only test/fixture for managed cleanup test; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/memory_routing_test.go` | Grok-only test/fixture for memory routing test; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/native_entry_test.go` | Grok-only test/fixture for native entry test; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/native_version.go` | Grok-only implementation of native version; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/native_version_test.go` | Grok-only test/fixture for native version test; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/parity_test.go` | Grok-only test/fixture for parity test; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/reaper_main_test.go` | Grok-only test/fixture for reaper main test; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/runtime_preferences_test.go` | Grok-only test/fixture for runtime preferences test; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/signal_test.go` | Grok-only test/fixture for signal test; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/startup.go` | Grok-only implementation of startup; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/startup_test.go` | Grok-only test/fixture for startup test; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/uninstall_cancellation_test.go` | Grok-only test/fixture for uninstall cancellation test; Kimi has its own provider path. |
| `wrappers/cxx/internal/app/grok/update_sync.go` | Grok-only implementation of update sync; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/aliases.go` | Grok-only implementation of aliases; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/aliases_test.go` | Grok-only test/fixture for aliases test; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/config.go` | Grok-only implementation of config; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/config_test.go` | Grok-only test/fixture for config test; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/leader_log.go` | Grok-only implementation of leader log; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/leader_log_test.go` | Grok-only test/fixture for leader log test; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/memory_routing_test.go` | Grok-only test/fixture for memory routing test; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/native.go` | Grok-only implementation of native; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/native_test.go` | Grok-only test/fixture for native test; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/peer.go` | Grok-only implementation of peer; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/preexec.go` | Grok-only implementation of preexec; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/preexec_test.go` | Grok-only test/fixture for preexec test; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/private_directory.go` | Grok-only implementation of private directory; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/private_directory_linux.go` | Grok-only implementation of private directory linux; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/private_directory_linux_test.go` | Grok-only test/fixture for private directory linux test; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/private_directory_other.go` | Grok-only implementation of private directory other; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/private_directory_test.go` | Grok-only test/fixture for private directory test; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/reaper_main_test.go` | Grok-only test/fixture for reaper main test; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/registry_canary_test.go` | Grok-only test/fixture for registry canary test; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/runtime.go` | Grok-only implementation of runtime; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/runtime_assets_test.go` | Grok-only test/fixture for runtime assets test; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/runtime_overlay.go` | Grok-only implementation of runtime overlay; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/runtime_overlay_test.go` | Grok-only test/fixture for runtime overlay test; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/runtime_recheck_test.go` | Grok-only test/fixture for runtime recheck test; Kimi has its own provider path. |
| `wrappers/cxx/internal/grok/runtime_test.go` | Grok-only test/fixture for runtime test; Kimi has its own provider path. |
| `wrappers/cxx/internal/grokreap/auto.go` | Grok-only implementation of auto; Kimi has its own provider path. |
| `wrappers/cxx/internal/grokreap/command_safety_test.go` | Grok-only test/fixture for command safety test; Kimi has its own provider path. |
| `wrappers/cxx/internal/grokreap/proc_linux.go` | Grok-only implementation of proc linux; Kimi has its own provider path. |
| `wrappers/cxx/internal/grokreap/proc_other.go` | Grok-only implementation of proc other; Kimi has its own provider path. |
| `wrappers/cxx/internal/grokreap/reap.go` | Grok-only implementation of reap; Kimi has its own provider path. |
| `wrappers/cxx/internal/grokreap/reap_linux_test.go` | Grok-only test/fixture for reap linux test; Kimi has its own provider path. |
| `wrappers/cxx/internal/grokreap/reap_test.go` | Grok-only test/fixture for reap test; Kimi has its own provider path. |
| `wrappers/cxx/internal/nativeargs/maintenance_20261026_test.go` | Grok-only test/fixture for maintenance 20261026 test; Kimi has its own provider path. |
| `wrappers/cxx/internal/nativeargs/maintenance_20261028_test.go` | Grok-only test/fixture for maintenance 20261028 test; Kimi has its own provider path. |
| `wrappers/cxx/internal/nativeargs/maintenance_20261101_test.go` | Grok-only test/fixture for maintenance 20261101 test; Kimi has its own provider path. |
| `wrappers/cxx/internal/nativeargs/maintenance_20261106_grok_test.go` | Grok-only test/fixture for maintenance 20261106 grok test; Kimi has its own provider path. |
| `wrappers/cxx/internal/nativeargs/testdata/grok-1.0.70-help.json` | Grok-only test/fixture for grok 1.0.70 help; Kimi has its own provider path. |

### Historical database migrations and fixtures (16)

| Path | Reason |
|---|---|
| `api/src/db/migrations/0037_grok_engine.sql` | Historical migration scope and old-provider preservation fixtures; additive Kimi schema is introduced by migration 0130, never by rewriting old migrations. |
| `api/src/db/migrations/0038_api_surface_backends.sql` | Historical migration scope and old-provider preservation fixtures; additive Kimi schema is introduced by migration 0130, never by rewriting old migrations. |
| `api/src/db/migrations/0040_grok_usage_snapshots.sql` | Historical migration scope and old-provider preservation fixtures; additive Kimi schema is introduced by migration 0130, never by rewriting old migrations. |
| `api/src/db/migrations/0069_provider_plan.sql` | Historical migration scope and old-provider preservation fixtures; additive Kimi schema is introduced by migration 0130, never by rewriting old migrations. |
| `api/src/db/migrations/0072_grok_retired_memory_controls.sql` | Historical migration scope and old-provider preservation fixtures; additive Kimi schema is introduced by migration 0130, never by rewriting old migrations. |
| `api/src/db/migrations/0091_quota_snapshot_account_indexes.sql` | Historical migration scope and old-provider preservation fixtures; additive Kimi schema is introduced by migration 0130, never by rewriting old migrations. |
| `api/src/db/migrations/0110_grok_170_native_controls.sql` | Historical migration scope and old-provider preservation fixtures; additive Kimi schema is introduced by migration 0130, never by rewriting old migrations. |
| `api/src/db/migrations/0115_fleet_owned_native_update_keys.sql` | Historical migration scope and old-provider preservation fixtures; additive Kimi schema is introduced by migration 0130, never by rewriting old migrations. |
| `api/src/db/migrations/0126_hosts_agents_extra.sql` | Historical migration scope and old-provider preservation fixtures; additive Kimi schema is introduced by migration 0130, never by rewriting old migrations. |
| `api/test/integration/codex-164-feature-retirement-migration.test.ts` | Historical migration scope and old-provider preservation fixtures; additive Kimi schema is introduced by migration 0130, never by rewriting old migrations. |
| `api/test/integration/codex-166-retired-controls-migration.test.ts` | Historical migration scope and old-provider preservation fixtures; additive Kimi schema is introduced by migration 0130, never by rewriting old migrations. |
| `api/test/integration/codex-feature-retirement-migration.test.ts` | Historical migration scope and old-provider preservation fixtures; additive Kimi schema is introduced by migration 0130, never by rewriting old migrations. |
| `api/test/integration/db-migrations/claude-opus48-fast-mode.test.ts` | Historical migration scope and old-provider preservation fixtures; additive Kimi schema is introduced by migration 0130, never by rewriting old migrations. |
| `api/test/integration/db-migrations/fleet-owned-native-update-keys.test.ts` | Historical migration scope and old-provider preservation fixtures; additive Kimi schema is introduced by migration 0130, never by rewriting old migrations. |
| `api/test/integration/db-migrations/grok-170-native-controls.test.ts` | Historical migration scope and old-provider preservation fixtures; additive Kimi schema is introduced by migration 0130, never by rewriting old migrations. |
| `api/test/integration/db-migrations/grok-retired-memory-controls.test.ts` | Historical migration scope and old-provider preservation fixtures; additive Kimi schema is introduced by migration 0130, never by rewriting old migrations. |

### Historical documentation and evidence (44)

| Path | Reason |
|---|---|
| `docs/archive/README.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/archive/agent-messaging-2026.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/archive/agent-messaging-audit-2026-10-08.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/archive/agent-messaging-debug-2026-10-10.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/archive/communicator-audit-elvira-2026-10-13.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/archive/communicator-startup-native-elvira-2026-10-13.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/archive/communicator-startup-profile-claudine-2026-10-13.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/archive/engine-maintenance-2026-10-12.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/archive/gateway-matrix-2026-10-15.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/archive/grok-mcp-verification.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/archive/grok-tool-diagnostics-2026-10-08.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/archive/idle-sql-2026-10-24.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/archive/receiver-verification.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/archive/startup-performance-2026-10-15.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/bug-audit/2026-10-11-source.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/bug-audit/2026-10-11-triage.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/engine-maintenance-2026-10-16.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/engine-maintenance-2026-10-26.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/engine-maintenance-2026-10-28.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/engine-maintenance-2026-11-01.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/engine-maintenance-2026-11-06.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/engine-maintenance-2026-11-10.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/evidence/gateway-matrix-2026-10-15.json` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/redesign-verification-2026-10-25.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/verification/agent-communications-deep-dive-2026-10-25.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/verification/agent-communications-deep-dive-live-2026-10-25.json` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/verification/agent-message-timing-2026-10-25.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/verification/communicator-cache-transition-2026-10-23.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/verification/communicator-idle-cpu-2026-11-02.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/verification/communicator-residency-2026-10-14.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/verification/cxx-agent-mcp-audit-2026-10-25.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/verification/feedback-backlog-2026-10-25.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/verification/grok-private-reaper-2026-10-25.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/verification/lock-recovery-2026-10-25.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/verification/lock-recovery-live-2026-10-25.json` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/verification/login-visuals-2026-10-25.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/verification/mcp-runtime-fixes-2026-10-25.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/verification/mcp-tools-and-skills-audit-2026-10-25.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/verification/quota-emulation-2026-11-01.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/verification/server-communicator-agent-2026-10-25.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/verification/server-communicator-agent-live-2026-10-25.json` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/verification/server-sql-2026-10-25.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/workflows-acceptance.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |
| `docs/wrapper-review-2026-10-26.md` | Dated/archive evidence retains the engines actually observed; adding Kimi would falsely claim historical verification. |

### Scoped contracts and fixtures (85)

| Path | Reason |
|---|---|
| `DESIGN.md` | Dated design/verification history records the then-existing Codex/Claude/Grok surfaces; no current engine dispatch or allow-list. |
| `PLAN.md` | Historical implementation plan predating Kimi; not the active engine contract. |
| `REDESIGN.md` | Historical redesign plan and acceptance scope, not the active engine catalog. |
| `api/src/services/companion/quota-push.ts` | Only Grok has a monthly long-window label; other engines, including Kimi, use the generic short/weekly windows. |
| `api/src/services/connectors/oauth.ts` | Published OAuth metadata allow-list identifies hosted ChatGPT/Claude/Grok connector clients; Kimi Code is not a hosted connector provider. |
| `api/src/services/managed-skill-manager.ts` | Built-in creator examples name Codex skill-creator and Grok /create-skill; shared canonical Skill guidance already says all four engines. |
| `api/test/control-plane-messaging-totals.test.ts` | Chosen Grok portal/response rows exercise engine-neutral aggregation, not a supported-engine list. |
| `api/test/integration/admin-secrets/routes.test.ts` | Rejects retired engine-scoping fields; arbitrary Codex/Grok inputs are negative fixtures, not an allow-list. |
| `api/test/integration/admin-settings/model-defaults.test.ts` | Exercises Grok-specific context-window validation and native persistence. |
| `api/test/integration/control-plane/conference-open-or-join.test.ts` | Grok is a chosen outsider identity in conference isolation fixtures, not an engine enumeration. |
| `api/test/integration/control-plane/messaging-totals.test.ts` | Single-engine Grok rows exercise aggregation over real SQL, not supported-engine discovery. |
| `api/test/integration/host-api/fleet-counts.test.ts` | Mixed-engine fixture rows test host deduplication and timestamp bounds, not an engine list. |
| `api/test/integration/mcp-log-retirement.test.ts` | Historical removed-log migration fixture preserves old engine audit rows, not a supported-engine list. |
| `api/test/integration/provider-accounts/db.test.ts` | Grok subscription leasing fixture exercises verified-account filtering; Kimi has separate owner/usage integration suites. |
| `api/test/unit/chatty/administration-projection.test.ts` | Grok policy row is a selected optimistic-concurrency fixture, not engine routing. |
| `api/test/unit/chatty/knowledge.test.ts` | Grok renewal/billing questions test retrieval of Grok documentation; they do not enumerate runtime engines. |
| `api/test/unit/chatty/quota-tools.test.ts` | Grok is a chosen changed-account identity for policy CAS/refusal assertions. |
| `api/test/unit/companion/remote.test.ts` | Single Grok engine is a host-capacity fixture; availability predicates are engine-neutral. |
| `api/test/unit/companion/room-push.test.ts` | Chosen Grok room sender tests privacy-safe push projection, not engine selection. |
| `api/test/unit/control-plane/canonical-owned.test.ts` | Exercises Grok fenced rotation and captured-response ownership; equivalent Kimi rotation is tested in kimi-owner/kimi-response-capture suites. |
| `api/test/unit/ops/auth-verification-worker.test.ts` | Grok static-verification scenarios test its own engine namespace and disabled-engine behavior. |
| `api/test/unit/ops/docs-install-env-truth.test.ts` | Allow-list contains Grok installer environment names only where INSTALL documents them; it is not an engine list. |
| `api/test/unit/services/agent-activity.test.ts` | Grok activity source is a mismatched-source validation fixture; Kimi hooks have separate activity assertions. |
| `api/test/unit/services/auth-generation-retention.test.ts` | Backfills historical Grok OAuth credentials with Grok-specific fingerprint rules. |
| `api/test/unit/services/auth-traffic-verification.test.ts` | Grok access-only traffic snapshot is a provider-specific verification scenario. |
| `api/test/unit/services/claude-native-settings.test.ts` | Negative Grok cross-engine fixture proves Claude settings do not leak to another engine. |
| `api/test/unit/services/client-versions.test.ts` | Grok npm cache, minimum version and lock scenarios; Kimi binary versions are covered by kimi-version suites. |
| `api/test/unit/services/codex-model-support.test.ts` | Grok null-version comparison is a negative control for Codex version filtering. |
| `api/test/unit/services/codex-native-settings.test.ts` | Grok cross-engine fixture proves Codex schema validation is scoped to Codex. |
| `api/test/unit/services/communicator-cache.test.ts` | Chosen Grok RPC response tests generic cache normalization, not an engine catalog. |
| `api/test/unit/services/gateway-backends-model-line.test.ts` | Grok model proves non-Claude models have no Anthropic family line; Kimi gateway metadata has dedicated coverage. |
| `api/test/unit/services/install-token.test.ts` | Grok-specific dedicated-login and cancellation fixtures; Kimi seeding has its own contract tests. |
| `api/test/unit/services/provider-plan.test.ts` | Provider-specific Grok billing display-name parsing, not a supported-engine table. |
| `api/test/unit/services/quota-emulation.test.ts` | Grok monthly-vs-weekly normalization is provider-specific; Kimi quota behavior is covered in kimi-usage tests. |
| `api/test/unit/services/quota-observation.test.ts` | Grok monthly-period fixture proves no fabricated short window; Kimi has separate real window tests. |
| `api/test/unit/services/rtk-artifacts.test.ts` | One Grok query is an example of the engine-neutral authenticated RTK artifact URL builder. |
| `api/test/unit/services/runner-telemetry.test.ts` | Grok namespace-isolation assertions complement existing generic telemetry tests, not a complete engine table. |
| `api/test/unit/services/setup-status.test.ts` | Grok-only setup selection fixture proves other provider logins are not required. |
| `api/test/unit/services/shared-memories.test.ts` | Grok is a chosen second writer in a cross-engine CAS conflict, not a supported-engine list. |
| `api/test/unit/services/version-snapshot.test.ts` | Grok-specific snapshot/lock/cache isolation scenarios; Kimi version isolation has a dedicated suite. |
| `api/test/unit/services/wrapper-rollout.test.ts` | Legacy host rows intentionally omit newer engine columns to exercise compatibility and rollout cohorts. |
| `docs/connectors.md` | Hosted provider OAuth/DCR configuration is intentionally ChatGPT/Claude/Grok only; Kimi Code uses host MCP, not this connector flow. |
| `frontend/e2e/admin-feedback.spec.ts` | Chosen Grok claim owner and Claude reviewer fixtures exercise feedback ownership, not an engine list. |
| `frontend/src/lib/components/settings/engine-switch-consequences.test.ts` | Chosen Grok label/command/endpoint fixtures exercise the same parameterized copy builder for every engine. |
| `frontend/src/lib/components/settings/engine-switch-consequences.ts` | Import-free engine-neutral copy builder; Grok is only an example in its field comments. |
| `frontend/src/lib/legacy-admin-routes.test.ts` | Retains the arbitrary engine=grok query while redirecting historical URLs; no engine parsing occurs. |
| `frontend/src/lib/topology/model.test.ts` | Grok is a negative search term against a Claude node; search is engine-neutral. |
| `mobile/android/app/src/main/assets/third-party/lobe-icons-LICENSE.txt` | Unmodified upstream license attribution; never rewrite third-party legal text to insert an engine. |
| `mobile/android/app/src/main/res/drawable/ic_engine_grok.xml` | Grok vector artwork only; Kimi has a separate engine icon. |
| `mobile/android/app/src/test/java/io/uggs/orchestrator/NativeActivityTest.kt` | Activity state/expiry predicates ignore source; grok-session is one chosen fixture, not a source allow-list. |
| `wrappers/cxx/internal/agentbus/activity_test.go` | Grok ACP state mapping and unavailable leader observation are Grok-only. |
| `wrappers/cxx/internal/agentbus/discovery_errors_test.go` | Grok discovery filter and legacy ACP automatic-receiver tests; Kimi hook receiver has separate coverage. |
| `wrappers/cxx/internal/agentbus/mcp_catalog_compatibility_test.go` | Grok MCP doctor export is an optional consumer of the shared catalog, not engine routing. |
| `wrappers/cxx/internal/agentbus/native_transcript.go` | Grok-specific durable transcript checker; dispatch calls the separate Kimi transcript checker. |
| `wrappers/cxx/internal/agentbus/native_transcript_test.go` | Tests Grok transcript availability and ambiguous startup errors; Kimi transcript checks have dedicated tests. |
| `wrappers/cxx/internal/agentbus/poll_test.go` | Grok must ignore imported Claude hooks; Kimi dialect polling and portal rings are tested in kimi_test.go. |
| `wrappers/cxx/internal/agentbus/receiver_admission_test.go` | Codex/Grok queue submit admission barriers; Kimi is hook-driven and has no idle queue submission. |
| `wrappers/cxx/internal/agentbus/turn_release_test.go` | Codex/Grok queue native-turn proof scenarios; Kimi releases through its own hook lifecycle. |
| `wrappers/cxx/internal/agentportal/identity_args_test.go` | Tests legacy CLI identity flags; Kimi uses a private AGENTS.md overlay and has dedicated identity tests. |
| `wrappers/cxx/internal/agentportal/workspace.go` | Only Codex -C/--cd and Grok --cwd change CLI cwd here; Kimi has no equivalent --cwd flag and uses the process cwd. |
| `wrappers/cxx/internal/agentportal/workspace_test.go` | Legacy native cwd flag grammar fixtures; Kimi process-cwd behavior is tested separately. |
| `wrappers/cxx/internal/communicator/connection_matrix_test.go` | Chosen Grok leases/session rows exercise generic connection accounting; row construction iterates engine constants. |
| `wrappers/cxx/internal/communicator/revocation_recheck.go` | Comment explains Grok reconnect behavior; recheck implementation is an engine-neutral callback policy. |
| `wrappers/cxx/internal/communicator/revocation_recheck_test.go` | Tests Grok lease-reconnect confirmation; Kimi Runtime.RefreshConfirmed has its own tests. |
| `wrappers/cxx/internal/communicator/sync_test.go` | Grok broker-scope and auth-transport scenarios exercise its legacy readiness adapter. |
| `wrappers/cxx/internal/config/golden_test.go` | Immutable signed legacy config goldens intentionally preserve original engine sets/bytes; Kimi config is tested independently. |
| `wrappers/cxx/internal/cron/destroy_test.go` | Grok is a chosen engine in idempotent destroy retry fixtures, not engine discovery. |
| `wrappers/cxx/internal/housekeeping/detail.go` | Grok process argv is an example for the engine-neutral safe diagnostic formatter. |
| `wrappers/cxx/internal/housekeeping/recovery_test.go` | Grok env-prefixed argv is a process-recognition fixture, not a supported-engine list. |
| `wrappers/cxx/internal/housekeeping/sqlite_test.go` | Grok-only external-content FTS deletion behavior; Kimi has no corresponding SQLite FTS layout. |
| `wrappers/cxx/internal/ipc/shared_transition_test.go` | Grok-named lock is an arbitrary key for generic shared/exclusive lock semantics. |
| `wrappers/cxx/internal/launchpad/obsidian.go` | Grok-only reasoning-engine label and absence of weekly quota; all engine card positions already support Kimi. |
| `wrappers/cxx/internal/libcselect/reconcile.go` | glibc-before-musl selection is limited to Codex, Claude and Grok, whose providers publish (or may publish) both libc variants. Kimi Code publishes exactly one Linux binary per architecture in its manifest, so there is no libc choice to reconcile. |
| `wrappers/cxx/internal/maintenance/maintenance_test.go` | Grok-specific native-path and child-environment fixtures, not an engine catalog. |
| `wrappers/cxx/internal/memoryrouting/routing.go` | Comment mentions Grok private projection; dispatch and Kimi routing live in the engine-specific targets implementation. |
| `wrappers/cxx/internal/memoryrouting/routing_test.go` | Tests Grok generated memory-v2 index recovery; Kimi has no Grok memory-v2 tree. |
| `wrappers/cxx/internal/nativeargs/args_test.go` | Pinned Codex/Grok grammar and help oracles; Kimi has a separate native option grammar and tests. |
| `wrappers/cxx/internal/nativeargs/auth_test.go` | Codex/Grok auth grammar cases; Kimi login/logout grammar is independently tested in kimi_test.go. |
| `wrappers/cxx/internal/sessionguard/guard_test.go` | Grok shared session-lease probing does not describe Kimi session storage. |
| `wrappers/cxx/internal/skillstore/store_test.go` | Grok is only the display label on a temporary generic skill store. |
| `wrappers/cxx/internal/terminalui/notice_test.go` | Two arbitrary engine rows test column alignment, not the fleet engine inventory. |
| `wrappers/cxx/internal/terminalui/parity_test.go` | Grok-specific cyan-vs-success-green assertion; Kimi accent has separate coverage. |
| `wrappers/cxx/internal/terminalui/screen_test.go` | Grok-only unavailable-quota copy fixture; generic screen layout is shared. |
| `wrappers/cxx/internal/terminalui/update_run_test.go` | A single Grok update row tests deduplication and completion, not a fleet engine list. |
| `wrappers/scripts/receiver-canary.py` | Interactive idle-push canary only (Codex queue, Claude channels, Grok ACP); Kimi has no idle push and its native hook canary is separate. |
| `wrappers/testdata/host-grok.json` | Signed historical Grok golden bytes, not a current host-engine allow-list. |


## Native speech input policy

`GET /admin/speech-input` reads the global default and all four engine overrides.
`POST /admin/speech-input/:target` accepts `{ "enabled": true|false }` for `global`; engine targets also accept `null` to inherit. Global defaults to on. Engine overrides win. Settings require settings.read/settings.manage. Changes apply after sync to new launches and never begin recording.

Claude 2.1.92+ projects `voice.enabled` while preserving other voice settings; it requires a Claude.ai account and a local microphone. Grok 1.0.75+ projects `ui.voice_keybind_enabled`; disabling the shortcut does not disable `/voice`. Codex supports `/voice` conversations but has no verified central toggle in 0.167.2; removed flags are not written. Kimi has no verified native speech support. Unsupported control is reported separately from requested policy.
