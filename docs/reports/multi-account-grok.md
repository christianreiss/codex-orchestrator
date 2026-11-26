# Multi-account live switching for Grok Build (`cgx`): design

Status: research and design only. The repo was read, not changed. Repo `main` @ 742d209ba (cxx 0.9.211), date 2026-11-26.
Companion reports: [Codex](multi-account-codex.md) and [Kimi](multi-account-kimi.md); the shared design
across engines is in [multi-account-engines.md](multi-account-engines.md).

**Sources and their limits**
- Upstream source is the public `xai-org/grok-build` HEAD `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`. It was synced 2026-09-29, it is the newest public commit, and there are no tags or releases.
  - The workspace crate says `1.0.45`, but release builds inject `GROK_VERSION`, so that number is not the release.
  - The fleet recorded on 2026-10-01 that the inspected public revision was **newer than installed 1.0.46** (docs/interface-cgx.md:1184-1187).
  - So the source dates from a post-1.0.46 sync on 2026-09-29.
- The fleet runs Grok Build **1.0.92** (docs/interface-cgx.md:508-511). So every native claim below is **source-verified at that SHA, not live-verified on 1.0.92**.
- This host has no Grok binary (`~/.cxx/engines` holds only claude and codex), so no `strings` check was possible.
- Upstream links use the base
  `GB = https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/`.

---

## 0. Verdict

**Live switching of a running interactive `cgx` session is feasible.** The supported shape is narrow: an **interactive launch with the wrapper's private leader**, switched at an all-idle turn boundary. Headless and no-leader runs keep next-launch semantics.

The switch is **not "just change what the broker serves"**. It is "write the target account's complete access-only projection into the launch's private `$GROK_HOME/auth.json`":
- The native leader watches that file. It debounces 1 s, re-reads it, and hot-swaps the in-memory credential **unconditionally**.
- Every request reads the bearer per call, and requests are stateless. The next turn therefore runs on account B in the same native session.

Serving B only through `cxx grok-auth` would be wrong, for two reasons:
- Native calls the provider only near expiry (300 s buffer) or after a 401.
- `carry_user_profile_from` would copy **A's** user id, team, org and ZDR flags onto B's token.

The disk write must be made consistent with the broker: native flock first, then `r.mu`, with an issued-digest CAS and a reset issuance list. Native adoption must then be confirmed over the leader ACP socket.

Two unverified risks gate rollout, and both are covered by a live step 0:
- **Native release drift** (post-1.0.46 source synced 2026-09-29 vs 1.0.92).
- **Account-bound history**: replayed reasoning `encrypted_content` may not decrypt under another account, which upstream treats as a terminal "start a new session" error.

---

## 1. Current state

### Server
- Pool leases work for Grok today, but launch-time only.
  - `POST /auth/sessions` has a Grok branch that returns `createGrokAuthOwner.ensureFresh` output: the access-only projection, `canonical_generation`, `access_token_digest` and `access_expires_at` (api/src/routes/auth/index.ts:286-315).
  - The branch returns early, **without `sessionExtras`**. `sessionExtras` is only produced for `LIVE_SWITCH_ENGINES` (:185-188).
  - The Grok heartbeat likewise returns only ensureFresh metadata (:371-399; Claude extras at :385, Grok at :387).
- Launch selection: `acquire` pins to any live lease of the same host, engine and scope, otherwise it uses `selectForLaunch` (api/src/services/provider-accounts.ts:632-724, pin at :666-668). The owner path does the same (api/src/control-plane/streams/provider-leases.ts).
- The live-switch machinery is gated by `LIVE_SWITCH_ENGINES = new Set(['claude'])` (api/src/services/account-switch.ts:31):
  - `requestSwitch` :450/461, `commitSwitch` :551/561, `poolView` live flag :742/768, `evaluate` :822;
  - the policy worker and lease reaper (api/src/ops/account-policy-worker.ts:28,35,40).
  - Grok gets `account_switch_unsupported_engine`.
- `GET /auth/accounts` (:471-498) and `quota_pool` on `/auth` and `/sync/bootstrap` (`withPoolExtras` :428-468) are engine-agnostic. They report `live_switch: false` for Grok.
- The switch commit route returns `runnerValidation.canonicalAuthFromPayload(row)` (:563-579). For Grok that is the **full canonical credential including refresh tokens**. It must never be served to a Grok host, because the fleet has exactly one refresher.
- `enforceAccountSession` rejects an `account_id` that differs from the lease for every engine except Claude: `400 Account does not match session` (:2027-2043). It runs on `/auth` (:416) and `/sync/bootstrap` (:791).
- Usage: `grok-usage.ts` polls billing and settings server-side every 300 s and marks a reading stale after 600 s (api/src/services/grok-usage.ts:14-17). `short_*`/`weekly_*` stay null: "Dashboard observation only" (:145-153; docs/interface-api.md:2739).

### Wrapper (`cgx`)
- The pool scope is the original home: `accountpool.Load("grok", <baseHome>/auth.json)` (wrappers/cxx/internal/app/grok/main.go:724). Pool capability is required (:761).
- The launch sequence is lease (`pool.Start`, :795), then `rt.Initialize(ctx, lease)` (:806), then the auth broker (:810).
  - `Initialize` is "the sole wrapper-side native write after lease assignment" (wrappers/cxx/internal/grok/runtime.go:366-391).
  - The readiness loop runs every 30 s through `RefreshConfirmed` (main.go:899-920). `communicator.WatchAuth` is called with the account and session **captured at start** (:921-946).
- Interactive runs start a private leader: `agent leader --leader-socket <rt.Dir>/… --relay-on-demand --no-auto-update`. Headless runs get `--no-leader` (main.go:947-1014). An explicit `--no-leader`/`--leader-socket` from the user also skips the private leader (:947).
- The card shows the leased label (main.go:1032). When there is more than one account, `quota_pool` rows are listed (wrappers/cxx/internal/app/grok/startup.go:38-39,174-181; docs/interface-cgx.md:777-782). Grok keeps the emulated "pause" advice "because their run stays on its account".
- Enrolment is implicit.
  - `cgx login` runs `grok login --device-auth` in a throwaway `GROK_HOME` (`os.MkdirTemp("", "cgx-login-")`, login.go:133,167) and uploads `command=store` without `account_id` (login.go:69-91).
  - The server then creates a new account for any new identity (§5).
- **Missing compared with Claude:**
  - no `cgx accounts` subcommand;
  - no supervisor, directive handling, repair flag or turn markers for Grok;
  - the MCP `account_status`/`account_switch` tools are Claude-only (agentbus/mcp.go:576-577, `accountToolsSupported` :962, refusal :1099; agentportal/accounts.go:52-53 refuses non-Claude engines with 409);
  - the fleet Skill text is Claude-only (api/src/services/managed-account-switch-skill.ts:5,13,37).

---

## 2. How native consumes credentials mid-session, and what a switch must write

### Who refreshes
The **server** owns refresh.
- `createGrokAuthOwner.ensureFresh` (minValidity 600 s) refreshes centrally. A refreshed credential keeps all profile fields and gets `create_time = receivedAt` (api/src/services/grok-auth-owner.ts:232-234).
- `projectGrokAuth` deletes every `refresh_token` and sets `auth_mode: external` (api/src/services/grok-auth.ts:65-87).
- The wrapper validates that the projection is access-only, external, from the official issuer and client, and tied to the leased account (`validateProjection`, runtime.go:339-364).
- Native refreshes through `grok_com_config.auth_provider_command = '<cxx>' grok-auth` (`Configure`, runtime.go:568ff). `cxx grok-auth` talks to the per-launch broker socket (`/token`, runtime.go:476-508).

### Where native reads credentials
- **Per request, from memory.** `WireValidBearerResolver.current_bearer()` reads the AuthManager's in-memory credential on every send. "The same resolver serves all three states without a client rebuild" (GB/xai-grok-login/src/credential_provider.rs#L20, #L50, #L575, #L604).
- **On file change, leader only.** `run_leader` (GB/xai-grok-shell/src/agent/app.rs#L698):
  - starts `ConfigFileWatcher` on `grok_home()` (#L1145-L1184). It warns "hot-reload disabled" if the watcher fails (#L1182).
  - The watcher maps `auth.json` in GROK_HOME to `AuthChanged` (GB/xai-grok-shell/src/config/watcher.rs#L319). It debounces 1000 ms (#L9), handles write-then-rename, and deliberately has no self-write suppression (#L83-L85).
  - `reload_auth` re-reads `grok_home/auth.json`, skips only when the key hash is identical, and otherwise sends `ConfigUpdate::Auth` (GB/xai-grok-shell/src/config/reloader.rs#L227-L262).
  - The leader then calls `auth_manager.hot_swap(auth)`, `models_manager.on_auth_changed()`, and `InternalMethod::ReloadAllMcpServers` (app.rs#L1195-L1230).
  - `hot_swap` is unconditional ("called by config watcher. Does NOT write to disk"; GB/xai-grok-login/src/manager.rs#L1034-L1042).
  - The fleet already relies on this: a private home is required "because the native auth reloader reads `GROK_HOME/auth.json` directly … Sharing the operator's original home could silently switch managed accounts" (docs/interface-cgx.md:946-951, written with 1.0.46).
- **Near expiry and on 401 (all modes).**
  - `refresh_chain` first tries to adopt the disk token (GB/xai-grok-login/src/manager/refresh_chain.rs#L59-L162).
  - The proactive loop also picks up a sibling token before refreshing (manager.rs#L1554-L1583, #L1763-L1820).
  - Adoption goes through `try_use_disk_token`, which hot-swaps the **whole disk credential**, profile included. It declines `Missing`, `Expired`, `LaggingMemoryMint` (disk `create_time + 60 s < memory create_time`), and `SameKeyAsRejected` on a 401 (manager.rs#L1050-L1076).
  - Only when adoption declines does native run the external command: `run_external_refresh` with a 7 s timeout and `GROK_AUTH_EXPIRED=1` (GB/xai-grok-login/src/external_auth.rs#L45, #L62-L109). It then calls `carry_user_profile_from(prev)`, which copies the **previous** credential's user id, email, team, org and ZDR flags (external_auth.rs#L112-L119; GB/xai-grok-login/src/model.rs#L199). The early-invalidation buffer is 300 s (model.rs#L9, #L334-L340).
- **Native lock.** `auth.json.lock` sits next to the auth path. It uses `fs2` (flock(2)), is never deleted, and is held across the IdP or external call (GB/xai-grok-login/src/manager/lock.rs#L2-L3, #L17, #L25, #L238, #L302). The broker never takes it (docs/interface-cgx.md, managed lifecycle).
- **Requests are stateless.** `previous_response_id: None`, `store: None`, `include: None`, `conversation: None`; `prompt_cache_key` is the conversation id (GB/xai-grok-sampling-types/src/conversation/responses.rs#L123-L157).
  - Function-call and output ids are stripped (#L228-L269), and images are replayed by URL with `file_id: None` (#L251-L258, #L298-L301).
  - **But** reasoning items are replayed as stored (#L211-L216), and history can carry `encrypted_content`. A 400 mentioning it is terminal: "This session's conversation history is incompatible with the current model. Please start a new session." (GB/xai-grok-sampling-types/src/error.rs#L366-L376; GB/xai-grok-shell/src/session/acp_session_impl/sampler_turn.rs#L1202-L1204, #L1307-L1324).
  - Upstream frames the decryption error as a *model-family* mismatch. Whether it is also account-bound is **unknown**; see step 0 P3.

### What a switch must write
- The **target's complete access-only projection** (with B's own profile fields) goes into `r.AuthPath = <rt.Home>/auth.json` (runtime.go:192, which is also `GROK_AUTH_PATH`, runtime.go:851-868).
  - Write it atomically with mode 0600.
  - Set the selected credential's `create_time` to the local write time. This makes the `LaggingMemoryMint` decline impossible, so the near-expiry adoption fallback always takes B.
- **CAS:** under native flock, then `r.mu`, the current disk key digest must be one the broker issued (`r.issued`, runtime.go:287-298). If it is not, a native rotation is mid-flight: abort and retry at the next gate.
- **Broker consistency:**
  - `r.issued` must be reset to `[B]`, because B's generation lineage is independent. Otherwise `validateProjection` fails with "canonical generation regressed" (runtime.go:357-358).
  - `r.Pool.AccountID` must become B under the same `r.mu`, because `Inject` stamps `account_id` on every `/auth` call (accountpool/context.go:85-106).
- **Fail closed:** add `r.nativeAccountID` (the account whose projection is on disk). `/token` must answer 503 ("authentication pending") while `r.Pool.AccountID != r.nativeAccountID`. Native then classifies it as a retryable `Failed`, and B's token is **never** served through the external path while A's profile is in memory.

---

## 3. Turn boundaries and siblings

- **Idle evidence (per launch).** The wrapper owns the private leader and its ACP socket (`CXX_GROK_SOCKET`).
  - `_x.ai/sessions/list` gives every session's `sessionKind` (non-empty means a child or subagent), `resident`, and `activity` ∈ idle / working / needs_input / dead / completed (agentbus/grok_queue.go:175-218).
  - `status()` gives the bound session (:220), and `grokActivity` maps the states (agentbus/activity.go:52).
  - The receiver already submits only while idle (docs/interface-cgx.md receiver section).
  - Hooks add StopFailure, StopCancelled and SessionEnd (runtime.go hooks; docs/interface-cgx.md:977-979). Stop has `reason: end_turn` (GB/xai-grok-pager/docs/user-guide/10-hooks.md#L373). The roster alone suffices for the gate.
- **Gate.** Every resident root and child in the roster is `idle` (none `working` or `needs_input`), stable for the existing 5 s gate. No receiver delivery may be in flight. The native flock must be obtainable (no native refresh running). Idle is re-checked **after** taking flock and `r.mu`, right before commit.
- **Siblings.** All sessions and subagents of one launch share one leader and one AuthManager, so they switch together, and the roster covers all of them. A sibling `cgx` launch has its own private home, broker and leader. With the per-launch scope recommended in §9.1, it is not part of the switch. If the operator keeps the home-wide scope, the Claude sibling-turn markers (accountpool/markers.go `SetSessionTurn`/`SiblingTurns`) apply, and **every** runtime must adopt by writing its own file (§9.1 alternative).
- **Residual window.** A turn that starts during the ≤1-2 s between the final idle check and the watcher's hot-swap sends its first request on A and the rest on B. Requests are stateless and usage is server-side per account, so this is benign. It is documented, not prevented.

---

## 4. Usage readings, freshness and attribution

- Readings are **server-pulled per account** with that account's own token: billing `/v1/billing?format=credits` and `/v1/settings` every 300 s, stale after 600 s (grok-usage.ts:14-17,208). Paused, removed, merged and disabled accounts are not polled (docs/interface-cgx.md:762-763).
- There is no host report, so the Claude stale-reading problem (statusline shows the previous account's windows; `staleSwitchReading`, account-switch.ts:149) **does not exist** for Grok. A switch needs no `usageReportAccount` handling.
- **Scoring is empty today.**
  - `poolPosition` scores `short_*`/`weekly_*` only, which are null for Grok, so `score = null` unless an emulated budget blocks (score 100) or the account is unusable (account-switch.ts:110-128).
  - In phase 1 the policy therefore moves Grok scopes on emulation blocks, unusable or paused or removed accounts, manual or agent requests, and the quota-continue exhaustion marker. It does **not** move them by billing percentage.
- **Phase 2 (opt-in, operator decision):** map `current_window.used_percent`/`resets_at` (weekly or monthly; grok-usage.ts:97) into a pool slot.
  - Readings whose `shared` (`isUnifiedBillingUser`, :88) budget is the same across accounts must count as one budget.
  - Monthly periods must not be labelled weekly (docs/interface-cgx.md:766).

---

## 5. Identity

- **Today:** `providerIdentity(grok) = sha256("grok:" + native.user_id)` from the selected canonical credential (provider-accounts.ts:48-55). Native writes `user_id` from `/user` enrichment at login (GB/xai-grok-login/src/manager/enrichment.rs#L141-L142). An external-refresh token starts with an empty `user_id` (external_auth.rs#L11-L41), but canonical logins come from the device login, never from external refresh.
- **Generic (non-Claude) resolution** (provider-accounts.ts:311-346):
  - It matches by credential lineage, then identity key.
  - A new identity creates a new account (:345-346), **from any host**.
  - With no identity and a single account, it silently assigns that account (:328-332). With no identity and more than one account, it returns `account_assignment_required` (:333-337).
- **Gaps compared with Claude's hardened path** (:262-310, Claude-only):
  1. An unattributable login on a one-account pool is attached to that account. Claude refuses this with `account_identity_unavailable` (:387-397).
  2. There is no `account_enroll_insecure_host` refusal for implicit new-identity enrolment (:292-298 is Claude-only).
  3. A removed account's identity is matched via `identityKey === key` (:312) and refused in `claimIdentity` (:402). That is correct, but explicit `enroll: true` cannot revive it, because the `releaseRetiredIdentity` tombstone release is Claude-only (:279,307).
- **Design:**
  - Keep `user_id` as the key, so existing keys stay stable.
  - For Grok, require an identity whenever the pool has any attributed account; otherwise refuse with `account_identity_unavailable`, and never attach to the sole account.
  - Port the insecure-host refusal and the tombstone rules to Grok.
  - Optionally cross-check JWT `sub` ("the account id the issuer knows the user by", GB/xai-grok-login/src/jwt.rs#L19-L20) against `user_id`, but only after step 0 proves they match. Do not change the key basis.
- **"Exactly one refresher" is preserved.** Enrolment stays a dedicated throwaway device login whose refresh token goes only to the server. A switch never moves refresh material to a host.

---

## 6. Enrolment UX

- `cgx accounts list [--json]`: `GET /auth/accounts?engine=grok`, already engine-agnostic. It shows label, state, verification, billing window and plan, marks this launch's binding, and lists running launch scopes.
- `cgx accounts add`: refused on insecure hosts. It runs the existing isolated device login (login.go) in a private enrol root (`~/.cxx/grok-enroll/`, swept after 1 h like clx's `enrollRoot`, app/claude/accounts.go:246-254). It uploads `command=store, enroll: true`. If the identity is already enrolled, the server answers with the existing account ("already enrolled #n"). It never touches a running launch's private home.
- `cgx accounts use <id|auto> [--launch <name>]`: `POST /auth/sessions/switch-request` for one running launch scope. When several are running, it requires `--launch`. With none running: "no running session; next-launch preference not supported" (same as clx, app/claude/accounts.go:212-228).
- MCP `account_status`/`account_switch`: enable for `CXX_AGENT_PORTAL_ENGINE=grok` (mcp.go:962,1099). cgx main installs the broker handler (agentportal/accounts.go `SetAccountHandler`). Make the Skill text engine-aware: for Grok, "only this cgx launch moves; other launches keep their account".

---

## 7. Quota-limit failure signal

- Grok `StopFailure` classes are `rate_limit`, `authentication_failed`, `invalid_request`, `server_error`, `max_output_tokens` and `unknown`. "Capacity errors (503/529) classify as `rate_limit`" (GB/xai-grok-pager/docs/user-guide/10-hooks.md#L163, #L375, #L479).
  - Fields: `errorDetails` (raw, clipped to 1000), `lastAssistantMessage` (the error string), and `subagentType` (#L375, #L484).
  - Main sessions never wait on 429 (GB/xai-grok-shell/src/session/acp_session_impl/rate_limit_waits.rs#L1), so exhaustion ends the turn immediately.
- Credit exhaustion as seen in upstream fixtures: 429 `{"code":429,"error":"You ran out of credits. [WKE=personal-team-blocked:spending-limit]"}`. The WKE slug is lifted out of the message (GB/xai-grok-sampling-types/src/provider_error.rs#L338-L341). This reads like **API-credit** wording.
- `billing_error` / "Your credit balance is too low" (#L273-L275) is an Anthropic-shaped provider fixture and **not** a Grok hook class. The current classifier's `billing_error → blocked` (agentbus/watchdog_event.go:45) never fires for Grok; such failures land in `rate_limit` (429) or `unknown`.
- Today `watchdogHookFailure` maps Grok `rate_limit` to `capacity`, reads camelCase fields, ignores subagents, and never sends `quota_limit` (watchdog_event.go:13-55).
- **Proposal for quota-continue:**
  - `quota_limit: true` only when `error == rate_limit` **and** `errorDetails` or `lastAssistantMessage` matches a captured subscription-exhaustion phrase set (`ran out of credits`, `spending-limit`, `usage limit`, …).
  - Server corroboration is accepted too: a fresh `current_window.used_percent ≥ 100` for the bound account.
  - Plain 429 throttling and 503/529 stay `capacity` without `quota_limit`.
  - **The subscription (SuperGrok) exhaustion text is unverified.** A real StopFailure payload must be captured before the matcher ships (step 0 P10).

---

## 8. Feasibility verdict
**Full live switch** for interactive private-leader launches, at an all-idle turn boundary, conditional on step 0. The fallbacks are:
- If **P1 fails** (no hot-reload on 1.0.92): switch at a boundary by restarting the private leader with `--resume <id>` on B. This interrupts the TUI, so it is an explicit operator choice.
- If **P3 fails** (encrypted history is account-bound): cross-account continuation of the same conversation is impossible, live or by resume. The switch then only helps new sessions, and today's next-launch resume across accounts is equally affected and should be documented.
- **Headless and no-leader runs: next-launch only.** They never advertise the capability. Native disk adoption near expiry would technically pick up a file, but nothing relies on it.

---

## 9. Proposed design

### 9.1 Scope model (recommended: per launch)
Claude's scope is "the native credential directory". For Grok that directory is each launch's private home, so recommend `scope_id = "grok-rt:" + sha256(rt.Dir)`, using a new `accountpool.LoadScoped`.

Consequences:
- No cross-launch coordination is needed.
- Old wrappers' leases never share a scope with new ones (§13).
- `updateScope` (account-switch.ts:367) moves exactly one launch.
- The `localActive` guard (context.go:276-281) is not needed for Grok.
- **Cost:** concurrent launches are no longer pinned to one account. `selectForLaunch` balances them. This needs operator approval (Q1).
- *Alternative (home-wide scope kept):* the commit gate requires sibling turn markers from every launch. Each launch's supervisor, on observing `binding_generation+1` (`observeBindingLocked`, accountpool/switch.go:62), must perform the §2 write in its own runtime under its own locks. Until then its broker answers 503. The server must refuse a scope that contains a non-capable lease.

### 9.2 Server
1. **Capability per lease (shared).**
   - Add `provider_account_sessions.live_switch TINYINT NOT NULL DEFAULT 0` (idempotent migration plus `schema.ts` and the owner-state mirror). Acquire reads `live_switch: true`.
   - `switchCapable(engine, leases)`: Claude is always capable (legacy). For other engines in `LIVE_SWITCH_ENGINES`, every live lease of the scope must carry the flag.
   - Gate `requestSwitch`, `evaluate`, directive emission in `sessionExtras`, and the per-scope `poolView`/`quota_pool` `live_switch` with it. A non-capable Grok scope keeps the "pause" advice.
2. **Grok commit branch, landing before grok joins the set.**
   - In `/auth/sessions/switch` (index.ts:516-580), for Grok, replace `canonicalAuthFromPayload` with `createGrokAuthOwner.ensureFresh({accountId: committed.account_id, sourceHostId, sessionId})`.
   - Return `auth` (the projection), `canonical_generation`, `access_token_digest`, `access_expires_at` and `verification_state: verified`, the same shape as the Grok acquire branch (:286-315).
   - `credentialsReady` uses the Grok owner state, not the runner payload. Replay (`replayed: true`, account-switch.ts:567-568) serves a fresh projection again.
   - Test: deep-scan the response for `refresh_token` and expect none.
3. **Extras.** Add `sessionExtras` to the Grok acquire and heartbeat branches (:286-315, :387-399).
4. **Join.** `LIVE_SWITCH_ENGINES = {'claude','grok'}`, plus `poolRecommendation(..., live)` per capable scope.
   - `reapAbandonedProviders(owner, LIVE_SWITCH_ENGINES)` is keyed on the **engine set only** (api/src/control-plane/streams/provider-leases.ts:65-130; called at account-policy-worker.ts:35). It removes connection-mode leases whose attachment has been gone past the grace period.
   - Joining the set unchanged would therefore also reap **old and headless** `cgx` leases. Their readiness loop would then hit a confirmed 404, which is fatal (`FatalAuthError`, nativeengine/runtime.go:78-85), and end the session.
   - So pass a predicate: Claude leases plus non-Claude leases with `live_switch = 1`.
   - `evaluate` (account-switch.ts:822) must skip non-capable scopes.
   - The evaluate-on-unusable call at routes/auth/index.ts:354 sits in the generic acquire path. The Grok acquire returns earlier (:286-315), so the Grok branch needs its own call, made only for a capable lease.
5. **`enforceAccountSession` stays strict** for Grok (:2040). The wrapper guarantees no stale `account_id` by holding `r.mu` across commit and apply, and by re-binding `WatchAuth` (§9.3).
6. **Agent-session move (shared improvement).**
   - Today `moveAgentSessions` skips the move when any other scope on the host still uses A (account-switch.ts:655-689). Per-launch Grok scopes hit this often, so the ACCOUNT/1 notice and the `quota_get` account go stale until re-registration heals them (agent-portal/admin-host.ts:199-210).
   - Store `agent_sessions.provider_session_id` at registration (already sent: admin-host.ts:106,125-129) and move exactly the sessions bound to leases of this scope. This helps Claude too.
7. **Identity hardening (§5)** in `resolveCandidateDetailed` for Grok: require identity in an attributed pool, refuse insecure implicit enrolment, and port the tombstone release on `enroll: true`.
8. **Quota-continue hook-in.** Accept `quota_limit` from Grok only for capable scopes (watchdogs.ts `activity()`, quota-observation.ts gate). No Grok-specific server logic beyond the §7 corroboration.

### 9.3 Wrapper
1. **Shared supervisor core.** Move `performAccountSwitch`/`finishAccountSwitch`/`runAccountSwitcher` and `accountSwitchDeps` from `persona/claude/lifecycle/account_switch_run.go` into `internal/accountpool/supervisor.go` unchanged (poll 60 s, gate 5 s, retry 15 s, finish tries 20). Claude passes its existing deps.
2. **Grok deps** (`internal/grok/switch.go`):
   - `heartbeat`: `pool.Heartbeat` (directive).
   - `idle`: roster all-idle, as in §3.
   - `flush`: none (refresh is server-owned).
   - `commit`: `pool.CommitSwitch` with `live_switch` acquire.
   - `write`: `rt.SwitchWrite`.
   - `matches`: ACP confirmation.
   - `markRepair`/`clearRepair`/`repairPending`: the existing accountpool repair flag.
   - `pauseSync`/`resumeSync`: stop the readiness loop and `WatchAuth`, then restart `WatchAuth` with `pool.Binding()` after apply (main.go:899-946). This matters because `WatchAuth` captured A at start.
3. **`rt.SwitchWrite`** (`internal/grok/runtime.go`, plus `lock.go` for the native flock):
   1. Try `flock(LOCK_EX|LOCK_NB)` on `<rt.Home>/auth.json.lock` for ≤2 s, else retry at the next gate.
   2. Take `r.mu` via `r.lock(ctx)` (runtime.go:431-444). **Order: native flock, then `r.mu`**, which matches native (flock → external command → broker → `r.mu`). Both are held through step 9.
   3. Re-check idle.
   4. CAS that the disk digest is in `r.issued`.
   5. `markRepair`, then commit.
   6. `validateProjection` against the **target** account, with the regression check reset.
   7. Build the native store, set `create_time = now`, and `AtomicWrite`.
   8. Set `r.issued = [B]`, write `issued.json`, `ApplySwitch`, and `r.nativeAccountID = B`.
   9. Unlock `r.mu`, then the flock.

   On a write failure after commit: keep the repair flag. The broker answers 503 (`nativeAccountID ≠ Pool.AccountID`). Retry by replaying the commit (repeatable) for a fresh projection, and report `credential_write: unfinished` (index.ts:543-546).
4. **Confirmation (`matches`).**
   - Within 10 s, call `_x.ai/auth/getBearerToken` on the leader socket. The wire name (`x.ai/auth/getBearerToken` in source, `_`-prefixed on the ACP wire like `_x.ai/sessions/list`) and whether a `cxx-receiver` client may call it are **unverified on 1.0.92** (step 0 P12). (GB/xai-grok-shell/src/extensions/auth.rs#L13-L28, #L77-L91). Compare sha256 with B's digest, keep only the digest, never log it.
   - Optionally call `x.ai/auth/info` (#L204ff) to confirm B's email and team.
   - If that fails, rewrite the same content once (the reloader's hash is still A's, so it fires again). If it still fails, rely on the near-expiry disk adoption and surface a doctor warning plus a status row ("switch committed; native adoption unconfirmed").
5. **Capability:** advertise `live_switch: true` only for interactive launches with the wrapper's private leader. Never for headless, `--no-leader`, or a user-supplied `--leader-socket`.
6. **UI:**
   - The card, `cgx status` and `doctor` show the binding and the last switch.
   - Add the `cgx accounts` subcommand (`internal/app/grok/accounts.go`, dispatch in commands.go and main.go:358-370).
   - Enable the MCP tools (mcp.go, agentportal/accounts.go).
   - Make the ACCOUNT/1 notice text engine-aware.
7. **Watchdog** (`agentbus/watchdog_event.go`): the Grok credit-exhaustion classification of §7, behind the quota-continue contract.
8. Bump `VERSION` in `wrappers/Makefile`.

### 9.4 Docs
- docs/interface-cgx.md:
  - a new section "Several Grok subscriptions and live switching";
  - amend :777-782 (the pause advice now applies only to non-capable launches) and :953 (scope);
  - list the step 0 verification under Sources.
- docs/interface-api.md: in the multi-account section (~:2535-2707), add Grok as a live engine, the `live_switch` lease flag, and the Grok commit response shape; keep the ":2594-2595 (Grok reports no usage) … falls back to the balanced choice" launch rule until phase 2.
- docs/interface-db.md: the migrations.
- CHANGELOG.md.
- AGENTS.md: update the Grok engine-parity bullet (live switch, per-launch scope).
- Admin Accounts copy, if it shows live capability.

### 9.5 Tests
- **API integration** (`api/test/integration/provider-accounts/grok-switch.test.ts`, new):
  - a capable lease gets the directive and a non-capable one never does;
  - `evaluate` skips non-capable scopes;
  - commit returns an access-only projection (no `refresh_token`, digest and expiry match);
  - replay serves a fresh projection;
  - an unusable target leads to withdrawal;
  - after commit a stale `account_id` A gets 400 and B gets 200;
  - the agent session moves by provider session;
  - identity refusals (missing `user_id` in an attributed pool, insecure implicit enrolment, removed account revived only by `enroll`).
- **API unit/contract:** `poolView` live per scope; `api/test/unit/contract/engine-parity.test.ts`; the `grok-owner` and `grok-usage` suites stay green.
- **Go:**
  - runtime switch-write tests: CAS refusal on an unknown disk digest, `create_time` rewrite, issued reset, cross-account generation accepted, broker 503 while `native ≠ pool`, lock order with a simulated native flock holder;
  - supervisor tests with a fake leader (busy roster leads to no commit; idle leads to commit, write and confirm; failed confirmation leads to rewrite then warning; commit-then-crash leads to repair and replay);
  - watchdog fixtures (credits text gives `quota_limit`, 503/529 gives `capacity` only, subagent events ignored);
  - MCP gating and `cgx accounts` CLI tests;
  - `go build ./... && go vet ./...`.

### 9.6 Claude hardening guarantees carried over (git log 8a4bbd28b..742d209ba)

| Guarantee | Grok |
|---|---|
| Identity refusal (`account_identity_unavailable`) | **Carried.** §5 and §9.2.7: refuse unattributable logins in an attributed pool, never attach to the sole account. |
| Removed / removing accounts | **Carried.** A scope bound to a `removing` account gets a directive through `evaluate` (unusable account), so capable launches drain off it at the next idle boundary. Non-capable launches keep it until they end, as today. The tombstone and `enroll` revive are ported (§5). The 409 `account_removed`-on-flush loop fixed in 90cf0c724 cannot occur, because Grok has no flush: hosts never upload rotations. |
| Usage attribution via the reporting host lease | **N/A.** Readings are server-pulled per account with that account's token (§4). Hosts report nothing that could be misfiled. |
| Per-window usage merge | **N/A in phase 1.** One server-side billing window per account, no partial host reports. Phase 2 mapping must keep "missing never becomes 0" and respect `shared` budgets. |
| Repeatable commit | **Carried.** Replay (account-switch.ts:567-568) serves a fresh ensureFresh projection (§9.2.2). |
| Repair flag | **Carried.** It covers commit-then-write failure. The broker answers 503 while `nativeAccountID ≠ Pool.AccountID` (§2, §9.3.3), and the write is retried by replaying the commit. |
| Sibling turn markers (bounded busy marker) | **Replaced** under per-launch scope by the native leader roster. That roster is authoritative and does not go stale like a hook marker, and `dead` sessions are ignored. Under the home-wide alternative the markers are carried unchanged. |
| Lease reaping | **Carried for capable leases.** The reaper predicate is capability-gated, so old and headless `cgx` leases are not reaped (§9.2.4, §13). |

---

## 10. Ordered implementation plan

0. **Live verification (needs operator approval).** It needs two real Grok subscriptions and a disposable host user with an isolated `GROK_HOME` per launch. Grok 1.0.92 runs as a private leader on A. Pass/fail:
   - **P1:** atomically replacing `auth.json` with B's projection (`create_time = now`) logs "auth hot-swapped from disk" within 3 s, and `_x.ai/auth/getBearerToken` returns B's digest.
   - **P2:** the next prompt in the same session succeeds and is billed to B (B's reading moves, A's does not).
   - **P3:** a multi-turn history from A with reasoning, tool calls and an image replays on B with no 400 `encrypted_content` or image error.
   - **P4:** `x.ai/auth/info` reports B's email, team and ZDR, with no carried A profile.
   - **P5:** the model catalog matches B's plan; record the behaviour when the current model is missing on B.
   - **P6:** the `cxx-agent` MCP and receiver survive `ReloadAllMcpServers`.
   - **P7:** with the watcher defeated, near-expiry disk adoption takes B (`GROK_AUTH_EARLY_INVALIDATION_SECS` small), and the external command is never run with A's profile.
   - **P8:** `--relay-on-demand` relay state after the swap (no A-bound relay).
   - **P9:** headless and `--no-leader` are unaffected.
   - **P10:** capture a real subscription-exhaustion StopFailure payload.
   - **P11:** account-bound caches in the private home. These are `settings_cache.json`, `managed_config_cache.json`, `managed_config_refresh.json`, `experiments_remote_opt_out` and `agent_id`, which interface-cgx.md:964 lists as "bound to the operator's own account". Record which of them native rebuilds for B after the swap, and when, and whether the in-memory settings (data retention, experiments, managed config) follow B. If they do not, `SwitchWrite` must purge them before the write, or the switch is limited to a restart.
   - **P12:** establish which 1.0.92 process sends model requests for a pager attached with `--leader --leader-socket` (managed `leader worker` commands stay refused, interface-cgx.md:316-324,345-348). Confirm that the leader's `getBearerToken` reflects that process's credential.
   - **Gate:** P1, P2, P4, P6, P11 and P12 must pass. P3 failure changes the verdict (§8). P5 and P8 feed Q3 and the risks.
1. **Server, no behaviour change:** migration `NNNN_provider_session_live_switch.sql` plus `schema.ts` and the owner mirror; `switchCapable`; the Grok commit branch; Grok `sessionExtras`; tests. Grok stays out of `LIVE_SWITCH_ENGINES`.
2. **Server identity hardening** for Grok (§5), with tests.
3. **Wrapper:** extract the supervisor core (Claude tests unchanged); `accountpool.LoadScoped`; the `live_switch` acquire flag; `rt.SwitchWrite`, flock helper and broker guard; Grok deps; `WatchAuth` re-bind; ACP `bearerDigest`/`allIdle` in grok_queue.go; tests.
4. **Wrapper UX:** `cgx accounts list|add|use`; MCP tools; card, status and doctor rows; Skill text.
5. **Server:** add grok to `LIVE_SWITCH_ENGINES`, with policy, worker and reaper tests. Agent-session move by provider session (migration if the column is chosen).
6. **Quota-continue extension**, after that branch lands and P10 is captured: Grok classifier plus server corroboration.
7. **Docs, CHANGELOG, `VERSION` bump.** The canonical checks are `npm test` (api), `go build`/`go vet`/`go test` (wrappers) and `npm run check` (frontend, if copy changed).

**Files:**
- api/src/services/account-switch.ts
- api/src/routes/auth/index.ts
- api/src/services/provider-accounts.ts
- api/src/control-plane/streams/provider-leases.ts
- api/src/ops/account-policy-worker.ts (verify only)
- api/src/db/migrations/NNNN_*.sql and api/src/db/schema.ts (and the owner-state table types)
- api/src/routes/agent-portal/admin-host.ts
- api/src/services/managed-account-switch-skill.ts
- api/src/services/watchdogs.ts and quota-observation.ts (quota-continue)
- wrappers/cxx/internal/accountpool/{supervisor.go,context.go,switch.go}
- wrappers/cxx/internal/persona/claude/lifecycle/account_switch*.go (move only)
- wrappers/cxx/internal/grok/{runtime.go,switch.go,lock.go}
- wrappers/cxx/internal/agentbus/{grok_queue.go,mcp.go,watchdog_event.go}
- wrappers/cxx/internal/agentportal/accounts.go
- wrappers/cxx/internal/app/grok/{main.go,accounts.go,commands.go,login.go,startup.go,doctor.go}
- wrappers/Makefile
- docs/interface-{cgx,api,db}.md, CHANGELOG.md, AGENTS.md
- tests as in §9.5

---

## 11. Shared (engine-agnostic) vs Grok-specific

| Shared / engine-agnostic | Grok-specific |
|---|---|
| Lease, scope, generation CAS, directive/commit/replay, repair flag, reaper, policy (`account-switch.ts`, accountpool) | Commit response is an ensureFresh **access-only projection**, never canonical auth |
| `live_switch` lease capability and `switchCapable` gate | Per-launch scope (private `GROK_HOME`) |
| Supervisor core (extracted from the Claude persona) | Write = native flock → `r.mu` → issued-digest CAS → full projection with `create_time = now` → issued reset → `nativeAccountID` broker guard |
| `/auth/accounts`, switch-request, `accounts list\|add\|use` shape, MCP account tools | Idle gate from leader ACP roster; confirmation via `_x.ai/auth/getBearerToken` |
| Identity tombstone and insecure-enrol rules (ported, keyed per engine) | Identity = `user_id` (optional `sub` cross-check) |
| Agent-session move by provider session id | No flush step; no usage-report attribution (server-pulled billing) |
| Quota-continue marker/gate contract | Credit-exhaustion text matcher on `rate_limit`, plus billing corroboration |

---

## 12. Risks and mitigations

1. **Release drift** (post-1.0.46 source synced 2026-09-29 vs 1.0.92). Mitigation: step 0 is a hard gate, and the capability is advertised only by wrappers that check `grok --version` ≥ the verified version.
2. **Account-bound encrypted reasoning** (terminal error, sampler_turn.rs#L1307-L1324). Mitigation: P3. If it fails, offer no live switch for conversations already holding encrypted reasoning, and document it.
3. **Profile contamination via `carry_user_profile_from`.** Mitigation: always write the full projection. The broker answers 503 while the disk and pool accounts differ. Confirm with `auth/info`.
4. **Missed hot-reload** (watcher start failure, #L1182). Mitigation: ACP confirmation, one rewrite, then near-expiry disk adoption (adoption cannot decline because `create_time = now`), plus a doctor warning.
5. **Plan mismatch:** `on_auth_changed` refetches the models for B. Mitigation: filter targets by plan from `/v1/settings` (grok-usage plan), and leave the policy to Q3.
6. **`ReloadAllMcpServers` on swap** (GB/xai-grok-shell/src/extensions/session_admin.rs#L611). It already happens on every token rotation; P6.
7. **Relay** (`--relay-on-demand`): the auth update "arms the deferred relay" (app.rs#L1691); P8.
8. **Native flock contention** (native holds it up to 7 s during an external refresh). Mitigation: non-blocking try and retry at the next gate. The broker never takes the flock, so there is no deadlock.
9. **Stale `account_id` 400s** after the server moves the lease. Mitigation: `r.mu` held across commit and apply, the readiness loop paused, and `WatchAuth` re-bound. A 400 is not fatal (`FatalAuthError` only for 401/404/409, nativeengine/runtime.go:78-85).
10. **Shared billing budgets** (team or unified billing): switching may add no headroom. Phase 2 scoring must group them, and the dashboard shows `shared`.
11. **Per-launch scope changes launch distribution** (Q1).
12. **Mid-turn residual window** (§3): accepted.
13. **A's account-bound caches survive the swap** (settings, managed-config and experiment caches, `agent_id`; interface-cgx.md:964). A's data-retention or experiment state could apply to B. Mitigation: P11 decides between relying on native refetch, purging in `SwitchWrite`, or a restart.
14. **The ACP confirmation could check the wrong process, or be refused for receiver clients.** Mitigation: P12. The fallback evidence is the next broker `/token` call, whose disk digest proves B is on disk but not in memory.

---

## 13. Older-wrapper compatibility

- **Old `cgx`** sends no `live_switch`, so the column defaults to 0. It never gets a directive, is never moved by `evaluate`, and is **not reaped**, because the reaper predicate is capability-gated (§9.2.4). Its `quota_pool` keeps `live_switch: false` and the pause advice. Behaviour is identical to today. Headless and no-leader launches of a new `cgx` are treated the same way.
- Old leases use the home-hash scope and new ones the per-launch scope, so the two never mix. Even under the home-wide alternative, `switchCapable` refuses mixed scopes.
- **Server before wrapper:** harmless. **Wrapper before server:** the acquire flag is ignored, no `sessionExtras` arrive, the supervisor stays idle, and an attempted commit gets `account_switch_unsupported_engine`, which disables the supervisor for the launch.
- **Claude is unchanged:** it is treated as capable without the flag, and the supervisor move is a pure refactor under the existing tests.
- The old MCP tools keep refusing Grok. The Skill text is served per engine.
- Quota-continue fires for Grok only on capable scopes, so the in-flight branch stays compatible. Its Claude path is untouched.

---

## 14. Open questions for the operator

1. **Scope:** per-launch scope (recommended), where concurrent `cgx` launches may sit on different accounts and only the switched launch moves? Or keep "all `cgx` sessions of one home share an account", which needs every runtime to adopt?
2. **Phase 2 scoring:** use Grok billing `current_window` for balancing and ceilings (opt-in), knowing the code and docs currently say "observation only"?
3. **Plan mismatch:** switch only to accounts with an equal-or-higher plan (for example SuperGrok vs Heavy), or allow and accept a model fallback or failure?
4. **Step 0:** approve a live test with two real Grok subscriptions on a disposable host user. It leases real accounts and spends their credits.
