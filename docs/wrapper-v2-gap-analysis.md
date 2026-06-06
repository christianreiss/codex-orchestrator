# Wrapper v2 — Legacy Parity Gap Analysis

**Status (2026-05-19):** every gap surfaced below has been closed in the
all-in-one stub-removal pass tracked at `~/.claude/plans/create-a-plan-for-cosmic-kitten.md`.
Sections A–B are kept as the closing record (the "before" snapshot); the
ordered re-implementation plan in §C maps each row to the merged commit
that landed it. Sections D–E are unchanged.

Scope: compare the current **Go** `cdx` / `clx` binaries
(`wrappers/{cdx,clx}/...`, fd85763 and prior) against the **legacy bash + python**
wrappers that lived at `bin/cdx.d/`, `bin/clx.d/` up to commit `fe70ac3` (parent
of the cutover `e63a468`). Sources of truth used for the legacy side:

- `git show fe70ac3:docs/interface-cdx.md`
- `git show fe70ac3:docs/interface-clx.md`
- Sampled bash fragments under `bin/cdx.d/` (auth sync/validate, update, entry
  gates, status, usage extraction).

Reviewed v2 code:

- `wrappers/cdx/cmd/cdx/main.go` (392 LOC) — flag parser + dispatcher
- `wrappers/cdx/internal/lifecycle/run.go` (270 LOC) — boot pipeline
- `wrappers/cdx/internal/orchestrator/{auth,agents,config_retrieve,resource,skills,lane,usage,client}.go`
- `wrappers/cdx/internal/codex/{exec,env,preexec,doctor,version,lane,auth_writer}.go`
- `wrappers/cdx/internal/update/update.go`, `internal/cron/cron.go`,
  `internal/uninstall/uninstall.go`
- `wrappers/cdx/internal/ui/*.go`, `internal/summary/summary.go`
- `wrappers/clx/...` mirror

The v2 rewrite was deliberate scope-cutting (CDX-redo.md: "16k LOC of bash
becomes ~3k LOC of Go"), so most gaps below are **un-ported features**, not
regressions inside ported logic. The previous "feat(wrapper): port legacy UX
into v2 Go binaries" only closed the cosmetic gap (banner / quota / doctor /
footer rendering); the **behaviour underneath** is still missing in many areas.

---

## A. Already at parity (or close)

These pieces were ported well enough that no follow-up is required:

- CLI shape skeleton: `run`, `status`, `doctor`, `lane`, `profile`, `exec`,
  `auth-upload`, `--version`, `--update`, `--uninstall`, `--cron [install|remove|run]`,
  `--execute`, `--silent`, `--debug`, `--minimal`, `--skip-boot`, `-4`,
  `--allow-concurrent-sync` (cdx); subset for clx.
  `wrappers/cdx/cmd/cdx/main.go:181-241`.
- Run-lock (single-instance flock) with concurrent-mode fall-back into
  read-only sync. `wrappers/cdx/internal/ipc/lock.go`,
  `wrappers/cdx/internal/lifecycle/run.go:44-55`.
- Boot banner (neofetch-style CDX logo, info column, theme tint hooks),
  health-dot row, quota rows, exit footer.
  `wrappers/cdx/internal/ui/{banner,screen,health,quota,footer}.go`.
- Doctor with deps/paths/auth/config/MCP/API/latency/disk/cron/SSH/CLI rows.
  `wrappers/cdx/internal/codex/doctor.go`.
- Signed per-host JSON config + Ed25519 verification + schema validation.
  `wrappers/cdx/internal/config/{load,config}.go`.
- AGENTS.md / config.toml retrieve + atomic write with SHA256 If-None-Match.
  `wrappers/cdx/internal/lifecycle/run.go:166-225`.
- Project-trust autoadd, OTEL env export, IPv4-proxy startup hook.
  `wrappers/cdx/internal/codex/preexec.go`.
- Lane env mapping (`spark` → `gpt-5.3-codex-spark`, `normal` → `gpt-5.5`)
  through `applyLaneAndProfile`. `wrappers/cdx/internal/codex/lane.go`.
- Auth retrieve / store and self-update happy paths.

---

## B. Missing or regressed — by category

Severity rubric:

- **P0** = required for fleet correctness or for a previously-supported host
  to keep booting; ship before recommending v2 to non-bleeding-edge users.
- **P1** = visible feature/behaviour difference an operator will notice.
- **P2** = nice-to-have / polish.

### B1. Auth pipeline (P0 — most divergent area)

Legacy contract (`fe70ac3:docs/interface-cdx.md`) defines a rich set of
sequencing rules and statuses that v2 only partially implements.

| Behaviour | Legacy | v2 today | Gap |
|---|---|---|---|
| **Startup-bundle path** (`POST /sync/status` + `POST /sync/bootstrap` with `include_auth=true`) | First-class fast path; one round-trip carries auth + AGENTS + config | `SyncStatus` and `SyncBootstrap` *clients* exist but `lifecycle.Run` never calls them — it always does per-resource pulls | **P0**. Cold-boot is 3 round-trips instead of 1; bundle path is the documented happy path and the server contract is built around it (`/sync/bootstrap` even accepts `auth_candidate` for upload-on-renew). |
| **Local auth freshness windows** (`MAX_LOCAL_AUTH_AGE_SECONDS=24h`, `MAX_LOCAL_AUTH_RECENT_SECONDS=7d` on secure hosts) | Used for offline launch fallback | Not implemented — `syncAuth` either succeeds, errors, or returns whatever was on disk untouched | **P0**. v2 cannot boot during an orchestrator outage. |
| **Auth status decoding** | Handles `valid`, `outdated`, `updated`, `upload_required`, `missing`, `disabled`, `invalid`, `insecure`, `insecure-denied`, `concurrent` | `lifecycle.syncAuth` recognises only `valid|current|ok|unchanged|outdated|updated|missing|upload_required`; **`disabled`, `invalid`, `insecure`, `insecure-denied`, `concurrent` fall through to "unknown auth status"** and surface as a hard error. `wrappers/cdx/internal/lifecycle/run.go:143-163` | **P0**. A host the admin marked insecure or disabled silently fails to launch with a confusing "unknown status" error instead of the documented framed status box. |
| **Insecure-approval polling box** (5-second refresh of one framed terminal status, `last check` + `checks`) | Yes | Not implemented | **P1**. Operators currently hit `unknown status "insecure"` and have no in-terminal pathway. |
| **API kill-switch / `api_disabled` block** | Wrapper blocks launch if `versions.api_disabled` | Read into typed struct but never consulted by gating logic | **P0** — kill-switch is now non-functional from the wrapper side. |
| **Installation-ID mismatch detection** | Wrapper blocks sync if the server returns a deny reason mentioning installation ID | Not checked | **P0** — security regression (a swapped backend would be accepted). |
| **FQDN-mismatch guardrail** (`CODEX_ALLOW_FQDN_MISMATCH=1` override) | Wrapper enforces baked FQDN at runtime | Not implemented — there's no compare-to-runtime-FQDN check anywhere | **P1** — design intent of signed-config preserved by signature, but the run-time guard is missing. |
| **Auth-changed detection by sha256 hash** (post-run upload) | Uses both `last_refresh` *and* content sha to detect changes | No post-run auth upload at all; only the manual `cdx auth-upload` exists | **P0** — silent token rotations (where `last_refresh` stays the same) no longer reach the canonical store. |
| **`last_refresh` backfill for plain `codex login` files** | `cdx auth-upload` injects it before POSTing if missing | `cmdAuthUpload` just reads bytes and POSTs them | **P1**. |
| **DELETE-on-uninstall force flag** | `DELETE /auth?force=1` | Same call, but no longer purges per-user `~/.codex` directories for known fleet users, no `npm uninstall -g codex-cli`, no `/opt/codex` removal, no escalation guard for shared hosts | **P0** for fleet hosts; **P1** for single-tenant. `wrappers/cdx/internal/uninstall/uninstall.go:38-58`. |

### B2. Update / version-management (P0–P1)

| Behaviour | Legacy | v2 today | Gap |
|---|---|---|---|
| **Codex CLI update** (npm-global `codex-cli`, or GitHub release asset by `unknown-linux-musl` per-arch, SHA-pinned) | Yes | Wrapper self-update only — Codex CLI is **never** touched. `update.SelfUpdate` swaps the *wrapper* binary. There is no Codex installer code. | **P0**. The wrapper now relies on the operator to keep `codex` current; `client_version_enforce_exact` from the server is read but never enforced. |
| **`cdx --update` recovery semantics** (allow stale wrapper with only `curl` available; then go finish the Codex update) | Yes | Just self-update; never recurses into Codex update | **P0** — implied by above. |
| **Cron auto-update**: tick calls `/cron/check`, then on `wrapper.action=update` downloads, sha-verifies, swaps, re-execs `cdx --cron`, then triggers Codex update + `/cron/report` | Yes | `cron.Tick` pings `/sync/status` only — **does not call `/cron/check` or `/cron/report` at all**, never installs anything. `wrappers/cdx/internal/cron/cron.go:60-72` | **P0**. The whole cron-managed-update flow is a stub. |
| **Crontab line shape** (`cdx --cron run >> ~/.codex/cron.log 2>&1 # cdx-managed-cron`, with shell-escaping + `%` cron escaping, deterministic minute/hour from hostname CRC) | Yes | The CRC-derived minute/hour and marker are present, but uses `crontab -` which has no escaping of `%`, and the legacy fragment also handled `flock` non-blocking guard and the `cron/check` ping after `install` | **P1**. Minor escaping risk; missing first ping after install. |
| **Wrapper self-update restart loop guard** (`CODEX_WRAPPER_RESTARTED=1`, `CODEX_SKIP_MOTD=1`, exec with snapshotted argv) | Yes | `update.SelfUpdate` swaps the binary but **does not re-exec** — the caller falls through into `run` with the *old* in-memory code. No loop guard. | **P0** for the rare case where `--update` is invoked mid-run path; **P1** in the explicit `update` subcommand. |
| **Per-arch Linux musl asset selection** | Yes | N/a — Codex install isn't ported | **P0** — comes for free with the Codex-installer port. |
| **Prerequisite installer** (`ensure_commands curl unzip python3`, `ensure_optional_commands bwrap`, macOS Homebrew path) | Yes | Doctor reports presence, but nothing installs them | **P2** — by design we may not want a Go binary to drive package managers; doc this explicitly. |

### B3. Boot-time gating & messaging (P0 mostly)

The legacy `05-main-46-entry.sh` block is roughly 138 lines of decision logic
that maps every (`AUTH_PULL_STATUS`, local-auth-presence, quota state) pair to
either a launch or a refusal with a typed reason string. v2's `lifecycle.Run`
boils this down to:

```go
// Block launch if hard-fail quota.
if authResp != nil && authResp.QuotaHardFail && authResp.ChatGPT != nil { ... }
```

Missing decisions:

- **Offline launch with cached auth** (P0) — covered above in B1.
- **Insecure-host messaging** ("`Insecure host API disabled; enable the host
  window in the admin dashboard.`") — surfaced as a doc string but never
  printed; auth state `insecure` errors out instead. (P0)
- **Concurrent run + invalid local auth refusal** (P0) — concurrent path
  currently always proceeds with `read-only` if any auth was on disk, even
  when that auth is structurally invalid.
- **Lane-persist refusal during a concurrent run** without
  `--allow-concurrent-sync` (P1) — v2 `cmdLane` does not check the lock.
- **Quota-warn vs quota-block distinction**: v2 only blocks on `QuotaHardFail`;
  legacy also showed `QUOTA_WARNING` line ("ChatGPT quota near limit: ..."). v2's
  warn text exists in `summary.QuotaWarn` but is only ever printed inside the
  boot screen — never logged outside it.
- **Active cdx run early-exit** for status-only / doctor-only paths (skip the
  pre-run mutating ops). v2's `status` / `doctor` paths bypass `lifecycle.Run`
  entirely, so this is implicitly handled, but the legacy "Concurrent" compact
  summary row is partially wired (`ui.PrintConcurrentRow`) yet never populated
  because no caller sets `ConcurrentNote`.

### B4. Codex exec / launch behaviour (P0–P1)

| Behaviour | Legacy | v2 today | Gap |
|---|---|---|---|
| **Help passthrough**: `cdx --help`, `-h`, `help`, and Codex-subcommand help skip *all* wrapper work | Documented contract | v2 `parseFlags` does not recognise `--help` or `help` at all — both fall through as positional args, become "unknown subcommand", and exit 2. | **P0**. New operators running `cdx --help` get a confusing error. |
| **Direct TTY launch vs pipe-mode tee** | TTY → direct terminal, no PTY capture; pipe → `tee` for token extraction | `cmd.Stdin/Stdout/Stderr = os.Stdin/...` — single path, no pipe-mode capture path. Token-usage extraction is therefore impossible in pipe mode. | **P0** (combined with B5 below). |
| **`PROMPT_TOOLKIT_NO_CPR=1` auto-set** when stdin/stdout not a TTY | Yes | Not set | **P1**. |
| **SSH alt-screen handling** (`CODEX_SSH_ALT_SCREEN=1`) | Documented escape hatch | Not implemented | **P2**. Mostly a Codex-side concern now. |
| **Reserved-command list for profile shorthand** (`exec`, `review`, `login`, `logout`, `mcp`, ..., `help`) | Yes | `cmdProfile` just shoves args through; `cdx exec` is its own subcommand but `cdx login` / `cdx mcp` would currently be misinterpreted as profile names by **any** logic that emulates legacy `cdx <profile>` shorthand. v2 does not even *implement* the `cdx <name>` profile shorthand — only the explicit `cdx profile <name>` form. | **P1**. Operators with muscle memory will see different behaviour. |
| **`cdx ls` shorthand for `cdx lane spark`** | Yes | Not implemented | **P2**. |
| **`cdx lane` clear: prints + exits when no args** | Yes | `cmdLane` does print effective lane, but `clear` requires `--persist` (legacy allowed `clear` alone for read-back of "follow inherited"). | **P2**. |
| **`--execute` runs through the full lifecycle (auth/sync/update gates) before launching** | Yes | v2 sets `SkipBoot: true` and **skips auth+resource sync entirely** — `--execute` is a thin adapter onto `codex exec` only. `wrappers/cdx/cmd/cdx/main.go:131-144` | **P0**. Headless callers now skip the auth refresh. |

### B5. Usage reporting (P0)

| Behaviour | Legacy | v2 today | Gap |
|---|---|---|---|
| **Token-count extraction from `~/.codex/sessions/.../*.jsonl`** by mtime, scoped to run start | Yes (`extract_token_usage_payload` python) | **Not implemented**. `reportUsage` posts only `{engine, model, duration_seconds}` with zero token counts. `wrappers/cdx/internal/lifecycle/run.go:247-263` | **P0**. The whole `chatgpt_usage` chart now reports zero tokens for every Codex run; this is the orchestrator's primary usage data source. |
| **Pipe-mode tee + `Token usage:` line parsing + structured `token_count` and `turn.completed` event parsing** | Yes | n/a | Same. |
| **Best-effort budget** (~3s, retry with `line` stripped on retryable failures) | Yes | Single 5s timeout; no retry-with-strip | **P2**. |
| **`/usage` envelope** is `{usages: [entry]}` per legacy; v2 sends a single record at the top level | Spec mismatch | The server in this repo accepts both, but the documented contract says `usages` array | **P1** (documentation/spec drift). |

### B6. Skills / MCP / Memories sync (P1)

- Legacy: skills are read live via MCP `resource_read` on `skill://{slug}`; the
  wrapper deletes legacy `~/.agents/skills` and `~/.codex/skills` trees on
  upgrade so they don't shadow MCP.
- v2: `internal/orchestrator/skills.go` defines `ListSkills` /
  `RetrieveSkill`, but **nothing calls them**, and there is no clean-up of
  legacy skill dirs.
- `lifecycle.Run`'s `summary.Inputs.SkillsUpdated` is therefore always `false`,
  so the "skills" health dot can never light up as updated.
- **P1**: documented behaviour says MCP-first, so this is mostly fine — but the
  upgrade-time cleanup pass should be ported.

### B7. Config sync coverage (P1)

The orchestrator already sends back a normalised TOML that includes:

- Per-host model + reasoning-effort baking
- Managed `[mcp_servers.cdx]` block
- Per-user `[projects."<home>"]` trust stanza (server uses `home`/`username`
  hints from the request)
- Removed-model upgrade migration (e.g. `gpt-5.3-codex` → `gpt-5.5`)

v2 sends *only* `{engine: "codex", sha256: ...}` — no `home` / `username` hints
(`wrappers/cdx/internal/orchestrator/config_retrieve.go:15-25`), so the server
cannot bake the per-user trust stanza. Result: trust prompts may reappear for
operators whose `pwd` doesn't match the cwd already trusted by
`EnsureProjectTrust`. **P1**.

### B8. clx-specific gaps (P0–P1)

Most of A–B7 apply equally to clx. Engine-specific gaps:

- **No `--continue` / `--resume <session>`** subcommand wired (documented in
  legacy `interface-clx.md`). **P1**.
- **`~/.claude/settings.json` is written but `~/.clx/config/settings.json` is
  not mirrored** as the legacy doc requires. `wrappers/clx/internal/lifecycle/run.go:190-202`.
  **P1**.
- **Auth dual-location precedence** (`~/.clx/auth/credentials.json` first, then
  `~/.claude/.credentials.json`): v2 only reads/writes
  `~/.claude/.credentials.json`. `wrappers/clx/internal/claude/auth_writer.go:14-20`.
  **P1**.
- **`CLAUDE_MD` env export** for `CLAUDE.md` path: not set.
  `wrappers/clx/internal/claude/env.go`. **P1**.
- **Skills sync filtered by `?engine=claude`**: not implemented (no skills
  call at all). **P2**.
- **`npm install -g @anthropic-ai/claude-code` (with sudo fallback)** on
  `clx --update`: not implemented (only wrapper self-update happens).
  **P0** — same shape of regression as Codex CLI update.
- **`clx --uninstall` removing the Claude CLI + per-user `~/.clx`** :
  unmodified from the cdx uninstall code path, so it deletes Codex files
  instead. **P0** (bug).

### B9. Documentation drift (P1)

`docs/interface-cdx.md` and `docs/interface-clx.md` were rewritten at cutover
(commit `e63a468`) and now describe the v2 surface, but **claim several
behaviours that are not in v2 code**:

- "Refusal modes" list does not include the legacy insecure-approval polling
  box, so operators reading docs expect "Just run again" — but the wrapper
  errors instead (B1).
- "Startup sequence" step 3 ("Auth sync (`POST /auth`) — best-effort; failure
  does not block.") — actually, an unknown status *does* block (B1).
- "`--update` Self-update now (verifies SHA256 before swapping)" — true for
  wrapper, but the doc does not mention that Codex CLI update is *not* run,
  which is the legacy contract.

Update these in lock-step with the code changes (per AGENTS.md guideline:
"When AGENTS/cdx/clx behavior changes, also update `docs/interface-*.md`...").

---

## C. Re-implementation plan (ordered)

Order is by "what unblocks the most other work" + severity. Each phase is a
single PR; nothing here is bigger than ~500 LOC of Go + a focused test.

### Phase 1 — Auth + gating correctness (P0)

Goal: every legacy `AUTH_PULL_STATUS` reaches the right launch decision, and a
fleet host stays bootable during outages.

1. Extend `lifecycle.syncAuth` to recognise the full status set:
   `disabled`, `invalid`, `insecure`, `insecure-denied`, `concurrent`.
   Return a typed `AuthDecision{Allowed bool, Reason string, NeedsPolling bool}`
   instead of `(resp, err, synced)`.
   Files: `wrappers/cdx/internal/lifecycle/run.go`,
   new `wrappers/cdx/internal/orchestrator/auth_decide.go`.
2. Add local-auth freshness check (`24h`, `7d` on secure hosts) — write
   `internal/codex/freshness.go` with `IsFresh(authPath, window time.Duration)`.
   Use it in the offline branch of step 1.
3. Wire the insecure-approval polling loop. Build a small `ui.ApprovalBox` that
   re-renders in place every 5s (use `ansi.go`'s cursor helpers). Bail on
   ctx.Done or status flip.
4. Honour `versions.api_disabled` and any `installation_id_mismatch` deny
   reason as a hard refuse in the decision struct.
5. Add the runtime FQDN guard (`os.Hostname()` vs `cfg.Host.FQDN`, with
   `CODEX_ALLOW_FQDN_MISMATCH=1` override).
6. Post-run auth upload: in `lifecycle.Run` defer-block, sha-hash
   `~/.codex/auth.json` before+after the Codex exec; if either `last_refresh`
   *or* the sha changed, call `client.AuthStore` (best-effort, 5s).
7. Mirror points 1–6 into `wrappers/clx/internal/lifecycle/run.go`.

Tests: extend `lifecycle_test.go` (which doesn't exist yet — add one). Each
status string maps to an expected decision.

### Phase 2 — Update pipeline parity (P0)

8. Build `wrappers/cdx/internal/codex/installer.go` with:
   - `EnsureCodexAtVersion(ctx, target, enforceExact bool)` that picks between
     npm-global update vs GitHub release-asset path (Linux uses
     `*-unknown-linux-musl`).
   - SHA-256 verification against the GitHub release `digest` field.
   - macOS Homebrew path (`brew upgrade codex` if installed via brew).
9. Hook it into `lifecycle.Run` *after* auth sync, before the boot screen,
   gated by `auth.Versions.ClientVersion` + `ClientVersionEnforceExact`.
   Skip when `auto_update_enabled=false` for non-cron paths.
10. Replace `cron.Tick` stub:
    - POST `/cron/check`, parse `{wrapper.action, wrapper.checksum, ...}`.
    - On `wrapper.action == "update"`: download `/wrapper/v2/download`, verify
      SHA, `os.Rename` over self, then `syscall.Exec` `--cron` again with
      `CODEX_WRAPPER_RESTARTED=1`.
    - Then run the Codex installer from step 8 if `client_version` differs.
    - POST `/cron/report` with post-update versions; retry once, exit non-zero
      on persistent failure (legacy contract).
11. Add restart-loop guard env var read at the top of `main.go` and a
    `CODEX_WRAPPER_RESTART_DEPTH` integer increment.
12. Cron `Install` post-write: send one `/cron/check` ping so the server
    records an initial check-in.
13. Shell-escape the wrapper path + log path in the crontab line; escape `%`.
14. Apply Phase 2 equivalently to clx with npm-only install path.

### Phase 3 — Lifecycle behaviour gaps (P0)

15. Help passthrough: in `main.go`'s arg parser, if the first non-flag token is
    `help`/`--help`/`-h`, or if a reserved Codex subcommand is followed by
    `--help`/`-h`, `syscall.Exec` straight to the upstream binary and skip
    every other code path.
16. `--execute` should call `lifecycle.Run` with `SkipBoot: true` but **NOT**
    `SkipAuthSync: true`. Drop that misconfiguration in `cmd/cdx/main.go:131-144`
    (same for clx).
17. Concurrent-mode summary: have `lifecycle.Run` set
    `summary.Inputs.Concurrent` *and* `summary.Inputs.ConcurrentNote` from the
    auth decision, so `ui.PrintConcurrentRow` actually receives text.
18. Bundle path: in `lifecycle.Run`, prefer
    `client.SyncBootstrap(ctx, withAuthCandidate=true)`; fall back to the
    current per-resource pulls only on 404/501 (legacy contract).
    The bundle response shape needs to be typed
    (`internal/orchestrator/bundle.go`).
19. `config_retrieve`: include `home` + `username` in the POST body so the
    server bakes the per-user trust stanza.
20. Set `PROMPT_TOOLKIT_NO_CPR=1` in `codex.BuildEnv` when stdin or stdout is
    not a TTY.

### Phase 4 — Usage reporting (P0)

21. Implement `wrappers/cdx/internal/codex/usage.go`:
    - `Discover(sessionsDir, since time.Time) []string` — JSONL files modified
      after `since`.
    - `Parse(path) UsageRecord` — handles both `Token usage:` lines from
      stdout tee and structured `{type:"token_count"|"turn.completed"}` events.
22. Pipe-mode capture: when stdout is not a TTY, wrap the Codex stdout with a
    `tee` (`io.MultiWriter(os.Stdout, &captureBuf)`); after exit, parse
    captureBuf for `Token usage:` and `session id:` first, then fall back to
    JSONL discovery.
23. Update `lifecycle.reportUsage` to populate `UsageRecord` token fields and
    submit as `{engine, fqdn, usages: [...]}` per the legacy contract; the
    server already accepts both shapes but the contract is the array.
24. Mirror into clx (Claude session JSONL lives under `~/.claude/sessions/`;
    different parser needed).

### Phase 5 — Uninstall + clx-specific bugs (P0–P1)

25. Re-implement `uninstall.Run`:
    - Call `POST /host/users` first to learn known fleet users.
    - Refuse if other users exist and we can neither `root` nor `sudo -n`
      (legacy safety stop).
    - For each user, remove `~/.codex` / `~/.clx` / `~/.claude` and the
      relevant per-engine env files (`/usr/local/etc/codex-sync.env`,
      `/etc/codex-sync.env`, `~/.codex/sync.env`).
    - `npm uninstall -g codex-cli` / `@anthropic-ai/claude-code` if installed
      that way; remove `/opt/codex`; remove cron entry (call `cron.Remove`).
26. Fix clx-side regressions:
    - Mirror `settings.json` to both `~/.clx/config/settings.json` and
      `~/.claude/settings.json`.
    - `claude.AuthPath` should try `~/.clx/auth/credentials.json` first.
    - Add `--continue` and `--resume <session>` passthrough flags.
    - Set `CLAUDE_MD` env to the synced `~/.claude/CLAUDE.md` path.
27. Fork uninstall for clx — engine-aware target list.

### Phase 6 — Skills / MCP cleanup (P1)

28. On every run, prune legacy `~/.agents/skills/`, `~/.codex/skills/`,
    `~/.codex/prompts/` directories (one-shot per binary version; persist a
    sentinel under `~/.cache/codex-orchestrator/cleanup-v<wrapper_version>`).

### Phase 7 — UX polish + reserved-name shorthand (P1–P2)

29. `cdx ls` → `cdx lane spark` shorthand.
30. `cdx <profile>` shorthand: in `main.go` if the first positional is *not* in
    the reserved Codex name list and `[profiles.<name>]` exists in the synced
    `config.toml`, dispatch as `cdx profile <name>`.
31. Quota-warn text should also be emitted as `log_warn` outside the boot
    screen so non-interactive callers see it.
32. Approval-pending box, summary "Concurrent" compact row, weekly quota ETA
    in the parenthetical (the math exists in `summary.buildQuota`; thread it
    through `ui.PrintQuotaRow`'s `Note` field).

### Phase 8 — Docs (rolling, ride with each phase)

33. Update `docs/interface-cdx.md` / `docs/interface-clx.md` at the end of
    each phase so the contract files match the binary.
34. Update `docs/wrapper-v2-architecture.md` to note the live behaviours.

---

## D. What is intentionally *not* coming back

Items the legacy wrapper had that the v2 architecture explicitly drops or
delegates to the server:

- The 51-fragment bash bakery (replaced by signed JSON config + ConfigBaker).
- Per-host strtr placeholder substitution at download time (replaced by
  `wrappers/v2/cache/`).
- Custom prompt-sync system (deleted at commit `9f27c05`, no longer in spec).
- SSH PTY bridge (`3970613`/`66f796d` — replaced by direct terminal launch).
- Cost tracking & reporting (`3df88fa`).
- Removed Codex model fall-back migration logic (`42a6a49`) — server now
  handles it during config baking, wrapper doesn't need to know.

Anything else from the legacy interface-cdx.md / interface-clx.md docs that
is *not* in section B above is either already at parity (section A) or out of
scope for v2.

---

## D2. Status (2026-05-19) — all rows DONE

| Phase | Status | Landed in |
|---|---|---|
| Phase 1 — Auth correctness, freshness windows, bundle path, post-run upload | DONE | PR-1 (`0d8d4971`, `1dd0ce3a`, `cdb1a879`) |
| Phase 2 — Codex/Claude installers, full cron pipeline, restart-loop guard | DONE | PR-2 (`bf394f2f`, `f6f90f82`, `c8a3b63d`, `35799db6`, `ebf3f041`, `05c777c5`, `6da31d16`) |
| Phase 3 — Help passthrough, `--execute` audit, concurrent-note, bundle path, `home`+`username`, `PROMPT_TOOLKIT_NO_CPR` | DONE | PR-4 (`c3830b25`, …) + this commit (concurrent-note, quota-warn) |
| Phase 4 — Token usage extraction + pipe-mode tee + array `/usage` shape | DONE | PR-3 (`b5b96fda`, `cf5b8504`, `bbd20fb9`, `12551681`, `dc9883fa`) |
| Phase 5 — Engine-aware uninstall with multi-user safety, clx settings mirror, CLAUDE_MD env, `--continue`/`--resume` | DONE | PR-4 (`12c41565`, `945543a9`, `108032c5`, `62d2f213`) |
| Phase 6 — Skills probe + legacy skill-dir prune | DONE | this commit (`wrappers/{cdx,clx}/internal/lifecycle/skills.go`) |
| Phase 7 — `cdx ls`, `cdx <profile>` shorthand, `last_refresh` backfill on `auth-upload` | DONE | this commit (`wrappers/cdx/internal/codex/profile.go`, backfill in `auth_writer.go`) |
| Phase 8 — Docs refresh in lock-step | DONE | this commit (`docs/interface-cdx.md`, `docs/interface-clx.md`) |

## E. Suggested first PR

Smallest-coherent slice that closes the biggest correctness gap:

- Phase 1, steps 1, 2, 4, 6 (status decoding + freshness windows + api_disabled
  + post-run auth upload).
- Phase 3 step 15 (help passthrough).
- Phase 4 steps 21–23 (usage reporting actually populates token counts).

Together that's ~600 LOC, gives a fleet operator the offline-resilience and
zero-token-loss they had under bash, and fixes the most embarrassing UX bug
(`cdx --help` exits 2). The Codex/Claude *installer* (Phase 2) is the larger
follow-up but isn't urgent if every host on v2 was installed at the
correct Codex version to begin with.
