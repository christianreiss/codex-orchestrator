# ckx — Kimi Code fleet wrapper

Kimi is the fourth engine (`kimi`). The wrapper persona is `ckx` (relative
alias of the one `cxx` binary, like `cdx`, `clx` and `cgx`); the managed native
command is `kimi`. The supported CLI is **Kimi Code CLI** (MoonshotAI
`kimi-code`, TypeScript, shipped as a native binary). The archived Python
`kimi-cli` (PyPI, `~/.kimi`) is not supported and is never installed.

Grok (`docs/interface-cgx.md`) is the structural template: Kimi uses the same
server-owned subscription refresh with access-only host projections, native
on-disk Skills, a private managed home and server-polled usage. The
differences are listed under *Intentional deltas*.

## Contract (frozen 2026-11-12; every component uses these names)

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
  scoped key, and the provider's `oauth.key` names the scoped key.
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
| `AGENTS.md` | wrapper | fleet instructions (digest in `~/.ckx/state`, the Kimi state dir mirroring Grok's `~/.cgx/state`) |
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
`--auto`/`--yolo`. The prompt travels as argv (no prompt-file option).

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

Hook commands (written by the wrapper as `[[hooks]]` entries, `timeout = 30`):
`cxx agent poll --hook UserPromptSubmit --dialect kimi` and
`cxx agent poll --hook Stop --dialect kimi`. The `kimi` dialect maps the
existing Claude ring onto Kimi's hook protocol: `UserPromptSubmit` prints the
pending-message notice as plain text on stdout and exits 0; `Stop` with pending
deliveries prints the continuation text on stderr and exits 2 (block);
nothing pending, or any error, is an empty exit 0 (Kimi hooks fail open).

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
- Gateway surface disabled by default (see Identity).
- Live verification of device login, refresh and `/usages` requires a Kimi Code
  subscription credential, which the fleet secret store did not hold on
  2026-11-12; those paths are built from the 2.5.3 source and covered by mocks.
