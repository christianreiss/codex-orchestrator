# Multi-account live switching for Codex (`cdx`) — design

Status: research/design only (read-only). Repo `main` @ 742d209ba (cxx 0.9.211). Upstream Codex pinned
to the fleet's installed **0.172.0** (`rust-v0.172.0`, tag sha fc3036db), cross-checked against
`rust-v0.174.0-alpha.7` (no differences in the auth/app-server files that matter here). Date: 2026-11-26.

Upstream links use `U:<path>#Lx` = `https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/<path>#Lx`.
Items marked † were read by a research sub-agent at the tag and not re-read by me; items marked
**[LAB]** are unverified behaviour that must be proven on a lab VM before the feature ships.

## 0. Verdict (short)

- **A running Codex cannot pick up a changed `~/.codex/auth.json`.** Verified: credentials are cached
  in memory ("External modifications to stored credentials will NOT be observed until `reload()` is
  called explicitly", U:login/src/auth/manager.rs#L2228-L2235 †). Every automatic reload (401
  recovery, proactive refresh) is guarded by `reload_if_account_id_matches` (U:…/manager.rs#L2981)
  and turns a different account into a permanent turn failure "…you have since logged out or signed
  in to another account. Please sign in again." (#L240). No public RPC reloads disk ChatGPT auth;
  `reload()` is called only after an API-key/Bedrock login or a completed browser/device login
  (U:app-server/src/request_processors/account_processor.rs#L517,#L621,#L1037).
- **The only in-process swap** is `account/login/start {type:"chatgptAuthTokens"}`, marked
  `[UNSTABLE] FOR OPENAI INTERNAL USE ONLY - DO NOT USE` (U:app-server-protocol/src/protocol/v2/account.rs#L99-L115).
  It moves the process into external-token mode permanently: Codex stops refreshing; refresh is a
  broadcast server→client request with a 10 s timeout (U:app-server/src/external_auth.rs#L18,#L33-L82;
  U:app-server/src/outgoing_message.rs#L414-L422,#L523-L529) that the TUI does not answer
  (U:tui/src/app/app_server_requests.rs#L199,#L476); the only exit is `account/logout`, which revokes at
  the IdP (U:login/src/auth/revoke.rs#L55-L73 †). Upstream's own `accountSession/switch` stops every
  thread before replacing credentials (†). **Not recommended as the default.**
- **Recommended: "live switch by supervised backend restart at a turn boundary."** Interactive
  receiver launches already run a wrapper-owned `codex app-server --listen unix://…/codex.sock` with
  the TUI attached via `--remote` (wrappers/cxx/internal/codex/receiver.go:51-137). At an idle point
  the supervisor flushes A, commits the switch, stops the app-server, CAS-writes B's `auth.json`,
  starts a new app-server on the same socket; the TUI reconnects within its 120 s budget and resumes
  the same thread with `thread/resume` / `PreserveExistingThread` (U:tui/src/app/reconnect.rs#L60-L92).
  Native refresh ownership stays exactly as today (host-owned, file-based).
- **Coverage:** TTY+receiver TUI sessions (the default) switch live; persistent-worker and `cdx exec`
  turns switch at their next per-turn launch (a running one only delays a commit); everything else
  (embedded TUI, receiver off, user `--remote`, old wrappers, raw `codex`) keeps next-launch semantics
  and **blocks** live commits in its scope while it runs.
- **Go/no-go gates [LAB]:** cross-account thread continuation (`invalid_encrypted_content`, see R1),
  TUI reconnect under a restart, and the upstream `cli_resume_account_check` feature staying off (R2).

---

## 1. Current state (what exists, what is missing vs Claude)

### Server (engine-agnostic already)
- Pool, lease, scope rows: `provider_account_sessions` carries `scope_id`, `binding_generation`,
  `desired_account_id/_reason/_at`, `bound_at` for every engine (migration
  `api/src/db/migrations/0150_provider_scope_switch.sql`; api/src/db/schema.ts:233-255). The scope
  model needs no change for Codex; only a per-lease capability column is proposed (§9 S1).
- Launch selection: `POST /auth/sessions` (api/src/routes/auth/index.ts:256-370) is engine-generic for
  Codex (falls through the Grok/Kimi branches at :286/:316 to the canonical-payload path at :346).
  Codex scoring reads `chatgpt_usage_snapshots` by duration, not slot
  (api/src/control-plane/streams/provider-leases.ts:184-199).
- `GET /auth/accounts` (:471-498) and `quota_pool` on `/auth` + `/sync/bootstrap` (`withPoolExtras`
  :428-468) are served for Codex; `live_switch: LIVE_SWITCH_ENGINES.has(engine)` is `false`.
- `quota_advice.codex.pool` (docs/interface-api.md:2398-2415) is served.
- The live-switch machinery is gated by one set:
  `LIVE_SWITCH_ENGINES = new Set(['claude'])` (api/src/services/account-switch.ts:31). Gates:
  `requestSwitch` :461, `commitSwitch` :561, `evaluate` :822, `poolView` live flag :768,
  `sessionExtras` (binding_generation/account_switch in acquire/heartbeat/`/auth`)
  routes/auth/index.ts:186, evaluate-on-unusable :354, policy worker + lease reaper
  api/src/ops/account-policy-worker.ts:28,35,40.
- `enforceAccountSession` refuses a mismatching `account_id` for every engine except Claude
  (routes/auth/index.ts:2040) — a sibling that has not yet adopted a committed switch would get
  `400 Account does not match session` for Codex.
- `presented_account_id` on `/auth` retrieve (routes/auth/index.ts:1218-1230) is engine-agnostic
  server code; only the Claude wrapper parses it (persona/claude/orchestrator/auth.go:38).
- Identity: `providerIdentity()` = `sha256("codex:" + tokens.account_id)`
  (api/src/services/provider-accounts.ts:48-55). The Claude-only branches of
  `resolveCandidateDetailed` (:199-214 unproven heads, :262-310 removed-account tombstone
  `account_removed`, operator `account_identity_mismatch`, `account_enroll_insecure_host`) do **not**
  apply to Codex; Codex uses the generic rules at :311-346, where an unknown identity on a plain sync
  with several identified accounts appears to reach `insertAccount` (:346), i.e. auto-enrols. That is
  the documented Codex behaviour ("Client uploads with a distinct provider identity can enroll another
  verified account", docs/interface-cdx.md:1757).
- `enroll: true` store is engine-agnostic (routes/auth/index.ts:1607-1621).
- Usage: server-pulled. `ChatGptUsageService` calls `chatgpt.com/backend-api/wham/usage` with the
  account's canonical access token + `ChatGPT-Account-Id` (api/src/services/chatgpt-usage.ts:661-735),
  per enabled account, every `CHATGPT_USAGE_CRON_INTERVAL` = 900 s (env.ts:230,
  ops/provider-obligations.ts:48-84), 5-min floor (`MIN_REFRESH_SECONDS` chatgpt-usage.ts:46). A
  non-2xx answer is stored as an error snapshot (:743-754). `/auth` reads the stored snapshot only
  (routes/auth/index.ts:1957-1978).
- Token refresh owner: **the host (verified)**. Evidence: docs/auth-resilience.md:15-17 ("Codex and
  Claude still perform their own refresh"), :114-119 (cross-host refresh spends not serialized); the
  runner blanks `refresh_token` before probing (runner/app.py:186-201); the verification worker skips
  probes that would need a refresh spend and keeps a verified lineage serving because hosts hold the
  refresh token and heal it natively (api/src/ops/auth-verification-worker.ts:226-240); the served
  canonical auth is the full native `auth.json` including `tokens.refresh_token`
  (runner-validation.ts:245-262). Every host that leases account X holds X's spendable refresh token.

### Wrapper
- Lease: `accountpool.Load("codex", …)` + `Pool.Start` (persona/codex/lifecycle/run.go:311,432-457).
  `Pool.Start` refuses to rebind a scope with an active native child
  (accountpool/context.go:279-323) and writes the leased head with `WriteAssignedAccountIfCurrent(…,
  switching)`, which needs the exclusive writer lease, i.e. no active child (codex/auth_writer.go:1304,
  :709-727). That is the documented "next launch" semantics (docs/interface-cdx.md:1755).
- Codex leases already keep a connection attachment and heartbeat every 90 s through the shared
  `Pool.Start` loop (accountpool/context.go:60,360-407). Doc drift: interface-cdx.md:1755 still says
  "Heartbeats run every 30 seconds".
- `accountpool` (Context, markers, heartbeat re-reserve on 404, directive fencing
  `observeBindingLocked`, `CommitSwitch`, `ApplySwitch`, repair flag) is engine-agnostic
  (accountpool/context.go, switch.go, markers.go). Only the Claude persona drives it.
- No Codex switch supervisor, no `presented_account_id`/`BoundAccountMismatch` handling in
  `persona/codex/lifecycle/auth_sync.go`, no session-marker turn publishing for Codex.
- Card/status/doctor pool rows exist (docs/interface-cdx.md:1760-1778;
  persona/codex/summary/summary.go:567). `cdx status` reads `GET /auth/accounts?engine=codex`.
- No `cdx accounts` subcommand ("There is no `cdx accounts add`", interface-cdx.md:1775).
- MCP `account_status`/`account_switch` are Claude-only: broker refuses other engines
  (agentportal/accounts.go:52-54), tool descriptions say "Claude sessions only"
  (agentbus/mcp.go:576-577), fleet Skill text (api/src/services/managed-account-switch-skill.ts:5,44).
- Codex app-server: interactive receiver-enabled launches (`ReceiverEnabled && stdout/stdin TTY &&
  CXX_AGENT_PORTAL_SOCKET`, codex/exec.go:300-308) run **one wrapper-owned
  `codex app-server --listen unix://…/codex.sock`** and start the TUI with `--remote unix://…`
  (codex/receiver.go:51-137). `exec`/`e`/`review` and a user `--remote` never get one (:54-64). Both
  the app-server and the TUI inherit the native child lease (`AttachAuthLeaseFiles`, receiver.go:98,
  exec.go:326), so the exclusive writer lease is unobtainable while the TUI lives. The receiver
  adapter `cxx agent mcp --auto` is an MCP server *of that app-server* (receiver.go:28-39) and a
  client of the portal broker that lives in the wrapper parent (agentportal/broker.go).
- Turn evidence available today: `thread/read` status `idle|active(+activeFlags)|systemError|…`
  (agentbus/activity.go:18-50), newest turn via `thread/turns/list` (native_queue.go:227-276); the
  native-queue client already initializes with `experimentalApi: true` (native_queue.go:60). Codex has
  no hook surface in the fleet (interface-cdx.md:2959).
- Failure signal: the receiver classifies a failed newest turn whose error contains
  `usage limit|rate_limit|quota limit|at capacity|overloaded` as `capacity` and posts
  `watchdog/activity {failure:"capacity", retry_not_before}` (native_queue.go:286-325,
  receiver_failure.go:13-51). AED auto-continue excludes usage/rate limits (native_queue.go:283-291).
  No `quota_limit: true` is sent.

### Missing vs Claude (checklist)
| Claude has | Codex today |
|---|---|
| `LIVE_SWITCH_ENGINES` membership, policy evaluator, request/commit routes | refused `account_switch_unsupported_engine` |
| switch supervisor (heartbeat → directive → idle gate → flush → commit → CAS write) | none |
| native adopts new credentials mid-session | impossible via file (§2); needs backend restart |
| turn-idle evidence + sibling markers | thread status only inside the receiver; no markers |
| `BoundAccountMismatch` / repair flag consumer | none |
| identity refusal, tombstone, explicit enrolment | `tokens.account_id` only; auto-enrol; no tombstone |
| `clx accounts list|add|use` | none |
| `account_status` / `account_switch` MCP | Claude only |
| usage attributed per reporting lease, stale-reading guard | server-pulled per account (no misattribution, 15-min cadence) |
| reaper for abandoned connection leases | Codex leases heartbeat but are not in the reaper set |

---

## 2. Q2 — How Codex consumes credentials mid-session, who refreshes, what a switch writes

**Where it reads.** `AuthManager` per process (app-server builds one, U:app-server/src/lib.rs#L607 †).
Load order (U:login/src/auth/manager.rs#L1606-L1736 †, ephemeral-first verified at #L1629-L1636):
`CODEX_API_KEY` (disabled in app-server), the in-memory **ephemeral** store (external tokens), then
`CODEX_ACCESS_TOKEN`, then the configured store (`cli_auth_credentials_store`; the fleet forces `file`,
docs/interface-cdx.md:2530) at `$CODEX_HOME/auth.json`.

**Caching / re-read.**
- Cached in memory; no file watcher (†). `auth()` is called per model request
  (U:model-provider/src/request_setup.rs#L64-L67 †) and returns the cache, doing a proactive refresh
  only when the access token JWT `exp` is within 5 minutes (`CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES`,
  #L233; fallback `last_refresh` older than 8 days, #L232) (U:…/manager.rs#L2703-L2717 verified).
- Before refreshing, a guarded reload adopts a newer **same-account** file and skips the IdP call;
  a different `account_id` on disk ⇒ permanent mismatch error (#L3475-L3521 †, message #L240 verified).
- On 401: `UnauthorizedRecovery` = guarded reload (same account only) → OAuth refresh → give up
  (#L2049-L2225 †). The repo already documents this for 0.153.4
  (persona/codex/lifecycle/auth_sync.go:218-221).
- Write-back after its own refresh: `persist_tokens` takes `$CODEX_HOME/auth.lock`, re-reads, aborts
  with "Account credentials changed during refresh." unless the stored tokens are the ones it refreshed,
  then compare-and-save under `auth.json.lock` and rename (#L1760-L1804, storage.rs#L195-L295,
  storage_commit.rs#L29-L68 †). The network refresh itself is not under a file lock (†). The
  wrapper's own writer uses a different lock (`.cdx-auth.lock`, codex/auth_writer.go:1140-1170).
- Consequence for a sibling still running A after the file says B: it does **not** overwrite B
  (guarded), it **fails** its next refresh permanently ("sign in again"). If B lands between its
  guarded reload and its persist, A's rotated refresh token is lost fleet-wide (rare race, R4).

**Who refreshes:** the host-side native process (verified, §1). Nothing in this design changes that.

**What a switch must write:** the bound account's **full** native `auth.json` (with `refresh_token`,
`last_refresh`), not an access-only projection, into the scope's `$CODEX_HOME/auth.json`, as an exact
CAS on the generation the supervisor observed. Because the TUI child holds the child lease, neither
`WriteAssignedAccountIfCurrent(switching=true)` (needs no active child) nor a plain retry loop fits;
add `WriteLiveSwitchIfCurrent` (exact CAS beside an active child, recorded in the canonical-generation
ledger, cooperatively taking upstream's `auth.lock` around read-compare-rename) and call it only from
the supervisor after the gates in §3 passed (see §9 W5).

**Rejected mechanisms.**
- *File-only switch*: never adopted by a running process (above).
- *Reload RPC*: none exists for ChatGPT disk auth (§0).
- *External tokens (`chatgptAuthTokens`)*: internal-only/unstable; Codex never refreshes proactively in
  that mode (U:…/manager.rs#L2703-L2706; `refresh_token_if_requested` skips external,
  account_processor.rs#L1116-L1129) so the wrapper would have to mint access tokens itself (breaks
  host-native refresh ownership); refresh requests are broadcast and must be answered within 10 s by a
  connection the supervisor keeps alive; the TUI ignores them and may print a stub error
  (U:tui/src/chatwidget/protocol_requests.rs#L50-L58); exit only via revoking logout. Keep as a
  possible future opt-in once upstream stabilises it; do not build it now.

## 3. Q3 — Turn boundaries and siblings

**Evidence for a wrapper-owned app-server.** A supervisor connection (same JSON-RPC client as
native_queue.go) subscribes to `thread/status/changed` (`notLoaded|idle|systemError|active{activeFlags:
waitingOnApproval|waitingOnUserInput}`), `turn/started`, `turn/completed {turn.status
completed|interrupted|failed|inProgress}` (U:app-server-protocol/src/protocol/common.rs#L2111-L2113,
v2/thread.rs#L1810-L1827 †) and polls `thread/loaded/list` + `thread/read` as a cross-check
(activity.go:18-50 already reads these). Idle = every loaded thread `idle`, no active flags, no
`turn/started` without a matching `turn/completed`.

**Switch gate (all must hold, re-checked right before the stop):**
- G1 own backend idle (above) and no command-execution descendants of the app-server still running
  (background terminals die on restart; heuristic: descendants other than the configured MCP servers)
  **[LAB]**.
- G2 siblings: `SiblingTurns()` reports neither busy nor unknown, and every live marker of the scope
  declares a capability (new marker field, §9 W1): `apply` (supervised TUI), `transient` (a `cdx exec`
  or worker turn: busy for its whole life, so the commit waits for it to end, but the scope stays
  live), or none = incapable (embedded TUI, receiver off, user `--remote`, old wrappers), which blocks
  the commit for as long as it runs. Hard rule: **no live native process in the scope may hold A in
  memory past the write unless it can restart itself** — the failure it would suffer is destructive
  (permanent "signed in to another account" or a lost rotated refresh token), not merely stale.
- G3 the current file's access-token `exp` is at least 30 min ahead (local JWT read, no network): no
  native in the scope will proactively refresh A during the switch, and idle siblings have time to
  restart before their in-memory A token needs a refresh.
- G4 upstream resume check off (R2) and Codex version within the lab-verified range (reconnect exists
  since 0.160; ≤ the pinned version that passed the lab suite).

**Sequence (network before the stop, only local work inside the down window):**
1. Flush A: existing Codex session-auth sync of the current file (upload if unacknowledged).
2. Commit: `POST /auth/sessions/switch` (generation CAS, replay-safe, routes/auth/index.ts:516-580).
3. Stop own app-server (SIGTERM, bounded wait, SIGKILL). The TUI starts reconnecting (0,1,2,4,8 s…
   within 120 s, U:tui/src/app/reconnect.rs#L60-L92).
4. `WriteLiveSwitchIfCurrent(B, expected = generation read in the gate)`.
5. Start a new app-server on the same socket with the same args and re-attached leases.
6. Verify on a fresh connection: `account/read` names B's account id; publish `authnotice` for the
   scope, MCP notice and card line.
- CAS miss in 4: if the file already holds B (a sibling finished it), just start; otherwise start on
  what is there (A or A'), set the repair flag, and retry the write at the next idle (the
  `finishAccountSwitch` "whoever is left" rule of cxx 0.9.211). The fallback is always "restart on the
  file as it is + repair flag", never a session without a backend.
- Start failure: bounded retries inside the 120 s budget; then end the session with a clear message.

**Siblings after a commit.** Each capable sibling supervisor learns of the move from the local auth
notice / file generation change (immediate) or its heartbeat `binding_generation` (≤ 60 s poll) and
restarts its own app-server at its own idle without writing (the file already holds B). If the file
does not hold the bound account, the first idle capable session performs the write. A sibling that
became busy after the gate keeps running its turn on A in memory (G3 bounds the token life); if its
refresh still fails, the receiver sees `codexErrorInfo: unauthorized`, the supervisor restarts on B,
and quota-continue/AED may continue.

**Persistent worker.** `cxx codex --skip-boot run exec [resume] --json` is a fresh launch per turn
(agentbus/worker.go:747-766): it declares `transient` and publishes `turn: busy` while running (so a
TUI sibling waits), and its next turn simply launches on the bound account. No supervisor.

**Upstream turn hooks do not help (†).** Codex has a `notify` argv (`agent-turn-complete`,
U:hooks/src/legacy_notify.rs#L14-L42) and a hooks engine with a `Stop` event; both are completion
signals only, and a session without a wrapper-owned app-server still has no way to apply a switch, so
they would not widen coverage. The fleet doc's "no hook surface" (interface-cdx.md:2959) describes the
fleet integration, not upstream.

## 4. Q4 — Usage readings: freshness and attribution

- **Attribution is correct by construction**: the server pulls `wham/usage` per account with that
  account's own canonical token and `ChatGPT-Account-Id` (chatgpt-usage.ts:661-735). The Claude
  problem (a statusline reading filed under the new binding, `staleSwitchReading`,
  account-switch.ts:149-175) does not arise for the server pull.
- **Freshness** is the gap: 900 s cadence, 300 s floor. Proposal: after a Codex `commitSwitch`, mark
  the old and new accounts due now (still honouring the floor) in provider-obligations, and run
  `evaluate` after each Codex snapshot store for live scopes. A hard limit does not wait for the pull:
  the `quota_limit` failure signal (§7) marks exhaustion immediately (quota-continue path).
- **Idle accounts**: the server never refreshes Codex tokens, so an enrolled account nobody uses has an
  error snapshot once its access token expires (chatgpt-usage.ts:743-754). `poolPosition` then has no
  score (`score: null`, account-switch.ts:110-127); keep such accounts eligible only as "unknown" per
  the existing policy rules, and show "reading stale" in the pool view.
- **Optional phase 2**: forward `account/rateLimits/updated` / `token_count.rate_limits` from the
  app-server through an engine-generic version of `/claude/usage/report` (routes/auth/index.ts:738-782)
  attributed via the reporting lease, with the existing per-window merge and `staleSwitchReading`.
  After a restart the new backend only sees B's responses, so the stale-reading risk is smaller than
  Claude's; the TUI may display A's last limits until B's first response (cosmetic).

## 5. Q5 — Identity

- Today: `sha256("codex:" + tokens.account_id)` (provider-accounts.ts:48-55). The request header
  `chatgpt-account-id` is also `tokens.account_id` (U:…/manager.rs#L691-L703 †).
- Collision: two seats of the same ChatGPT Business/Team workspace share `account_id` (workspace id)
  and would merge into one pool account. `IdTokenInfo` carries `chatgpt_user_id` (claim
  `https://api.openai.com/auth`.`chatgpt_user_id`, fallback `user_id`) (U:login/src/token_data.rs#L44-L57,
  #L103-L114 †). If the operator pools seats of one workspace (open question 2), identity becomes
  `account_id + ":" + chatgpt_user_id`, with a one-time compatibility match: a stored legacy identity
  equal to `sha256("codex:"+account_id)` is upgraded on the first upload whose account_id matches and
  whose user id matches the stored head's id_token.
- Carry the Claude guarantees over (§10): refuse a plain-sync upload of an unknown identity when the
  pool already has identified accounts (`account_enroll_insecure_host` /
  `account_assignment_required`), honour the `account_removed` tombstone, refuse an operator
  replacement whose identity belongs elsewhere (`account_identity_mismatch`). Unattributable logins
  (no `tokens.account_id`, e.g. API-key mode) stay "opaque" and keep the existing assignment rules.
  This changes documented behaviour (interface-cdx.md:1757) → open question 1.

## 6. Q6 — Enrolment UX

- `cdx accounts list` — `GET /auth/accounts?engine=codex` (exists), same table as clx.
- `cdx accounts add [--device-auth] [--label …]` — private `CODEX_HOME` under `~/.cxx/codex-enroll/<random>`
  (0700), run the **real** native binary (bypassing the native-entry shim) as
  `codex login [--device-auth] -c cli_auth_credentials_store="file"` with that `CODEX_HOME` (the
  `--device-auth` flag exists at the tag, U:cli/src/main.rs#L552), read the
  resulting `auth.json`, upload it with `enroll: true` (engine-agnostic store path,
  routes/auth/index.ts:1607-1621), then delete the directory. Never run `codex logout` (it revokes at the
  IdP, U:login/src/auth/revoke.rs#L55-L73 †). The live `~/.codex` is never touched. Mirrors
  `app/claude/accounts.go:249-271` (`enrollRoot`, `accountsAdd`).
- `cdx accounts use <id|label>` — `RequestSwitch` for this scope (accountpool/switch.go); applies live
  when the scope is capable, otherwise at the next launch (message says which).
- MCP `account_status` / `account_switch`: allow `codex` in the broker (agentportal/accounts.go:52-54),
  drop "Claude sessions only" (agentbus/mcp.go:576-577, gating :1036-1043), update the fleet Skill
  (managed-account-switch-skill.ts:5,44).

## 7. Q7 — Quota-limit failure signal (for quota-continue)

- Upstream: HTTP 429 `error.type == "usage_limit_reached"` → `CodexErr::UsageLimitReached{plan_type,
  resets_at, limit_window_minutes, rate_limits, rate_limit_reached_type}`; `usage_not_included` →
  `UsageNotIncluded`; `insufficient_quota` → `QuotaExceeded` (U:codex-api/src/api_bridge.rs#L229-L275 †).
  All map to `CodexErrorInfo::UsageLimitExceeded`; refresh failure → `Unauthorized`
  (U:protocol/src/error.rs#L601-L603,#L632, verified). Text: "You’ve hit your usage limit. … Try again
  at {ts}." with U+2019 (error.rs#L880-L987 †).
- App-server v2 delivers it structured: `error {error: TurnError{message, codexErrorInfo,
  additionalDetails}, willRetry, threadId, turnId}` and `turn/completed` with `status:"failed"` (†).
  `codex exec --json` only emits `turn.failed {error:{message}}` (U:exec/src/exec_events.rs#L11-L37 †).
- Proposal: set `quota_limit: true` on `watchdog/activity` **only** for `codexErrorInfo ==
  usageLimitExceeded` (exact JSON shape **[LAB]**), and for exec/worker turns on the text "hit your usage
  limit" (match both ’ and '). Keep `at capacity|overloaded|rate_limit` as `failure:"capacity"`
  without `quota_limit` — they are service capacity, not account exhaustion. Use the error's
  `resets_at` for `retry_not_before` when present.

## 8. Q8 — Feasibility verdict

| Option | Verdict |
|---|---|
| File rewrite, native adopts | impossible (verified, §2) |
| Reload RPC | none exists |
| External tokens in-process | possible, but internal-only API, moves refresh into the wrapper, no clean exit; rejected for now |
| **Supervised app-server restart at idle + TUI reconnect/resume** | **feasible for TTY+receiver sessions; recommended** |
| Per-turn relaunch (worker) | already works at the next turn |
| Everything else | next launch only; blocks live commits in its scope |

**Category (brief's axis): "switch at backend restart with auto-resume at a turn boundary" — not a
full in-process live switch.** It is the brief's "supervisor-driven resume of the same native session
on the new account at a turn boundary": the TUI process, its scrollback and the thread survive; the
model backend is replaced. Costs: MCP servers restart (including the receiver adapter, which reconnects to the broker
in the wrapper parent), background terminals are killed, and the TUI shows a brief reconnect.

---

## 9. Proposed design

### Server
- **S1 Capability per lease (three-valued).** Migration `0151_provider_session_live_switch.sql`
  (idempotent `ADD COLUMN live_switch TINYINT UNSIGNED NOT NULL DEFAULT 0` guarded by
  information_schema, per api/src/db/README.md) + `schema.ts`. `POST /auth/sessions` accepts
  `live_switch: "apply" | "transient"` and stores 2 / 1; absent (old wrappers) stays 0 = incapable.
  New helper `liveScope(engine, scopeLeases)` = Claude → true (unchanged); Codex → **at least one
  unexpired `apply` lease and no unexpired incapable lease** (transient exec/worker leases keep the scope
  live; the wrapper gate G2 waits for them). Add `'codex'` to `LIVE_SWITCH_ENGINES` and replace each
  gate listed in §1 (`requestSwitch`, `commitSwitch`, `evaluate`, `poolView`, `sessionExtras`,
  evaluate-on-unusable, policy worker) with `liveScope`. The reaper takes Codex leases only when they
  declare a capability (≥ 1): those come from a wrapper new enough to re-reserve after a refused
  attachment (the redial re-reserve landed in cxx 0.9.211, accountpool/context.go:374-380); older
  Codex leases keep expiring by TTL only.
- **S2 `enforceAccountSession`** (routes/auth/index.ts:2027-2042): for live Codex scopes, answer a
  mismatch like Claude (`presented_account_id` + bound head) instead of `400`.
- **S3 Identity** (provider-accounts.ts:262-310): run the Claude refusal/tombstone branch for Codex too
  (decision per open question 1; identity shape per open question 2).
- **S4 Usage**: post-commit due-now for both accounts; evaluate after Codex snapshot store (§4).
- **S5 `quota_limit`**: consume via the shared quota-continue code once it lands (§12).
- **S6 Copy**: `poolRecommendation(..., liveSwitch)` (account-policy.ts:342-401), pool view live flag
  per scope, Skill text.

### Wrapper
- **W1 accountpool (shared)**: marker field `Capability` (`apply` for a launch that owns a supervisor,
  `transient` for exec/worker turns, empty otherwise); `SiblingsCapable()` (no incapable live marker);
  send `live_switch` on acquire. markers.go:18-28,59-73; context.go Start payload.
- **W2 Restartable receiver server (Codex)**: turn `startReceiverServer` into a small type with
  `Stop()`/`Start()` on the same socket path, re-attaching `session`, `childLease`, `guard`; final
  cleanup (socket removal) only at session end. codex/receiver.go:51-137, codex/exec.go:300-308.
  Pass `-c features.cli_resume_account_check=false` to the app-server and to worker exec args
  (agentbus/worker.go:747-766) **[LAB: confirm the key is honoured via -c]**.
- **W3 Codex supervisor**: persona/codex/lifecycle/account_switch.go + account_switch_run.go, same
  constants and outcomes as Claude's (account_switch.go:31-52): poll 60 s, gate 5 s, retry 15 s,
  finish tries 20; heartbeat → directive (`observeBindingLocked`) → gates G1–G4 → flush → commit →
  stop → CAS write → start → verify → notice. Sibling adoption path ("restart only") and
  "whoever is left" finish path.
- **W4 Turn evidence**: a supervisor app-server connection (reuse the native_queue.go client) feeding
  `SetSessionTurn(idle, known)`; exec launches set busy for their lifetime.
- **W5 Writer**: `codex.WriteLiveSwitchIfCurrent(ctx, payload, digest, expected)` in
  codex/auth_writer.go: exact CAS beside an active child, ledger entry via
  `rememberCanonicalGenerationLocked`, upstream `auth.lock` held around read-compare-rename
  **[LAB: lock name/semantics at the pinned version]**. Only the supervisor calls it.
- **W6 Mismatch handling**: parse `presented_account_id` in the Codex `/auth` response; Codex
  `BoundAccountMismatch` in persona/codex/lifecycle/auth_sync.go mirroring
  persona/claude/lifecycle/session_auth.go:38-74,153-175 (in use ⇒ repair flag; idle ⇒ write).
- **W7 Failure classification**: native_queue.go:283-325 + receiver_failure.go:13-51 (§7).
- **W8 `cdx accounts list|add|use`**: app/codex/accounts.go (from app/claude/accounts.go).
- **W9 MCP tools** for Codex (§6).
- **W10 Card/status copy**: persona/codex/summary/summary.go:567 ("next launch" → "at the next idle"
  for live scopes).
- **W11** bump `VERSION` in wrappers/Makefile (0.9.211 → next).

### Docs
docs/interface-cdx.md (Multiple provider accounts: live switching section, capability, gates,
restart cost, `cdx accounts`, fix the 30 s heartbeat drift, remove "There is no `cdx accounts add`"),
docs/interface-api.md (§2504-2707: generalise live switching to Claude+Codex, `live_switch` lease
field, migration 0151, `presented_account_id` for Codex), docs/auth-resilience.md (switch write beside
an active child; refresh ownership unchanged), docs/OVERVIEW.md, CHANGELOG.md, dashboard copy
(frontend/src/lib/components/accounts/AccountPolicy.svelte:165, public/admin/manual/articles/accounts.md:31,49).

### Tests
- api/test: Codex scope live only when every lease is capable; directive/commit/replay for Codex;
  `enforceAccountSession` returns `presented_account_id` for live Codex scopes and still `400` for
  others; Codex tombstone/refusal; migration 0151 idempotent (run twice); due-now after commit;
  evaluate after snapshot.
- wrappers: marker capability + `SiblingsCapable`; gate matrix (own busy, sibling busy/unknown/
  incapable, exp < 30 min, resume check on); stop→write→start order and CAS-miss→repair with a fake
  `codex app-server` on a unix socket; `quota_limit` classification table (usageLimitExceeded vs
  capacity vs overloaded, ’ vs '); `cdx accounts add` with a fake `codex login`.
- Lab (two real ChatGPT accounts on a reserved lab VM): see §15.

## 10. Guarantee mapping

| Claude guarantee | Codex equivalent |
|---|---|
| identity refusal | S3: Claude branch extended to Codex (open question 1) |
| removed accounts | S3: `account_removed` tombstone for Codex identities |
| usage attribution via reporting lease | N/A for the server pull (per-account token); applies to optional phase-2 push |
| per-window merge | Codex snapshots are per window by duration already (provider-leases.ts:184-199); phase-2 push reuses the merge |
| repeatable commit | `commitSwitch` replay (account-switch.ts:567) reused unchanged |
| repair flag | W6 + W3 CAS-miss path set/clear `.cxx-account-<hash>.repair` |
| sibling turn markers | W1/W4: turn from app-server status + capability field; unknown never idle |
| lease reaping | Codex leases heartbeat (context.go:360-407); reap only capability-declaring leases (re-reserve after refusal, cxx ≥ 0.9.211) |

## 11. Ordered implementation plan

0. **Lab spike (go/no-go)**: L1, L2, L5, L7 from §15 with a hand-driven restart. Stop here if L1 fails.
1. Server identity hardening for Codex (S3) + tests — after open questions 1/2.
2. `quota_limit` classification (W7) — after quota-continue lands on main.
3. `cdx accounts list|add|use` + MCP tools (W8, W9); `use` applies at next launch until step 6.
4. Migration 0151 + capability plumbing (S1 server side, W1); server issues no Codex directives yet
   because no wrapper declares the capability.
5. Restartable receiver server (W2), writer (W5), mismatch handling (W6, S2).
6. Supervisor (W3, W4) declaring the capability; behind a fleet toggle, default off; lab; then on.
7. Usage due-now/evaluate (S4), copy (S6, W10), docs, CHANGELOG; VERSION bump (W11).
8. Deploy only on explicit instruction (scripts/deploy.sh).

Files: api/src/db/migrations/0151_provider_session_live_switch.sql, api/src/db/schema.ts,
api/src/services/account-switch.ts, api/src/services/account-policy.ts,
api/src/ops/account-policy-worker.ts, api/src/control-plane/streams/provider-leases.ts,
api/src/routes/auth/index.ts, api/src/services/provider-accounts.ts,
api/src/ops/provider-obligations.ts, api/src/services/managed-account-switch-skill.ts,
wrappers/cxx/internal/accountpool/{context,markers,switch}.go, wrappers/cxx/internal/codex/{receiver,exec,auth_writer}.go,
wrappers/cxx/internal/persona/codex/lifecycle/{account_switch,account_switch_run,auth_sync,run}.go,
wrappers/cxx/internal/persona/codex/orchestrator (auth response), wrappers/cxx/internal/agentbus/{native_queue,receiver_failure,mcp,worker}.go,
wrappers/cxx/internal/agentportal/accounts.go, wrappers/cxx/internal/app/codex/accounts.go (new),
wrappers/cxx/internal/persona/codex/summary/summary.go, wrappers/Makefile, docs/*, CHANGELOG.md,
frontend/src/lib/components/accounts/AccountPolicy.svelte, public/admin/manual/articles/accounts.md,
tests under api/test/ and next to each Go package.

## 12. Shared vs Codex-specific; quota-continue, lanes, effort

- **Shared/engine-agnostic** (reuse or generalise): scope rows/generation CAS/directive/commit/replay,
  `poolPosition`, policy worker, reaper, `accountpool` (lease, markers, repair flag, heartbeat),
  `presented_account_id`, `enroll: true`, MCP tool surface, `accounts` CLI shape, the capability field.
- **Codex-specific**: restart-based apply (W2/W3), app-server turn evidence (W4), the
  beside-active-child CAS writer (W5), access-token `exp` gate (G3), `cli_resume_account_check` pin,
  `codex login` enrolment, `usageLimitExceeded` classification, server-pulled usage freshness.
- **quota-continue compatibility**: Codex only adds a producer of `quota_limit:true`; the server marker
  and account-agnostic recovery stay the in-flight branch's. The Codex continuation must wait for the
  "switch applied" local notice (new backend up and thread resumed) before `thread/queue/add`/turn
  start; AED's usage-limit exclusion (native_queue.go:283-291) stays until quota-continue decides it.
- **Lanes**: ChatGPT lanes are Codex-only and reduced to `normal|null` (Spark retired 2026-09-29);
  a switch does not touch lane preference or `/host/lane`.
- **`model_reasoning_effort`**: lives in `config.toml`, which a switch never writes; the restarted
  app-server reads the same config, and TUI per-turn overrides are preserved by
  `PreserveExistingThread` **[LAB]**. Mixed-plan pools can lose model availability after a switch (R10).

## 13. Risks and mitigations

- **R1 Cross-account thread continuation** (`invalid_encrypted_content` "organization_id did not match",
  openai/codex#3942, #12934, #13724; OpenAI said on #3942 on 2026-03-13 a Responses deploy fixes it;
  #63519 on 2026-11-24 reports an A→B switch keeping the thread usable in the VS Code extension). Same
  exposure exists today when a thread is resumed after a next-launch move. Mitigation: lab L1 as the
  go/no-go; on that error class the supervisor reports it and the policy stops live switches for the
  scope.
- **R2 Upstream resume check**: `cli_resume_account_check` refuses resuming a thread created by another
  ChatGPT account/workspace for `codex-tui`/`codex_exec` ("This thread was created with a different
  ChatGPT account or workspace…", U:app-server/src/request_processors/thread_resume_account.rs#L1-L46);
  stage UnderDevelopment, default off (U:features/src/lib.rs#L113-L114,#L1166-L1171). If it ships on
  (or is rollout-forced), the restart path and the worker's `exec resume` break. Mitigation: pin it off
  via `-c`, capability gate G4, engine-maintenance audit checks it each Codex bump.
- **R3 Busy sibling outliving A's token**: G3 exp gate; restart on `unauthorized` failure.
- **R4 Rotated refresh-token loss** in a 401-recovery race on a sibling: rare; cooperative `auth.lock`;
  symptom `refresh_token_reused` on A → re-enrol with `cdx accounts add`.
- **R5 Restart cost** (background terminals, MCP state, reconnect banner, typed-but-unsent input):
  G1 descendant gate, policy dwell to limit frequency, open question 3 (hard-limit-only option).
- **R6 Upstream drift** in reconnect/app-server flags: version gate + engine-maintenance audit.
- **R7 TUI in `--remote` mode loads local auth** for the managed-config bundle loader at bootstrap
  (U:tui/src/lib.rs#L406-L414,#L1058-L1072); whether it refreshes or writes later is unknown → L7.
- **R8 Business-seat identity collision** → open question 2.
- **R9 Usage freshness** (≤ 15 min) → due-now after commit, `quota_limit` for hard limits.
- **R10 Mixed plans** (Plus/Pro/Business) → model availability; verify `model/list` after restart and
  surface a clear error; policy may prefer same-plan targets.
- **R11 `account/logout` revokes at the IdP**: the supervisor never calls it; a user `/logout` inside a
  TUI is an existing fleet-wide hazard, unchanged.
- **R12 Raw `codex` outside wrappers** is invisible to markers: residual; native-entry shims (cxx ≥0.9.24)
  route most launches through the wrapper.
- **R13 More refresh concurrency.** Cross-host refresh spends are already unserialised
  (docs/auth-resilience.md:114-119); switching moves more hosts onto the same account more often. If B
  arrives with an expired access token, every restarted backend in the scope (and other hosts bound to
  B) may refresh it at once and hit `refresh_token_reused`. Mitigation: the initiator's new backend
  refreshes once via `account/read {refreshToken:true}` (account_processor.rs#L1116-L1138) and the
  supervisor uploads the result before publishing the notice, so siblings restart onto a fresh file
  **[LAB]**; policy dwell limits flapping.

## 14. Older-wrapper compatibility

- Old Codex wrappers never send `live_switch`, so any scope containing one is not live: no directives,
  no `sessionExtras`, pool view says "next launch". Their heartbeats and leases keep working and are
  never reaped (only capability-declaring leases are, §9 S1); they expire by TTL as today.
- `enforceAccountSession` keeps returning `400` for non-live scopes, exactly as today.
- Old wrappers' MCP broker still refuses Codex account tools; new tools appear with the new wrapper.
- S3 identity tightening affects every Codex wrapper: an old wrapper syncing an unknown identity gets a
  refusal instead of auto-enrolment (its local file is kept). This is the behaviour change behind
  open question 1.
- Migration 0151 is additive with a default of 0; older API code ignores the column.

## 15. Lab checks required (not facts yet)

L1 cross-account resume and continuation of a thread with reasoning items, personal↔personal and
personal↔workspace; L2 TUI reconnect when the app-server is stopped and restarted on the same socket,
including input typed during the gap; L3 receiver adapter reconnects to the broker and an in-flight
delivery is redelivered; L4 a sibling on A after B is written: exact error text and that it does not
overwrite B; L5 `-c features.cli_resume_account_check=false` is honoured and no remote rollout
overrides it; L6 background-terminal detection heuristic; L7 the `--remote` TUI never writes
`auth.json`; L8 `usageLimitExceeded` JSON shape in `error`/`turn/completed`; L9 effort/model overrides
after `PreserveExistingThread`; L10 upstream `auth.lock` cooperation by the wrapper writer.

## 16. Open questions for the operator

1. Tighten Codex enrolment to Claude's rule (no auto-enrol of a new identity from a plain host sync;
   enrol via `cdx accounts add`, a secure host or the console)? It changes documented behaviour
   (interface-cdx.md:1757). Recommended: yes, since live switching moves running scopes onto pool
   accounts.
2. Do you pool several seats of the same ChatGPT Business/Team workspace? If yes, identity must include
   `chatgpt_user_id` (with the compatibility upgrade in §5); if no, keep `account_id`.
3. Is the restart cost acceptable for every policy move, or should Codex live switches fire only on a
   reached limit (`quota_limit`/hard ceiling) and soft rebalancing stay at the next launch?
4. Can a lab VM get two real ChatGPT accounts for the go/no-go spike (L1/L2)? Without it the feature
   cannot be verified.
