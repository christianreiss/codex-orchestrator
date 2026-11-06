# Native configuration scopes

Codex 0.166 rejects newly authored `features.code_mode_tool_description_first`
(removed) and `features.guardianv2.async_classifier_mode` (ignored) in both
structured/native root settings and profile sidecars. Stored normalization and
migration 0121 strip those exact paths while retaining sibling Guardian controls,
literal map names and historical TOML/hash snapshots.

The Engines page authors fleet **user defaults**: Codex `config.toml` and named
profile sidecars, Claude `settings.json`, and Grok `config.toml`. The generic
editors complement the existing model, effort, posture, MCP and authentication
controls. This is not a claim that every native file or enterprise policy plane
can be authored centrally. Coverage was reviewed against Codex 0.167.0
(2026-11-06), Claude Code 2.1.318 (2026-11-06) and Grok Build 1.0.77 (2026-11-06).

| Engine | Centrally authored | Remains native-owned | Decision and reason |
| --- | --- | --- | --- |
| Codex | Current user configuration and named profile layers | System `requirements.toml`, MDM and cloud Agent Security policy; repository config | Requirements enforce constraints with separate authority and platform/cloud applicability. Writing them as user defaults would not enforce them. Repository policy belongs to that repository. |
| Claude | Current user `settings.json`; managed MCP entries and existing native artifact collections | General `managed-settings.json`/drop-ins and cloud enterprise policy; global preferences/state in `~/.claude.json`; project/local settings; Desktop-only `sshHostCommands` | Native global state also contains sign-in and project trust. Native `/config` owns its local preferences. Enterprise policies take precedence over defaults and require a separate policy deployment contract. The existing narrow channels-policy drop-in remains supported. |
| Grok | Current user `config.toml`, including references to local sandbox profiles | `managed_config.toml`, signed `requirements.toml`/MDM, `pager.toml`, custom sandbox profile files and project configuration | Managed defaults and enforced signed requirements have different precedence. Machine-local UI customizations and filesystem-specific sandbox artifacts remain provisioned on their host; the config editor may select an existing profile. |

These exclusions preserve the engines' native configuration layering; they do
not disable externally provisioned policy. Config editors do not distribute
referenced files. A path setting can be authored centrally while its referenced
file must already exist where the native engine expects it. Authentication,
account refresh, updater selection and managed MCP ownership continue through
their existing fleet controls. Native updater keys are therefore rejected in the
user-settings editors with that reason: Claude `autoUpdatesChannel` and
`minimumVersion`; Grok `cli.auto_update = true`, `cli.channel`, `cli.channels.<name>`,
`cli.minimum_version`, `cli.maximum_version`, `cli.required_minimum_version`,
`cli.required_maximum_version`, `cli.npm_registry` and `cli.installer` (root and
`version_overrides`). Migration 0115 removed previously stored values.

Grok user defaults and supported version layers reject numeric values outside
the stable 1.0.70 reference's documented bounds, rather than let the native CLI
silently clamp them. This covers batch-Dream budgets, prompt suggestions,
long-reasoning reminders, per-model compaction percentages and subagent retry
attempts; [the exact ranges](interface-cgx.md#native-configuration-maintenance-2026-10-26)
retain native number-versus-integer types. Invalid historical snapshots remain
available for explicit correction with their original body/hash and a validation
error; this validation change performs no data migration.

Use the official native mechanisms for the separate scopes:

- [Codex configuration and requirements reference](https://learn.chatgpt.com/docs/config-file/config-reference#requirementstoml).
- [Claude files and precedence](https://code.claude.com/docs/en/settings) and
  [managed settings deployment](https://code.claude.com/docs/en/managed-settings).
- [Grok complete configuration and precedence reference](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/26-config-reference.md)
  and [current configuration guide](https://docs.x.ai/build/settings).

Wrong-scope input is not silently accepted as support. Claude reports managed-only
and global-only keys explicitly; Codex identifies requirements-only root keys and
rejects other unknown schema keys. Grok rejects keys outside its current user
configuration registry, with removed memory controls rejected on new input and
removed from saved settings by migration 0072 (including version layers). Existing
body/hash pairs remain historical snapshots until the next save; generated host
config and validation previews use the migrated settings. A key shared by multiple
native scopes is authored here only with **user-default** semantics, never as an enforced requirement.

## Native version compatibility

Nonempty Codex native settings, including profile native settings, require a
reported native CLI version of at least 0.162.1. Fields introduced in 0.163.0
raise the floor to 0.163.0 only when configured, even when false or empty: environment
context time, async compaction and the new feature switches, the new multi-agent
options, plugin defaults, global leader binding, selection clearing, Windows MXC,
government-cloud guidance and the new realtime voices. This checks both root and
profile settings, including structured feature/notice controls, using exact field
paths. Opaque plugin/MCP names never trigger a version gate. Existing supported
values retain the 0.162.1 floor. New 0.164.0 fields require 0.164.0 only
when configured: TUI presets/open-presets binding, model-request hooks, hook
content trust metadata, remote-plugin provisioning metadata, new feature
switches/runtime-agent options, EMA token authentication methods/IdP secrets
and MITM version/scoped ports/schemes/credential placeholders. New 0.165.0
fields require 0.165.0 only when configured: the `guardianv3`,
`guardian_recorded_items`, `prediction_preserve_parent_tools` and
`tui_multi_backend` feature switches, `auto_review.timeout_ms`, and
`model_provider = "gcp"`. Both root and profile fields are checked; map names
remain opaque, so a `model_providers.gcp` entry is not gated, but its native
built-in field limits are validated during authoring (see
[Codex 0.165 maintenance](interface-cdx.md#native-configuration-maintenance-codex-01650)).
New 0.166.0 fields require 0.166.0 only when configured: eight new feature switches,
rollout-budget enforcement, memory consolidation service tier, transcript-selection
binding, provider project/location/ADC fields, OpenAI catalog routing and scoped
MITM signing/body substitutions. The editor validates native provider and proxy
constraints without reading referenced credentials. All keybinding actions also
validate the exact native string/chord grammar; alternatives and explicit `[]`
unbinding preserve authored values. Older binding actions keep their older floor. See
[Codex 0.166 maintenance](interface-cdx.md#native-configuration-maintenance-codex-01660).
New 0.167.0 fields require 0.167.0 only when configured: seven new feature switches,
`otel.log_sse_deltas`, custom provider `capabilities.cyber_access_programs` and
`gateway_oauth.credentials_store`, and plugin `apps` connector settings.
`cli_auth_credentials_store` is wrapper-owned at every version: only omission or
`"file"` is accepted, because the wrapper syncs `auth.json`. See
[Codex 0.167 maintenance](interface-cdx.md#native-configuration-maintenance-codex-01670).
Claude native settings require
2.1.296, or 2.1.305 when `native_settings.sandbox.allowNestedUserNamespaces`
is present (including `false`). This opt-in boolean defaults to false; true
allows sandbox escape and disables the sandbox as a security boundary. Only
user/managed settings can enable it; subprocess environment scrubbing overrides true.
`native_settings.permissions.blockWritesOutsideWorkingDirectories` requires
2.1.314 whenever present, including `false`. With `true`, native Write, Edit and
NotebookEdit refuse writes outside the working directories in every permission
mode; it stays unset unless authored. Removing it withdraws that leaf only.
Claude Desktop 3.6556.0+ owns `sshHostCommands`; CLI defaults reject it with a scope explanation.
Older or unreported versions receive an actionable config validation
error with observed and required versions. Empty extensions and existing
structured-only settings do not raise either fleet-wide minimum. Grok already
enforces its 1.0.50 native floor. Grok additions use exact conditional floors:
1.0.63 for hook args/program status, 1.0.67 for inherited worktree approvals,
1.0.68 for Vim keys (1.0.71 for `keys.vim = "all"`), 1.0.70 for additions without
a proven earlier release, and 1.0.71–1.0.77 for the 1.0.77 audit's additions.
Only applicable version overrides contribute to the floor. Native experiments
and independent Cursor-worker settings are rejected because they require separate
rollout-state and auth/session-lifecycle ownership. Project Grok configuration
remains native-owned and supports MCP/plugins/permissions plus
`mcp.max_output_bytes`. Literal-key ownership independently requires
cxx 0.9.66 where documented.

Admin validation and previews require no host. Before host sync, `cdx update`,
`clx update` and `cgx update` install and report the actual CLI version. Maintenance cron reports
the observed installed version before retrieving version-gated configuration,
including after an update. Its update/check/report routes remain usable when
config rendering is gated. Run `cdx cron run`, `clx cron run` or `cgx cron run` to refresh a stale
version report after an external installation. A config error is not proof that
an update succeeded or that a running session adopted new settings.

## Codex profile editor

The separate **Codex profiles** editor uses an array of
`{name, model?, model_reasoning_effort?, native_settings?}` objects. Names are
file-safe and unique. Omit model or effort, or set them to null, to inherit the
underlying config layer. Current model IDs and effort values appear beside an
example. Other native fields go inside `native_settings`; model and effort stay
outside it. Existing unrepresented structured profile fields are preserved.

Validation previews each `<name>.config.toml` separately. Adding an entry creates
a managed profile; removing one withdraws it through the existing wrapper
ownership manifest on the next sync. The editor rejects conflicting edits and
protects a concurrently changed profile from removal. Saves retain the config
document revision check, including for sidecar-only changes that leave the root
TOML digest unchanged.


### Native model availability

Fleet model authoring is independent of a host installation. Host-specific Codex
rendering checks effective root/profile choices and latest-family mapping against
the reported installed CLI version. Desired version pins do not establish support.
Signed bootstrap remains available for recovery; launchpad and wrapper execution
check the actual native binary and retain unavailable selections without fallback.
See [Terra native availability](interface-cdx.md#gpt-61-terra-native-availability).
