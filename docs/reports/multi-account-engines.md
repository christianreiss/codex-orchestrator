# Multiple accounts with live switching for Codex, Grok and Kimi — consolidated plan

Status: research and design only, recorded 2026-11-26 at `main` 742d209ba (cxx 0.9.211). Nothing here
is implemented. Per-engine evidence (source references, upstream citations, lab checks) lives in
[multi-account-codex.md](multi-account-codex.md), [multi-account-grok.md](multi-account-grok.md) and
[multi-account-kimi.md](multi-account-kimi.md). Items marked † or [LAB] there are not verified facts.

## Where each engine stands today

All four engines already lease one pool account per launch (`wrappers/cxx/internal/accountpool`) and
show pool advice on the card, `status` and `doctor`. Only Claude switches a running scope
(`LIVE_SWITCH_ENGINES = {'claude'}` in `api/src/services/account-switch.ts`). Codex, Grok and Kimi
apply policy moves at the next launch and have no `accounts list|add|use`, no `account_status` /
`account_switch` MCP tools and no quota-limit producer for quota-continue.

| Engine | How the native CLI takes credentials mid-session | Feasible switch | Gate before rollout |
|---|---|---|---|
| Codex | Caches `auth.json` in memory; every reload refuses another `account_id` and fails the turn. The in-process token swap is internal-only upstream. | Supervised **restart** of the wrapper-owned `codex app-server` at an idle point; the `--remote` TUI reconnects and resumes the same thread. Workers and `cdx exec` switch at their next launch. | Lab test with two ChatGPT accounts: cross-account thread continuation (`invalid_encrypted_content`), TUI reconnect under restart, `cli_resume_account_check` pinned off. |
| Grok | The private leader watches `$GROK_HOME/auth.json` (1 s debounce) and hot-swaps the credential; requests are stateless. | **Live**: write the target account's full access-only projection into the launch's private home at an all-idle boundary; headless and `--no-leader` runs switch at the next launch. | Live test with two subscriptions: native release drift (source 1.0.46+ vs fleet 1.0.92), history with `encrypted_content` replaying on account B, a captured credit-exhaustion error. |
| Kimi | Re-reads `credentials/kimi-code.json` on every LLM request, no cache; projection `expires_at: 0` never refreshes. | **Live** rewrite of the access-only projection, but `X-Msh-Device-Id` is fixed at process start and differs per account. Until proven, **restart** (resume with `-S`) at an idle turn. | Live test with two subscriptions: does the provider accept B's token with A's device id? Region and `base_url` are fixed at start, so a cross-region switch is never live. |

## One shared design (reconciles the three proposals)

1. **Capability per lease.** One lease column `switch_modes` (set of `live`, `restart`; empty = the
   launch cannot switch, which is every older wrapper). The launch advertises what it can do; the
   policy worker and reaper only move or reap leases that advertise a mode. Codex advertises
   `restart`, Grok `live` (leader launches only), Kimi `restart` until the device-id test passes,
   then `live` for compatible pairs. Supersedes the three per-engine shapes (Codex `apply|transient`,
   Kimi `switch_modes`, Grok boolean `live_switch`). The migration number is assigned when the work
   starts (0151 and 0152 are taken by provider keys and quota-continue).
2. **Scope unit is the engine's credential home.** Grok and Kimi: one scope per launch (each has a
   private home). Codex: the auth directory (`~/.codex` is shared), so any session there that cannot
   restart its backend blocks commits while it runs, exactly like Claude siblings.
3. **Commit response per engine (prerequisite, must land first).** `POST /auth/sessions/switch` returns
   the full canonical credential today. That is correct for Claude and Codex (host-owned refresh) and
   would break the single-refresher contract for Grok and Kimi. Each engine gets its own branch: Grok
   and Kimi return the access-only projection; the route refuses an engine without a branch. Today the
   route is safe only because `commitSwitch` is gated to Claude (`account-switch.ts:561`).
4. **Supervisor core moves into `accountpool`** (heartbeat → directive → idle gate → flush → commit →
   CAS write → confirm), with engine adapters: Claude (existing), Codex (restart app-server), Grok
   (write projection, confirm over the leader ACP socket, re-bind the auth watcher), Kimi (rewrite
   projection or restart with `-S`).
5. **Identity rules match Claude's** for every engine: refuse an unattributable login, keep a removed
   account removed until an explicit enrolment, no enrolment of a new identity from an insecure host.
   Identity keys: Codex `account_id` (plus `chatgpt_user_id` if workspace seats are pooled), Grok
   `user_id`, Kimi `/me` `user_id`.
6. **Quota-continue producers.** Codex: the structured `usageLimitExceeded` error only. Grok: the
   credit-exhaustion text on `rate_limit` corroborated by the billing reading (needs a captured sample).
   Kimi: HTTP 429 `exceeded_current_quota_error` (`APIProviderQuotaExhaustedError` in the hook).
   "At capacity"/"overloaded" never mark an account exhausted. Kimi cannot inject a prompt while idle,
   so an interactive Kimi session switches and shows a notice instead of continuing on its own.
7. **Usage attribution** is exact by construction for all three (the server pulls each account's usage
   with its own token); the gap is freshness (Codex up to 15 min, Kimi 5 min). Trigger a refresh after
   each committed switch.

## Order of work once the decisions below are made

1. Commit-response branches per engine and the `switch_modes` column (no behaviour change).
2. Identity hardening per engine.
3. Supervisor extraction into `accountpool`; Claude stays byte-for-byte equivalent (its tests guard it).
4. `cdx|cgx|ckx accounts list|add|use` and the MCP account tools for every engine (`add` logs in
   through an isolated temporary home and uploads with `enroll: true`).
5. Per engine, after its live test passes: adapter, add the engine to `LIVE_SWITCH_ENGINES`, quota
   producer, docs (`interface-cdx|cgx|ckx|api|db`), CHANGELOG, VERSION.

## Decisions for the operator

1. **Live tests.** Each engine needs a test with two real subscriptions on a disposable host user
   (real credits). Who provides the second Codex, Grok and Kimi account, and is the test approved?
2. **Restart cost.** Is a visible backend restart (Codex app-server, Kimi `-S` resume) acceptable for
   every automatic policy move, or only for urgent moves (account exhausted, paused, unverified)?
3. **Codex enrolment rule.** Adopt Claude's rule (no automatic enrolment of a new identity from a plain
   host sync)? It changes documented behaviour in `docs/interface-cdx.md`.
4. **Codex workspace seats.** Are several seats of one ChatGPT Business/Team workspace pooled? Then the
   identity key must include `chatgpt_user_id`.
5. **Grok plan mismatch.** Switch only to an equal-or-higher plan, or allow and accept that the current
   model may be unavailable?
6. **Scoring.** Should Grok's billing window and Kimi's monthly windows drive balancing (today Grok's
   reading is observation only and Kimi's monthly windows are not scored)?
7. **Kimi device id** if the provider binds it: switch live only between accounts sharing a device id,
   or pre-seed one fleet device id at enrolment (risks provider-side account linking)?

## Pre-existing defects found by the research

| Defect | State |
|---|---|
| `ckx login` refuses a dashed-UUID device id (`app/kimi/login.go` `validDeviceID`), while the server (`kimi-auth.ts`), the runtime (`kimi/runtime.go`) and the runner accept it. kimi-code mints a dashed UUID when no `device_id` file exists. | Verified in code; fix scheduled with the next wrapper release. |
| A second Kimi subscription logged in with `ckx login` replaces the only Kimi account's credentials: Kimi logins carry no identity, so the sole account takes the upload (`provider-accounts.ts`), and the login retries its generation conflict against it. | Verified in code; needs the `/me` identity lookup (shared design point 5). Filed as orchestrator feedback. |
| The switch-commit route returns the full canonical credential. | Latent: gated to Claude. Covered by shared design point 3. |
| The Kimi poll hook reports `Stop` activity before deciding to block (`agentbus/kimi.go`). | Minor; filed as orchestrator feedback. |
| `docs/interface-cdx.md` said leases heartbeat every 30 s; the code uses 90 s (`accountpool/context.go`). | Corrected with this report. |
