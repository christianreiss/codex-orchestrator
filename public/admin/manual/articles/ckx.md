---
title: Kimi Code (ckx)
section: Fleet operations
category: Fleet operations
summary: Dedicated device login, centralized renewal, quota windows, hook reception and opt-in gateway.
verified: 2026-11-12
sources: docs/interface-ckx.md
---

Kimi Code is the fourth engine (`kimi`). Select **Kimi Code** when registering a
host; any nonempty engine combination is supported. `ckx` launches Kimi through
the same signed `cxx` binary as `cdx`, `clx` and `cgx`. The supported CLI is
MoonshotAI's native Kimi Code binary; the archived Python `kimi-cli` is not used.

## Subscription login

Use `ckx login` or the Accounts one-time command. They perform a dedicated device
login in a throwaway `KIMI_CODE_HOME`, upload `credentials/kimi-code.json` plus
`device_id`, then delete that home. Only the server holds and rotates refresh
tokens. Do not paste credentials still used by another Kimi process.

Canonical JSON contains `kimi_code` (access token, refresh token, numeric
`expires_at`, `expires_in`, `scope: "kimi-code"`, `token_type: "Bearer"`),
`device_id` (32 hex characters), `oauth_host`, `base_url` and RFC3339
`last_refresh`. Hosts receive an access-only projection with empty refresh token
and zero expiry, refreshed by the communicator when canonical access changes.

## Models, native settings and usage

Open Engines → Kimi Code (`/engines?engine=kimi`). Version, model and thinking
effort are independent of other engines; supported efforts are `low`, `high` and
`max`. Host exceptions can override each. Native settings preserve user-owned
keys; consult the linked Kimi configuration reference before editing.

Accounts and Overview show server-polled 5-hour, optional weekly, monthly total
and monthly code windows with reset times and observation age. Weekly is absent
on plans that do not report it. Missing windows stay unknown. The 5-hour and
weekly windows participate in quota warnings and hard limits; monthly windows
remain visible as provider observations.

## Managed launches and messages

The wrapper owns a private `KIMI_CODE_HOME`, native `skills/`, `AGENTS.md`,
`mcp.json` and its access-only credentials. Managed launches disable telemetry
and native auto-update. Claude-specific artifact editors and Codex profiles
remain engine-specific. Kimi has no OS sandbox; posture controls native
permission mode and permission rules.

The `kimi-hooks-v1` receiver uses UserPromptSubmit and Stop hooks. Messages to an
idle session wait for its next prompt or turn end (`after_turn`). Queue admission
is distinct from a reply and from completion. There is no idle injection channel.

## HTTP gateway

Access → Configure → Routing exposes `/kimi/v1` with OpenAI-shaped requests and
`sk-ckx-` orchestrator keys. **The surface starts disabled.** Enable it explicitly
after reviewing whether subscription-backed third-party gateway use fits your
terms. The fleet master switch, surface switch and per-key backend selection
remain independent. Managed `ckx` hosts do not require gateway opt-in.

Backend defaults provides Kimi's gateway model and per-model gates. Disabled
models leave `/kimi/v1/models` and are refused at inference. Use the model list
from your configured endpoint rather than a model from another provider.
