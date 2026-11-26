# Multi-account live switching for Kimi Code (`ckx`): design

Status: research and design only; nothing in the repository was edited. Repo `main` @ 742d209ba
(cxx 0.9.211). The upstream is MoonshotAI **kimi-code** (TypeScript; the supported CLI, not the archived
Python `kimi-cli`). It is pinned to tag `@moonshot-ai/kimi-code@2.8.1`, commit
`62402f173c5a838a1c1f8fa263b637a22486fa39`, and the credential path was cross-checked at 2.5.3 and 2.7.2.
Date: 2026-11-26.

**All upstream paths** in this file (`packages/...`) are relative to
`https://github.com/MoonshotAI/kimi-code/blob/62402f173c5a838a1c1f8fa263b637a22486fa39/` (2.8.1). The
cross-checks were made at the tags `@moonshot-ai/kimi-code@2.5.3` and `@moonshot-ai/kimi-code@2.7.2`, via
`gh api …/contents/<path>?ref=<tag>`. I treated the upstream source as data.

Evidence tags:

| Tag | Meaning |
|---|---|
| **[src]** | Read in the upstream source. |
| **[repo]** | This repository's code. |
| **[doc]** | This repository's docs. |
| **[canary]** | Can be proven offline with the existing loopback-provider canary harness and the real binary. |
| **[live]** | Needs a live subscription test, and two subscriptions where noted. |

## 0. Verdict

**A full live switch is feasible, according to the source. It needs much less machinery than Claude, but it is gated on one live acceptance test.**

**Why it works.**
- Kimi Code reads `$KIMI_CODE_HOME/credentials/kimi-code.json` from disk on every LLM request
  [src, 2.5.3, 2.7.2 and 2.8.1]. It has no in-memory token cache.
- With the fleet's access-only projection (`expires_at: 0`, `refresh_token: ""`) it never refreshes and
  never writes the file [src].
- So a switch means two things. The server commits the scope to account B. The wrapper then atomically
  rewrites the private credentials file with **B's access-only projection**. The next request, even one
  in the middle of a turn, goes out as B.

**What Claude needs that Kimi does not.**
- No flush of the old account's rotation: the server is the only refresher.
- No native CAS against a refresh: native never writes the file.
- No sibling machinery: the design uses a per-launch scope, see §3.

**Blocking caveat.**
- Kimi sends `X-Msh-Device-Id` on inference requests. The CLI computes it **once, at process
  bootstrap**, from the `device_id` file [src].
- The fleet stores a `device_id` per account: each login keeps its own.
- After a live switch, B's bearer token therefore travels with A's device id.
- Whether api.kimi.com binds access tokens to the device id is unknown [live].
- The same freeze applies to `base_url` and the OAuth key, which the CLI reads from `config.toml` at
  start. A switch between regions (`.cn` and `.ai` hosts) can therefore never be live.

**Recommendation.**
1. Ship the live path behind the acceptance canary.
2. Live rewrite is allowed when target and current share `oauth_host`/`base_url` and either share the
   `device_id` or the canary proved that a mismatched device id is accepted.
3. Otherwise use the fallback: a supervisor-driven native restart at an idle turn boundary that resumes
   the same `session_<UUID>` with `-S` on B. This is interactive only.
4. Headless `-p` runs that cannot switch live stay with launch-time selection. The next launch or Wake
   picks the best account.

**What first ship actually delivers.** Every enrolment mints its own `device_id`, and the mismatch flag is
off until the live canary passes. Until then, **the live rewrite is effectively inert**: almost no pair of
accounts qualifies.
- Without the canary, first ship must therefore include the **restart fallback** for interactive launches
  (plan step 8b). Headless launches stay launch-time.
- If the operator runs the two-subscription canary first and it passes, the live rewrite becomes the main
  path and the restart fallback drops to the region-mismatch case only.

No live Kimi credential was in the secret store as of 2026-11-12, so the canary needs the operator.

---

## 1. Current state (what exists, what is missing compared with Claude)

### Server
- **Pool, leases and scopes are engine-generic.** `provider_account_sessions` has `scope_id`,
  `binding_generation`, `desired_*` and `bound_at` (api/src/db/schema.ts:233-255) [repo].
- **Kimi lease.** `POST /auth/sessions` has a Kimi branch (api/src/routes/auth/index.ts:316-340). It
  returns the access-only projection through `createKimiAuthOwner().ensureFresh({bootstrapSession:true})`.
  It does **not** add `sessionExtras` (binding generation, pending switch) (:185-188, gated on
  `LIVE_SWITCH_ENGINES`) [repo].
- **Heartbeat** (:371-399). For Kimi and Grok it returns `ensureFresh` freshness fields and skips
  `sessionExtras` [repo].
- **`/auth` retrieve for Kimi** (:1046-1100). It serves the projection through
  `ensureFresh({accountId, sessionId})` and pins it to the lease [repo].
- **`GET /auth/accounts` and `quota_pool`** (:428-498) are served with `live_switch: false` [repo].
  The display has existed since 0.9.209 (docs/interface-ckx.md:370-377) [doc].
- **Live switching is gated by** `LIVE_SWITCH_ENGINES = new Set(['claude'])`
  (api/src/services/account-switch.ts:31). The set is checked in:
  - `requestSwitch` :461
  - `commitSwitch` :561
  - `evaluate` :822
  - `poolRecommendation` :768
  - the policy worker and lease reaper (api/src/ops/account-policy-worker.ts:28,35,40)
  - the frontend: `AccountPolicy.svelte:31` and `AccountGroupRow.svelte:46-47` hard-code `engine === "claude"`

  Kimi requests get 409 `account_switch_unsupported_engine` (docs/interface-api.md:2535-2707) [repo/doc].
- **`enforceAccountSession`** (routes/auth/index.ts:2027-2043) returns 400 "Account does not match
  session" for every engine except Claude [repo].
- **The commit route leaks the refresh token.** It returns
  `runnerValidation.canonicalAuthFromPayload(row)`, the full canonical credential **including the
  refresh token** (routes/auth/index.ts:563-574) [repo]. Adding Kimi to the set without a Kimi branch
  would ship the refresh token to hosts and break the single-refresher contract. See the Appendix.
- **Refresher.** `kimi-auth-owner.ts` `ensureFresh` refreshes when fewer than `max(300, expires_in/2)`
  seconds remain (:301-307). `assertSession` (:471-502) requires `lease.accountId === accountId` and an
  attached provider for a connection lease. When the call is not session-bound, the account must be
  enabled (:118-119) [repo].
- **Usage.** `kimi-usage.ts` polls `/usages` (and `/me` for the plan) per **enabled** account with that
  account's own token:
  - `KIMI_USAGE_INTERVAL_MS = 300_000`, stale after `KIMI_USAGE_STALE_MS = 600_000`.
  - `readKimiUsage` scores short = `five_hour` and weekly = `limit_7d`. `limit_7d` exists on legacy plans
    only (docs/interface-ckx.md:209-216).
  - Monthly windows are not scored [repo/doc].
- **Identity.** `providerIdentity()` reads `auth.account_identity` for Kimi
  (api/src/services/provider-accounts.ts:48-55). `normalizeKimiAuth` whitelists fields and drops it
  (kimi-auth.ts). So every Kimi login is opaque and keyed `credential:<fingerprint>` [repo].
- **Enrolment.** `enroll: true` on store is engine-generic (routes/auth/index.ts:1597-1669, secure host
  only). An untargeted seed token enrols a new account (install route, `enrollAccount: row.accountId == null`;
  Python seed script in install-token.ts:384+) [repo].

### Wrapper
- **Lease.** `accountpool.Load("kimi", filepath.Join(baseHome, "auth.json"), …)`
  (wrappers/cxx/internal/app/kimi/main.go:720), then `pool.Start` and `rt.Initialize` (:779-808).
  - The **scope is the shared base home**, so every launch on the host has the same `scope_id` and binding file.
  - The credentials, however, live in a private **per-launch** runtime under
    `~/.ckx/state/runtimes/session-*/home/` (internal/kimi/runtime.go) [repo].
- **Projection pin.** `Runtime.validateProjection` (runtime.go:290-312) rejects an account change ("changed
  leased account") and a canonical generation lower than `issued[0]` [repo].
- **Readiness loop.** It runs every 30 s (main.go:878-925). `FatalAuthError` (401, 404 after rechecks, or
  409 except `communicator_outcome_unknown`; nativeengine/runtime.go:78-85) ends the session. The auth watch
  `communicator.WatchAuth(…, account, session, rt.Socket …)` captures the account at start [repo].
- **Hooks.** `Runtime.Configure` renders the `[[hooks]]` table only when `portal` is true (runtime.go:528-547).
  The activity broker records `KimiActivity` but sets `rootTurnIdle` for Claude only
  (agentportal/activity.go:80-83) [repo].
- **Missing pieces.**
  - No `ckx accounts` subcommand (docs/interface-ckx.md:393-408).
  - The MCP `account_status`/`account_switch` tools are Claude-only (agentbus/mcp.go:962-965 and :577 "Claude
    sessions only").
  - The accounts handler is Claude-only (agentportal/accounts.go:52-54).
  - The communicator drops `account_switch` frames for any engine other than `claude`
    (communicator/connection.go:277-281), although the server pushes them for every engine
    (api/src/routes/communicator.ts:336-341) [repo].

### Missing compared with Claude (checklist)

| Item | Claude | Kimi |
|---|---|---|
| Provider identity, dedupe, refusal | Anthropic profile | none (opaque) |
| `accounts add/list/use` | `clx` | none |
| Policy directives and commit | yes | 409 |
| Turn-idle evidence | hooks plus transcripts | hooks recorded, not used for idle |
| Supervisor (directive, gate, write) | yes | none |
| Switch-safe credential serving | full canonical | must be the projection |
| MCP account tools | yes | Claude-only |
| Frontend policy UI | yes | hidden |
| Quota StopFailure classification | in flight (quota-continue) | none |

---

## 2. Credential consumption mid-session, refresher ownership, what a switch writes

### Per-request read chain [src]

The chain was verified at 2.8.1, and the storage and manager steps at 2.5.3 and 2.7.2:

1. `packages/core/src/llm/generate.ts:211` calls `resolveEndpoint(request.endpoint)` **for every request**.
2. That reaches `packages/core/src/llm/endpoint.ts:82`, `endpoint.credentials.resolve()`.
3. `packages/agent-core-v2/src/human/credentials/credentials.ts:20-28`: `resolve()` calls `getToken()`
   on every call, and `invalidate()` forces `getToken({force:true})` after a 401.
4. `packages/oauth/src/toolkit.ts:255-263`: `tokenProvider().getAccessToken` delegates to
   `managerFor(...).ensureFresh(options)`.
5. `packages/oauth/src/oauth-manager.ts:185-205`: `ensureFresh`, then `doEnsureFresh`, then `loadState()`
   (:119-120), then `storage.load()` **on every call**.
6. `packages/oauth/src/storage.ts:53`: `FileTokenStorage.load` calls `readFileSync`, with no cache.
7. `oauth-manager.ts:337-342`: `shouldRefreshToken` returns `false` when `token.expiresAt === 0`, so the
   projection is used as it is and nothing is written back.
8. On a 401 the forced path runs.
   - It first re-reads the file. If the token changed while it waited, it uses the new token
     (`changedWhileWaiting`, :243-248).
   - Otherwise it throws `OAuthUnauthorizedError` "has no refresh_token; re-login required" (:257-260)
     **before** any save, so nothing is tombstoned.

   This matches docs/interface-ckx.md:158-162.

**Consequence.** A rewritten `credentials/kimi-code.json` is used from the next request on. That holds even
in the middle of a turn, and even for a request that is retried after a 401 on the old token. [canary] The
existing loopback harness (`TestKimiNativeHooksCanary`, docs/interface-ckx.md:572-598) can prove this with
the real binary: rewrite the file between two provider requests and assert that the `Authorization` header
changes.

### Values frozen at bootstrap [src]

These do **not** follow a switch:

- **Inference headers.** `packages/node-sdk/src/sdk-rpc-client-v2.ts:527` sets
  `requestHeaders: createKimiDefaultHeaders({ homeDir, ...identity })` once, when the session is created.
  That includes `X-Msh-Device-Id` from `createKimiDeviceId(homeDir)` (`packages/oauth/src/identity.ts:36-46`,
  which reads `device_id` and mints `randomUUID()` when absent).
  - The kimi provider sends these host headers on inference: `hostHeaders: 'full'`
    (`agent-core-v2/src/llm-adapter/provider/provider-definition.ts:165-166`).
  - `toolkit.ts:371-377` also caches its own `identityHeaders` with `??=`.
- **Provider endpoint.** `base_url` and the `oauth` key come from `config.toml`, which is read at start.
- **Request metadata.** `X-Msh-Client-Metadata` (`agent-core-v2/src/agent/loop/requestMetadata.ts:101-113`)
  carries `agent_role`, `turn_trigger`, `user_input_id` and `parent_request_id`. None of it is
  account-specific. A `parent_request_id` chain continues across a switch; the provider's view of that is
  unknown and probably harmless.

### Refresher ownership [repo/doc]

The **server** is the only OAuth refresher (`api/src/services/kimi-auth-owner.ts`; AGENTS.md;
docs/interface-ckx.md:148-154, with `X-Msh-Device-Id` sent to the refresh endpoint).

- Hosts and the runner only ever receive projections:
  - `projectKimiAuth` (kimi-auth.ts:101-119) for hosts: access-only, `expires_at: 0`.
  - `projectKimiRunnerAuth` for the runner: keeps the real expiry.
- A host never uploads a refresh, so Claude's "flush the old account's rotation before the commit" step
  does not exist for Kimi.

### What a switch writes

| What | Where | How |
|---|---|---|
| B's projection: `access_token`, `refresh_token: ""`, `expires_at: 0`, `expires_in: 0`, `scope`, `token_type` | `<runtime>/home/credentials/kimi-code.json` (0600). For the `.ai` region also the scoped key file `runtimeAuth` names (runtime.go:249-254). | `AtomicWrite` (temp file plus rename). `Runtime.Apply` already does it (runtime.go:235-261). |
| B's `device_id` | `<runtime>/home/device_id` | Written for consistency only: any **new** reader (a `-S` restart, or a refresh path that never runs) sees B's id. The running process keeps A's frozen header. |
| CAS | before the write | The file digest must equal the digest of the last projection this runtime issued (`r.issued`). A mismatch means the user ran native `/login` or `/logout` inside the managed home. The wrapper then does not overwrite; it takes the repair path (§9.2). |

`r.issued` is reset on an account change, because generations are per account and B's can be lower
than A's. Otherwise `validateProjection` reports "generation regressed".

---

## 3. Turn boundaries and siblings

**Is a mid-turn switch safe?** Yes. Unlike Claude, no native state needs to settle:

- There is no rotation to flush and no native refresh.
- The file is read per request and written atomically.

A mid-turn switch therefore does not break correctness. Three costs remain:
- the provider-side prompt cache is rebuilt once;
- a `parent_request_id` chain spans two accounts;
- `ms://` media uploads made under A miss under B. Upstream keys its upload cache per account
  (`agent-core-v2/src/agent/media/mediaResolverService.ts:376,560,722-737`, a hash of the bearer's JWT
  subject) and recovers from "blob ID … does not exist" by re-uploading and retrying
  (`agent-core-v2/src/agent/loop/mediaPolicy.ts:84,142`) [src].

**Decision.**
- **Policy moves** (rebalance and dwell) wait for an idle turn boundary, the same rule as Claude.
- **Urgent moves** commit at once, even mid-turn. These are: bound account not usable, account at the hard
  ceiling, and an exhaustion marker set by quota-continue.

**Idle evidence (kimi-hooks-v1)** [src/doc].
- The events are listed in docs/interface-ckx.md:290-348 and
  `agent-core-v2/src/features/externalHooks/agent/agentExternalHooksService.ts`:
  - `TurnStarted` (fire-and-forget, :265-270)
  - `UserPromptSubmit` (awaited for user-origin prompts)
  - `PreToolUse`, `PostToolUse`, `PostToolUseFailure`
  - `PermissionRequest`, `PermissionResult`
  - `Stop` (blockable), which runs after `TurnEnded` through a queue (:419-440)
  - `StopFailure`, from `errorType`/`errorMessage` (:442-453)
  - `Interrupt`, on cancel (:426-428)
  - `SessionStart`, `SessionEnd`
- **Busy:** TurnStarted, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest,
  PermissionResult.
- **Idle:** Stop that does not block, StopFailure, Interrupt, SessionEnd, and SessionStart with no turn after it.
- **Continuation.** A Stop continuation starts a new turn with origin `system_trigger stop_hook`, so it
  reports busy again through TurnStarted.
- **Existing bug to fix.** `agentbus/kimi.go` `runKimiPoll` (:160-193) posts the "Stop" activity **before**
  it decides whether to block. A blocking Stop must report busy, or no activity at all.
- **Unreliable headless evidence.** In headless `-p` the process can exit before or after Stop
  (docs/interface-ckx.md:572-598), so idle evidence there is "unknown". Unknown evidence **fails open
  after a cap**. This is acceptable because a mid-turn commit is safe, and it avoids the 15-minute-busy
  lock that Claude's markers need.
- **Not needed.** Kimi has no transcript-quiet check like Claude's 20 s rule. The hooks plus the cap are enough.

**Siblings: change the scope to per launch.**
- Today the Kimi scope is the shared base home (main.go:720), but each launch has its **own** credentials
  file. The server moves a whole scope at once. A commit by launch 1 would rebind launch 2 on the server
  while launch 2 still holds A's file. Launch 2 then:
  - gets 400 from `enforceAccountSession`,
  - fails the `validateProjection` account pin,
  - dies when A's access token expires.
- Proposal: **one scope per launch.**
  - Load the pool with `accountpool.Load("kimi", <runtime>/home/auth.json, …)`. The scope is the sha256 of
    `<runtime>/home`, and the binding file `.cxx-account-<hash>.json`, the session markers and the repair
    flag sit in that directory.
  - **Why this seed.** In-session helpers (hooks, MCP children, `ckx` subcommands) inherit
    `KIMI_CODE_HOME=<runtime>/home` (runtime.go:595-600), and `native.Home()` honours it (kimi/native.go:40-43).
    So a helper that builds its client through `accountpool.Load(kimi, native.Home()+"/auth.json")`
    (app/kimi/main.go:428) computes **the same scope and binding file** as its launch.
  - **This also fixes a mismatch that exists today.** Today the launch's scope is the base home (main.go:720),
    while those helpers derive the runtime home and find no binding file.
  - Every launch is then the only member of its scope. `SiblingTurns` and `LiveSessions` see only itself.
    No sibling marker protocol is needed, and launches balance independently.
  - A commit by a new wrapper can never move an older wrapper's scope.
  - Old wrappers keep the base-home scope (§14).
- **Helpers without the pool.** Helpers that do not load the pool send the inherited
  `CXX_PROVIDER_ACCOUNT_ID`/`CXX_PROVIDER_SESSION_ID` (accountpool/context.go:445-452,
  agentportal/client.go:278-280).
  - The session id (lease id) is stable across a switch.
  - The account id is **stale** after a switch (Claude has the same problem; see the comment at
    claudequota/statusline.go:280-283).
  - Relaxing `enforceAccountSession` for live-switch engines (§9.1.3) makes the server adopt the lease
    instead of returning 400.
  - Helpers that display the account read the binding file, not the environment.
- **Agent-session attribution.** `moveAgentSessions` (account-switch.ts:648-689) moves agent sessions only
  when no other scope on the host still uses the old account. With per-launch scopes, two launches on A are
  common, so the switched launch's agent session would stay attributed to A "until its next registration".
  - The receiver already sends `provider_session_id` at registration (agentportal/client.go:278-280;
    verified at routes/agent-portal/admin-host.ts:106-129), but `agent_sessions` stores only
    `provider_account_id` (schema.ts:1520).
  - Proposal: store the lease id (`provider_session_id`, a nullable column added by an idempotent migration)
    and move exactly the agent sessions of the committed lease.
  - This is a shared improvement; Claude scopes with more than one launch benefit too.

---

## 4. Usage readings: freshness and attribution

**Attribution is exact by construction** [repo].
- The server polls each account's `/usages` with **that account's** canonical access token
  (kimi-usage.ts `refreshAccount`).
- Hosts report no Kimi usage: stream-json exposes none. The Stop hook input does carry the turn's token
  `usage` (agentExternalHooksService.ts:458-470), but token counts, not quota percentages.
- So Claude's misattribution hazards (`usageReportAccount`, `staleSwitchReading`, a statusline payload
  belonging to the previous account) **do not exist** for Kimi.
- The "usage attribution via the reporting host lease" guarantee holds trivially: no host-attributed reading
  exists. The "per-window merge" guarantee reduces to "a failed poll keeps the previous snapshot", which
  is today's behaviour.

**Gaps.**
1. **Freshness.** Readings refresh every 5 minutes and are stale after 10. An account can be exhausted
   between polls. Mitigation:
   - the quota StopFailure signal (§7) sets an exhaustion marker (the quota-continue design);
   - the server re-polls the account at once, rate-limited to the existing 5-minute floor per account;
   - a stale reading gets no switch credit (the same rule as Claude's `staleSwitchReading`: an unknown score
     never attracts a move).
2. **Windows.**
   - `readKimiUsage` scores `five_hour` and `limit_7d`.
   - Current (non-legacy) plans have **no 7-day window**, only monthly totals (`month_total`/`month_code`,
     docs/interface-ckx.md:209-216).
   - `poolPosition` (account-switch.ts:110-128, score = max(short, weekly)) is therefore blind to monthly
     exhaustion.
   - Proposal: score Kimi's long window as `limit_7d` when present, otherwise the worse of the monthly
     windows, and use that window's `resets_at` for `reset_aware`. This is an operator question (§15).
3. **Policy-worker triggers.** The worker's trigger tables (`account-policy-worker.ts`:
   `versions, providerAccounts, providerAccountSessions, claudeUsageSnapshots`) must gain
   `kimiUsageSnapshots`, or a new Kimi reading waits for an unrelated change.

---

## 5. Identity

**Today: opaque** [repo].
- The resolver (provider-accounts.ts:311-346) has three outcomes:
  - With one existing account, **any** login is filed under it (:328-332).
  - With more than one, the result is 409 `account_assignment_required`.
  - With `enroll` set, a new account is created.
- A second `ckx login` therefore **overwrites the sole account with another subscription**. `uploadLogin`
  even retries a `kimi_generation_conflict` with `account_id` and `base_canonical_generation`
  (app/kimi/login.go:70-91). This is a pre-existing bug (Appendix).

**Proposal: provider identity from `GET {base_url}/me`** [src: `packages/oauth/src/managed-userinfo.ts:8,57`].
- The response carries `user_id` (plus email). The call sends only an Authorization header, and the server
  already calls `/me` for the plan in kimi-usage.ts.
- Add `lookupKimiIdentity(access_token, oauth_host)` with the same tri-state as `lookupClaudeIdentity`:
  `resolved` / `unidentifiable` (4xx) / `unavailable` (network or 5xx).
- The identity key is `sha256("kimi:" + oauth_host + ":" + user_id)`, so the same user id in another
  region stays distinct.
- Pass it as `resolved` to `providerIdentity`.
- Generalise the Claude-only branches of `resolveCandidateDetailed`
  (`engine === 'claude' && identityKey` at :262-310, and the unproven-heads backfill at :199-214) to an
  `IDENTITY_LOOKUP_ENGINES = {claude, kimi}` set.
- Behaviour carried over:
  - an unresolvable login with a pool larger than one, or with `enroll`, gets 503 `account_identity_unavailable`;
  - a sole account keeps taking its logins (legacy rules, audited);
  - a retired identity gets 409 `account_removed` unless the login enrols;
  - an operator target that mismatches gets 409 `account_identity_mismatch`;
  - an insecure host with an unknown identity gets 403 `account_enroll_insecure_host`.
- The JWT subject is a possible fallback. Upstream's `stableJwtSubject` suggests the access token is a JWT
  carrying `sub`/`user_id` [src, inferred]. It is **not** proposed as the primary key, because it is
  unverified [live].
- **Backfill.** Existing accounts have `credential:` keys. On the next store, ask `/me` for each account's
  head, as `unprovenHeads` does for Claude. A failed lookup leaves the account unproven, and nothing is
  filed under it on the strength of a binding.

---

## 6. Enrolment UX

- **`ckx accounts list | add | use <id|auto>`.** New file `wrappers/cxx/internal/app/kimi/accounts.go`,
  mirroring `app/claude/accounts.go`.
  - `list`: `GET /auth/accounts?engine=kimi` (pool, bound account per live launch, scores).
  - `use`: `POST /auth/sessions/switch-request` for the caller's launch scope. Outside a managed session it
    lists the live launches, read from runtime markers, and asks which one, or takes `--all`.
  - `add`:
    - Runs the native device login (`kimi login`) with `KIMI_CODE_HOME` set to a private 0700 directory
      under `~/.cxx/`, **not** `/tmp` (tmpfs, shared).
    - Validates the file, uploads it with `enroll: true` (secure host only) and prints whether the account
      was created or refreshed.
    - Deletes the directory. The base home and running launches stay untouched.
    - Device id: by default the fresh login mints its own `device_id`. The alternative of pre-seeding one
      shared fleet device id is an operator question (§15).
- **MCP tools.** Enable `account_status`/`account_switch` for Kimi (agentbus/mcp.go:962-965 and the tool
  description at :577) and the accounts handler (agentportal/accounts.go:52-54). The fleet Skill
  `#account-switch` gains Kimi wording.
- **Seed command.** Already able to enrol (an untargeted seed token sets `enrollAccount`) [repo]. It gains
  identity-aware dedupe through §5.
- **Accounts page.** The policy UI is gated on `live_switch` from `GET /auth/accounts` and admin pool data
  instead of `engine === "claude"` (AccountPolicy.svelte:31, AccountGroupRow.svelte:46-47).

---

## 7. Quota-limit failure signal (for quota-continue)

[src] Upstream classifies the error in `packages/core/src/llm/builtin/provider/kimi/errors.ts:4,48,54`:

| Condition | Kind | Retryable | Serialized name |
|---|---|---|---|
| HTTP **429** with `code = exceeded_current_quota_error` | `quota_exhausted` | no; `retryAfterMs` taken from headers | `APIProviderQuotaExhaustedError` |
| Other 429s | rate limit | — | `APIProviderRateLimitError` |

The names come from `agent-core-v2/src/_base/errors/serialize.ts:201-202`.

The StopFailure hook input carries `errorType: payload.name` and `errorMessage` (agentExternalHooksService.ts:442-453).
The hook input keys are snake_case: the hook matcher converts camelCase to `error_type`/`error_message`
(`packages/agent-core-v2/src/features/externalHooks/internal/matchHooks.ts`) [src].

**Classifier** (Kimi dialect of `agentbus/watchdog_event.go` `watchdogHookFailure`, which reads Claude's
`error`/`error_details` today):

| `error_type` | Report |
|---|---|
| `APIProviderQuotaExhaustedError` | `failure=capacity`, `quota_limit: true`, `retry_not_before` from the message only if a reset time can be parsed (never guessed) |
| `APIProviderRateLimitError` | transient capacity, **not** `quota_limit` |
| anything else | unchanged |

[live] The exact message text and whether a reset is present need one live exhausted-account capture.
[canary] The loopback provider can return the 429 body to prove the hook path.

**Continuation for Kimi.** kimi-hooks-v1 has **no idle push**, and StopFailure replaces Stop, so nothing
can be injected after a failed turn.
- **Interactive.** The marker makes the server request an urgent move, which the supervisor commits at
  once. The user's next prompt runs on B. The `UserPromptSubmit` poll hook prints the auth notice
  ("previous turn failed on a quota limit; now on account B"; agentbus/poll.go `emitHook` already
  attaches authnotice context).
- **Headless or watchdog runs.** The quota watchdog or Wake relaunches with `-S session_<UUID>` on a fresh
  lease. Launch selection already avoids an account marked exhausted once quota-continue's marker raises
  its score.
- **Pre-empting the failure.** An urgent mid-turn switch at the hard ceiling can avoid the StopFailure
  entirely when the reading is fresh enough.

This is compatible with the quota-continue brief without depending on it. The marker and scoring are
server-side and engine-agnostic. The Claude auto-continue part stays Claude-only. Kimi only adds the
classifier and the notice.

---

## 8. Feasibility verdict

| Mode | Kimi | Condition |
|---|---|---|
| Full live switch (rewrite the projection mid-session) | **Yes** [src, canary] | Same `oauth_host`/`base_url`, and (same `device_id` **or** the [live] canary accepts a mismatched device header) |
| Switch at restart with auto-resume (`-S session_<UUID>` at an idle boundary) | Yes, as the fallback | Interactive TUI. The user sees a native restart. Needs SessionStart's native session id (already bound by `agent native-session`). |
| Launch-time only | today | Headless `-p` runs that cannot switch live; older wrappers |

Live switching is technically possible. The only real unknown is provider-side device binding.

---

## 9. Proposed design

### 9.1 Server

1. **`LIVE_SWITCH_ENGINES`** becomes `{claude, kimi}` (account-switch.ts:31), plus a **capability gate**
   for Kimi. The lease acquire payload advertises `switch_modes`:
   - `["live","restart"]` for an interactive launch;
   - `["live"]` for headless `-p` (it cannot restart);
   - nothing for an older wrapper.

   Storage and use:
   - A new nullable column `provider_account_sessions.switch_modes` (idempotent migration plus schema.ts)
     holds it. `NULL` means "live" for Claude, so Claude is unchanged, and "none" for Kimi.
   - `scopes()`, `evaluate` and `requestSwitch` skip or refuse Kimi scopes without a usable mode:
     409 `account_switch_unsupported_client`, with the minimum cxx version in the message.
   - A move that would need `apply: "restart"` is never issued to a scope without `restart`. A headless
     launch keeps its account, and the next launch or Wake selects anew.
   - Gate versus precedent is an operator question (§15); Claude's precedent is pending directives that
     never complete.
2. **`sessionExtras`** for Kimi on lease acquire (the :316-340 branch), on heartbeat (:388-399, merged with
   the freshness fields), and on Kimi `/auth` retrieve (:1046-1100). The 30 s readiness retrieve is then the
   directive transport even without a communicator.

   **Leaving an unusable account: the directive must survive A's failure.** Today both transports call
   `ensureFresh` for the bound account A first and throw:
   - `NotFoundError` "Kimi account was removed" (404, kimi-auth-owner.ts:99-100);
   - `kimi_login_required` (401, :512-514) for an unverified head;
   - 503 for a refresh that is pending, transient or uncertain.

   The wrapper treats 401 and a confirmed 404 as fatal (main.go:878-897, nativeengine/runtime.go:78-85), so
   it would end the session before it ever saw the move away from A. That is exactly the case the "removed
   accounts" guarantee exists for. Changes:
   - On the **heartbeat** of a scope with a switch mode, catch the `ensureFresh` failure and still answer
     `200` with the heartbeat fields, `sessionExtras` (including `bound_account_usable: false` and the
     pending directive) and `refresh_state: "failed"`, plus a `refresh_error` code. Do not throw. The
     evaluate-on-unusable call (routes/auth/index.ts:354) creates the urgent directive first.
   - The **retrieve** keeps its error status, so older wrappers behave as before. It adds the
     `sessionExtras` fields to the error body when the scope has a switch mode.
   - A lease that disappeared (404 on heartbeat) still goes through the existing re-reserve in
     `accountpool.Heartbeat`. For Kimi the re-reserve's acquire answer carries a projection of whichever
     account it chose, which the supervisor applies with `SwitchApply` like a commit.
   - Removing accounts: commit 90cf0c724 already lets a scope leave an account in `removing`. A Kimi lease
     on such an account must keep receiving A's projection until it commits, which it does today through the
     session-bound path (kimi-auth-owner.ts:118-119).
3. **`enforceAccountSession`**: change the exemption from `engine !== ENGINE_CLAUDE` to
   `!LIVE_SWITCH_ENGINES.has(engine)`. The lease is authoritative, so a wrapper whose commit response was
   lost gets the bound account's projection and not a 400.
4. **A Kimi branch in `POST /auth/sessions/switch`** (:516-580), and in the replay path.
   - **Readiness before the commit.** `credentialsReady` comes from
     `createKimiAuthOwner().ensureFresh({accountId: target, minValiditySeconds: 120})`, not session-bound,
     so the target must be enabled. An owner refresh failure means the commit is not made: 503
     `account_unavailable`.
   - **Live compatibility check before the commit.** The target's `oauth_host`/`base_url` must equal the
     bound account's.
     - If it does not, the result is 409 `account_switch_restart_required` and the directive is marked
       `apply: "restart"`.
     - The same applies when the device ids differ and the fleet flag `kimi_live_switch_device_mismatch`
       (default `false` until the canary passes; a `versions` K/V) is off.
   - **The response after the commit** is session-bound: `ensureFresh({accountId: committed.account_id,
     sourceHostId, sessionId})`. It returns `auth = projectKimiAuth(...)` plus `canonical_generation`,
     `access_token_digest`, `access_expires_at` and `verification_state`, the same fields the lease and
     retrieve answers carry. **The refresh token is never returned.**
   - **Replay.** `replayed: true` returns a fresh projection of the same account and generation contract.
   - Grok gets the same guard: a generic `servedSwitchCredentials(engine, …)` helper that refuses engines
     with an owner refresher unless they have a branch.
5. **Policy worker.** Add `kimiUsageSnapshots` to the trigger tables. The reaper already receives
   `LIVE_SWITCH_ENGINES`; Kimi heartbeat-renewed leases are marked through the generic
   `accounts.heartbeat` (`noteProviderRenewal`, provider-accounts.ts:758).
6. **Scoring.** In `poolPosition`, Kimi's long window is `limit_7d` or else the monthly windows (§4), and
   `reset_aware` uses that window's reset. When the wrapper reports quota StopFailure activity, the server
   re-polls the account immediately (with the floor).
7. **Identity**: `lookupKimiIdentity` plus the generalised resolver branches (§5).
8. **Agent sessions.** Add an `agent_sessions.provider_session_id` column (migration).
   `moveAgentSessions` moves by lease id when the commit's session is known, and falls back to today's rule.
9. **Frontend.** Gate the policy UI and switch buttons on `live_switch`. Show `restart` for a directive with
   `apply: "restart"`.
10. **Notices.** The `accountSwitchNoticeContent(engine, …)` path is already engine-parameterised, so check
    its Kimi wording.

### 9.2 Wrapper

1. **Per-launch scope** (app/kimi/main.go).
   - Create the runtime (`kimi.NewRuntime`) before `accountpool.Load`, and load the pool from
     `<runtime>/home/auth.json` (the seed in-session helpers derive; see §3).
   - The binding file, session markers and repair flag then live in `<runtime>/home`.
   - `ckx status` and `doctor` enumerate `~/.ckx/state/runtimes/session-*/home/` to show each live launch's
     account. The base-home binding is only read for older launches.
   - The acquire payload sends `switch_modes`.
2. **Switch supervisor.** New `wrappers/cxx/internal/app/kimi/account_switch.go`, with the
   `accountSwitchDeps` shape of `persona/claude/lifecycle/account_switch.go`. Extracting that shape into a
   shared `internal/accountswitch` package is optional; Claude stays untouched in the first pass.
   - **Directive source.** The heartbeat (communicator frame, or the 30 s readiness tick through
     `Pool.Observe` on `/auth` responses) gives the `account_switch` directive.
   - **Gate.**
     - `urgent` (bound account unusable, at the hard ceiling, or exhaustion marker) passes at once.
     - A `policy` move waits for `KimiTurnIdle`. Unknown evidence fails open after 10 minutes.
     - A directive with `apply: "restart"` waits for idle and restarts.
   - **Flush.** None (a no-op).
   - **Commit.**
     - Set the repair flag, then call `POST /auth/sessions/switch` with the generation fence. This reuses
       `accountpool.CommitSwitch`.
     - Hold `Runtime.mu` across the commit and the write. The readiness `Refresh` takes the same lock, so no
       A-pinned retrieve interleaves.
   - **Write.**
     - `rt.SwitchApply(projection, expectDigest)`: CAS the current file digest against the last issued
       digest, `AtomicWrite` `device_id` and the credentials, reset `issued`, and record B's generation.
     - `Pool.ApplySwitch` moves `Pool.AccountID`, so `validateProjection` pins B.
     - Restart `communicator.WatchAuth` with B (Claude's `restartableAuthWatch` pattern).
     - Clear the repair flag.
   - **Done.** Publish the auth notice through `authnotice.PublishDetail`. It is printed at the next
     `UserPromptSubmit`.
   - **Fatal auth errors go through the supervisor first.** Before the readiness loop or
     `WatchAuth status.Fatal` ends the session (main.go:878-912), the supervisor gets one bounded attempt,
     at most 30 s:
     1. `Pool.Heartbeat`, which re-reserves on 404.
     2. If a directive or re-reservation names a usable account, an urgent commit and `SwitchApply`.
     3. Only when neither exists, or the attempt fails, does `errKimiAuthEnded` stand.

     The token already in A's file normally remains valid at the provider for its remaining lifetime, so the
     native process keeps working during this window.
   - **Repair.**
     - Lost commit response: the directive is still pending, so repeat the commit and get `replayed`.
     - CAS miss (native `/login`): keep the binding, report `credential_write: "unfinished"` and let the
       readiness loop's existing digest check decide.
     - Process death: the launch is gone, and the connection-owned lease is released by the dropped
       connection.
   - **Fallback restart** (`apply: "restart"`, interactive only).
     - At idle, stop the native child cleanly, commit, `Initialize` with B's lease projection (including
       `device_id`, `base_url` and the `config.toml` provider), then relaunch with
       `-S <native session_UUID>` from the SessionStart binding.
     - If resume fails, the launch ends with a clear message. A fresh session is never started silently.
3. **Turn idle** (agentportal/activity.go).
   - Set `rootTurnIdle` for Kimi from the event classes in §3.
   - Publish the launch's own `turn` in its marker for status. Sibling logic is moot with per-launch scopes.
4. **Render activity hooks without the portal** (runtime.go:528-547). Activity hooks are rendered whenever
   pool switching is possible. Poll hooks stay portal-gated.
5. **Fix the Stop ordering** in `agentbus/kimi.go` (:160-193): report idle only when the hook does not block.
6. **StopFailure classifier**: the Kimi dialect from §7, and render the `StopFailure` hook to the
   watchdog-event path for Kimi.
7. **Communicator.** Accept `account_switch` frames for `kimi` (connection.go:279). The wrapper reacts with
   `Pool.Poke()`.
8. **MCP account tools and the accounts handler** for Kimi (§6), and `ckx accounts list|add|use` (§6).
9. **`validDeviceID`** (login.go:205-208) accepts a dashed UUID as well as 32 hex characters, to match the
   server regex and `runner/kimi.py:30-33`.
10. **Bump `VERSION`** in wrappers/Makefile.

### 9.3 Docs
- `docs/interface-ckx.md`: new section "Several Kimi subscriptions and live switching". Update the
  intentional deltas (:381-389) and the CLI surface (:393-408), and add an acceptance-canary record.
- `docs/interface-api.md`: change "Claude multiple accounts and live switching" to cover Kimi. Document
  `switch_modes`, `account_switch_unsupported_client`, `account_switch_restart_required`,
  `apply: "restart"`, the Kimi commit response shape and Kimi identity.
- `docs/interface-db.md`: the two new columns.
- `docs/interface-clx.md:2107-2109`: remove Kimi from "report `account_switch_unsupported_engine`".
- AGENTS.md engine-parity Kimi bullet, `scripts/engine-parity-exemptions.md`, CHANGELOG.md, the manual
  article on the Accounts page, and the `#account-switch` Skill wording.

### 9.4 Tests
- **API unit and integration** (`api/test/integration/provider-accounts/`, next to `claude-switch.test.ts`):
  - the Kimi commit returns the projection with no refresh token, also on replay;
  - commit refusals: target not ready, region mismatch, and device mismatch with the flag off;
  - the capability gate;
  - `sessionExtras` on the Kimi lease, heartbeat and retrieve;
  - `enforceAccountSession` adopts the lease;
  - Kimi identity: two different `/me` user ids make two accounts, and a second login no longer overwrites;
    `account_removed`, `account_identity_unavailable` and the backfill;
  - monthly-window scoring;
  - the worker reacts to a `kimiUsageSnapshots` change;
  - `moveAgentSessions` by lease id;
  - the engine-parity gate.
- **Go unit tests:**
  - `SwitchApply` CAS, atomicity and the `issued` reset;
  - `validateProjection` after a switch;
  - supervisor states: urgent mid-turn, policy waiting for idle, fail-open cap, lost response then replay,
    CAS miss;
  - Kimi turn-idle mapping;
  - the Stop ordering fix;
  - the StopFailure classifier with real-looking 429 bodies;
  - the per-launch scope id;
  - `validDeviceID` with a dashed UUID;
  - `ckx accounts` argument handling.
- **Canaries (opt-in):**
  1. Loopback switch canary: the real binary with two synthetic tokens. Rewrite the credentials mid-turn and
     assert that the next request's `Authorization` header is B's and `X-Msh-Device-Id` is still A's. This
     pins the frozen-header finding per upstream version.
  2. **Live** two-subscription acceptance: B's token with A's device id on a real inference call, and also
     `/me` and `/usages`.
  3. A live exhausted-account StopFailure capture.

---

## 10. Hardening guarantees carried over

| Guarantee (Claude) | Kimi equivalent |
|---|---|
| Identity refusal | `/me` lookup with the same 503/409/403 semantics (§5). |
| Removed accounts | Tombstone: the tombstone applies to Kimi identities. A login upload for a removed identity gets 409 `account_removed` unless it enrols. A host never uploads refreshes, so the only source is `ckx login`/seed. Leaving: the heartbeat delivers the directive even when A's `ensureFresh` fails. The wrapper asks the supervisor (heartbeat, re-reserve, urgent commit) before it honours a fatal 401/404 (§9.1.2, §9.2.2). |
| Usage attribution through the reporting host lease | Trivially met: only server-side polls with each account's own token (§4). |
| Per-window usage merge | The single source per account keeps the previous snapshot on a failed poll. Monthly windows are added. |
| Repeatable commit | The Kimi commit branch is idempotent for the same generation (`replayed`) and serves a fresh projection. |
| Repair flag | Lives in the runtime and is set before the commit and cleared by the write. Retries run under the runtime lock. The `unfinished` report is reused. |
| Sibling turn markers | Moot with per-launch scopes. The marker still publishes `turn` for status. |
| Lease reaping | Kimi joins the reaper set through `LIVE_SWITCH_ENGINES`. Connection leases are released on disconnect. A reaped lease answers a readiness 404, which the supervisor first tries to heal with the heartbeat re-reserve before the 404 counts as fatal. |

---

## 11. Ordered implementation plan

1. **Fix pre-existing bugs (independent, can ship first).**
   - `wrappers/cxx/internal/app/kimi/login.go`: `validDeviceID`, plus a test.
   - `api/src/routes/auth/index.ts`: guard so the commit route can never return a full Kimi or Grok canonical.
2. **Canaries.**
   - New `wrappers/cxx/internal/kimi/switch_canary_test.go` (opt-in), next to `TestKimiNativeHooksCanary`.
   - Operator-run live check (§15), recorded in `docs/interface-ckx.md`.
3. **Identity.**
   - `api/src/services/kimi-identity.ts` (new: `/me` lookup).
   - `api/src/services/provider-accounts.ts` (resolver generalisation and backfill).
   - `api/src/services/canonical-auth-store.ts` (pass-through).
   - Tests.
4. **Schema.** `api/src/db/migrations/NNNN_kimi_live_switch.sql`, adding
   `provider_account_sessions.switch_modes` and `agent_sessions.provider_session_id`. Also
   `api/src/db/schema.ts`, the baseline regeneration per `api/src/db/README.md`, and `docs/interface-db.md`.
5. **Server switch.**
   - `api/src/services/account-switch.ts`: set, capability, compatibility check, Kimi scoring.
   - `api/src/routes/auth/index.ts`: sessionExtras on the Kimi lease, heartbeat and retrieve;
     `enforceAccountSession`; the Kimi commit branch.
   - `api/src/services/kimi-auth-owner.ts`: a target-readiness helper if needed.
   - `api/src/services/kimi-usage.ts`: monthly windows and on-demand re-poll.
   - `api/src/ops/account-policy-worker.ts`: triggers.
   - Agent-session linkage in `api/src/routes/agent-portal/admin-host.ts`.
   - Tests in `api/test/integration/provider-accounts/kimi-switch.test.ts` (new).
6. **Frontend.**
   - `frontend/src/lib/components/accounts/AccountPolicy.svelte`, `AccountGroupRow.svelte` and the restart
     label. Read DESIGN.md first.
   - `npm run build` into `public/admin/`.
7. **Wrapper scope and runtime.**
   - `wrappers/cxx/internal/app/kimi/main.go`: reorder, per-launch Load, `switch_modes`.
   - `wrappers/cxx/internal/kimi/runtime.go`: `SwitchApply`, `issued` reset, hooks without the portal.
   - `wrappers/cxx/internal/accountpool/context.go`: Load variant or acquire capability field, if needed.
   - The status and doctor files in `wrappers/cxx/internal/app/kimi/` that read the binding.
8. **Wrapper supervisor.**
   - `wrappers/cxx/internal/app/kimi/account_switch.go` (new; optionally a shared `internal/accountswitch/`).
   - `wrappers/cxx/internal/agentportal/activity.go` and `accounts.go`: Kimi turn idle, accounts handler.
   - `wrappers/cxx/internal/agentbus/kimi.go`: Stop ordering.
   - `wrappers/cxx/internal/agentbus/watchdog_event.go`: Kimi StopFailure classifier.
   - `wrappers/cxx/internal/agentbus/mcp.go`: Kimi account tools.
   - `wrappers/cxx/internal/communicator/connection.go`: kimi frames.
8b. **Restart fallback.** The supervisor restart path in `app/kimi/account_switch.go` and the `main.go`
    relaunch with `-S <session_UUID>`, interactive only.
    - **Required for first ship unless the live canary has passed**: without it every Kimi switch is
      refused (§0).
    - After a passed canary it covers only region mismatches.
9. **CLI.** `wrappers/cxx/internal/app/kimi/accounts.go` (new; `list|add|use`), and command registration in
   the Kimi app dispatcher.
10. **Leaving unusable accounts end to end.** Integration test: remove, pause and unverify A while a launch
    holds it. The heartbeat delivers the urgent directive, the wrapper commits and applies B, and the
    session survives.
11. **Docs, changelog and version.**
    - `docs/interface-ckx.md`, `docs/interface-api.md`, `docs/interface-clx.md`, `docs/interface-db.md`
    - `docs/OVERVIEW.md`, `AGENTS.md`, `scripts/engine-parity-exemptions.md`
    - `CHANGELOG.md`, the manual article
    - `wrappers/Makefile` VERSION
12. **Checks** (run them all before reporting).
    - `cd api && npx tsc --noEmit -p . && npx vitest run`, plus the DB-gated suites for the migration.
    - `cd wrappers/cxx && go build ./... && go vet ./... && go test ./...` and `GOOS=freebsd go build ./...`.
    - `cd frontend && npm run check`.

---

## 12. Shared (engine-agnostic) versus Kimi-specific

**Shared** (already generic or made generic here):
- the scope, binding, generation CAS, directive, commit and replay state machine (account-switch.ts,
  accountpool/switch.go);
- policy strategies and the worker;
- the reaper;
- `/auth/accounts`;
- the `enroll` store;
- the identity resolver skeleton (now driven by `IDENTITY_LOOKUP_ENGINES`);
- the capability gate;
- `enforceAccountSession` keyed by the set;
- the agent-session move by lease id (also improves Claude);
- MCP account tools and the communicator frame handling;
- the frontend `live_switch` gating;
- the exhaustion marker from quota-continue.

**Kimi-specific:**
- the commit response is the **access-only projection** (owner refresher);
- no flush;
- per-launch scope;
- `SwitchApply` with digest CAS and the `issued` reset;
- the device-id and region compatibility check and the restart fallback;
- turn idle from kimi-hooks-v1 with a fail-open cap;
- the StopFailure error-name classifier;
- monthly-window scoring;
- `/me` identity;
- `ckx accounts add` through an isolated `KIMI_CODE_HOME` device login.

---

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The provider binds a token to the device id (B's token sent with A's `X-Msh-Device-Id`) and refuses it or flags the account | Live canary before enabling; flag off by default; compatibility check; restart fallback; option of one device id per fleet (operator) |
| Accounts in different regions (`.cn` and `.ai`): `base_url`/OAuth key are frozen | The commit refuses a live switch, and the switch goes through `apply: "restart"` |
| A future kimi-code caches tokens in memory | The loopback switch canary runs on every pinned kimi-code version bump (engine-maintenance prompt); a kimi-code version floor below which the wrapper advertises only `restart` |
| Native `/login` or `/logout` inside the managed home | Digest CAS refuses the overwrite; `unfinished` report; the existing readiness digest check |
| A switch races the 30 s readiness `Refresh` | `Runtime.mu` held across commit and write; the server adopts the lease instead of returning 400 |
| A wrapper crash between commit and write | Per-launch scope: the launch dies with it. The orphaned native process uses A's token until it expires (pre-existing behaviour) |
| Headless hooks are unreliable (Stop not seen) | Fail open after the cap; correctness does not depend on idle |
| Usage lags by 5 minutes, so an account is exhausted between polls | StopFailure marker and immediate re-poll; stale readings never attract a move |
| A shared device id across accounts looks like abuse (if chosen) | Operator decision; default is per-account ids |
| Prompt-cache rebuild and media re-upload cost after a switch | Policy dwell plus idle gating for non-urgent moves; upstream re-uploads automatically |
| Status shows a stale account from the base-home binding | Status reads runtime markers |
| The commit route leaks the refresh token | A per-engine credential guard lands first (step 1) |

---

## 14. Older-wrapper compatibility

- **Old `ckx` (0.9.211 or earlier)** keeps the base-home scope and sends no `switch_modes`.
  - The server marks the scope not switch-capable. It never creates directives for it, and admin or agent
    requests get 409 `account_switch_unsupported_client`.
  - Launch-time selection is unchanged.
- **Extra fields reach old wrappers.** These are `binding_generation` and `account_switch` on the Kimi
  heartbeat and retrieve. Old wrappers already parse them generically (`Pool.Observe`,
  accountpool/context.go:135), and nothing commits for their scope, so their binding never moves.
- **Mixed hosts.** Old and new launches have disjoint scopes (base-home hash versus runtime hash).
  `acquireOwnedProvider` pins a new old-wrapper launch to the base-home scope's account as before.
- **Relaxed `enforceAccountSession`.** No mismatch can arise for old Kimi wrappers, because nothing
  commits for them.
- **An older communicator** drops `kimi` frames. The 30 s readiness retrieve still delivers the directive.
- **An older server** (wrapper ahead) returns no `live_switch` in `/auth/accounts` or answers 409
  `account_switch_unsupported_engine`. The supervisor turns itself off, and the launch behaves as today.
- **Identity backfill.** Existing `credential:` accounts keep working. A sole account keeps taking logins
  while `/me` is unavailable (the legacy rule, audited).

---

## 15. Open questions for the operator

1. **Device id strategy and the live canary.** The canary needs two Kimi subscriptions. As of 2026-11-12
   no live Kimi credential is in the secret store (docs/interface-ckx.md:381-389). Who provides them? If
   the canary shows that the device id is bound, choose one:
   - (a) live only between accounts that share a device id, otherwise restart; or
   - (b) `ckx accounts add` pre-seeds one fleet or host device id into the throwaway login home, so every
     enrolled account shares it. This risks provider-side account linking.
2. **Monthly windows.** Should Kimi's monthly windows (`month_total`/`month_code`) count as the long window
   in scoring and `reset_aware`, when a plan has no `limit_7d`?
3. **Capability gate.** Gate with a migration column (clean 409 for old wrappers), or accept Claude's
   precedent of directives that stay pending for old clients?
4. **Restart fallback.** Is a visible native restart of an interactive TUI (resumed with `-S`) acceptable
   for an automatic policy move? Or should restart-mode moves be limited to urgent cases (account unusable
   or exhausted)?

---

## Appendix: pre-existing bugs found (independent of this feature)

1. **`ckx login` rejects real Kimi device ids.** `validDeviceID` requires exactly 16 bytes of hex
   (wrappers/cxx/internal/app/kimi/login.go:205-208, checked at :99).
   - `ckx login` runs the native `kimi login` in a fresh directory, **without pre-seeding a `device_id`**
     (login.go:128-174). kimi-code then mints `randomUUID()`, which is dashed and 36 characters long, because
     no file exists (`packages/oauth/src/identity.ts:36-46`; same at 2.5.3).
   - The server regex (kimi-auth.ts:34-35), the runtime regex (kimi/runtime.go:88) and `runner/kimi.py:30-33`
     accept both forms.
   - The unit test uses a 32-character `a` string, so it does not catch this.
   - The seed script (install-token.ts:462-481) is not affected: it does not validate the form.
   - Confirmed by code. No live `ckx login` record exists.
2. **A second subscription overwrites the sole Kimi account.**
   - Opaque identity means one existing account takes every login (provider-accounts.ts:328-332).
   - `uploadLogin` then retries the generation conflict against that account (login.go:70-91).
   - `ckx login` on a second subscription silently replaces account 1's credentials.
3. **The commit route would leak a refresh token.** `POST /auth/sessions/switch` returns the full canonical
   (routes/auth/index.ts:563-574). That is harmless today only because the route is gated to Claude.
   Adding Kimi (or Grok) to `LIVE_SWITCH_ENGINES` without a branch breaks the single-refresher contract.
4. **Minor:** the Kimi poll hook reports `Stop` activity before deciding to block (agentbus/kimi.go:160-193),
   so a blocking Stop shows idle briefly.
