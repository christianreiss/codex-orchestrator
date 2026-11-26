---
title: Provider accounts
section: Fleet operations
verified: 2026-11-26
sources: api/src/routes/admin/accounts/index.ts, api/src/routes/auth/index.ts, api/src/services/provider-accounts.ts, api/src/services/account-selection.ts, api/src/services/pooled-auth-store.ts, wrappers/cxx/internal/accountpool/context.go, frontend/src/routes/(providers)/accounts/+page.svelte, frontend/src/lib/components/accounts/AccountPolicy.svelte, frontend/src/lib/components/accounts/AccountScopes.svelte
---

Grok Build (`cgx`) is supported alongside Codex, Claude and Kimi Code; see [Grok Build](cgx) for
subscription login, centralized renewal, native receiver, and gateway details.

Open **Providers → Accounts** (`/accounts`) to manage the provider credentials shared by your fleet. Each engine has its own pool: three Claude subscriptions work with clx even when there are no Codex accounts. cdx requires its own ChatGPT or OpenAI credentials. The engine appears under each account's name (there is no separate Engine column), with its plan, and a session links to the host by name. Below 640 px each account is a stacked card instead of a table.

## Add and maintain accounts

Choose **Codex** or **Claude** (or another engine that is switched on), then **Add account**. Give it an optional name and upload native credentials through the same panel used during setup and host seeding. A live runner verification must succeed before credentials can be assigned. The command tab issues a one-time seed command; uploading directly lets you name the account immediately.

An account is a subscription, not a login session. Client uploads with a known distinct provider identity can enroll another account automatically. Fresh opaque OAuth tokens reuse the sole account or the account assigned to that session/host; access/refresh lineage also matches known credentials. With multiple accounts and no assignment, an opaque upload needs **Replace credentials** on the intended account. Use **Add account** (upload or untargeted seed command) to explicitly enroll an additional opaque account.

**Rename** changes the operator label. **Verify** performs a live probe. **Pause** excludes the account from new session scopes while allowing active sessions and refreshes to finish; **Resume** makes verified credentials eligible again. **Remove** immediately stops new assignments and waits for active reservations to drain or expire, then clears the stored encrypted credential bodies and auth entries. A retired identity tombstone prevents old known credentials from silently enrolling again. Re-adding a retired identity requires an explicit administrative recovery in the database; the normal Add form does not undo retirement.

## Usage and assignments

Every account shows separate short and weekly utilization, reset times, observation freshness, verification state, and active hosts. Unknown quota remains unknown; stale readings are labeled and retained conservatively until their reset. The Overview's Provider usage table also shows each account separately. Percentages from different subscriptions are never added together.

At a new native CLI launch, cxx chooses a verified enabled account with lower quota utilization. Accounts within the policy band (Balanced) share work by active reservation count, then least recent assignment. An idle account without usable quota observations receives a bounded trial so native usage can become known. Existing hard-fail, warning and VIP controls still apply when all known accounts are exhausted.

Without a switch request the selected account stays fixed for that session (see Distribution policy below for live switching in Claude). Overlapping invocations sharing one native auth directory use the same account; balancing happens after that scope is idle. Heartbeats extend five-minute reservations, and normal exits release them. A crashed wrapper's reservation expires automatically. Routine sync and maintenance preserve the current account rather than rebalance. There is no manual host pinning and no cross-engine fallback.

Claude usage reports carry the account and session inherited from their native process, so a delayed report cannot be attributed to the next selected account. ChatGPT usage refreshes run separately for each enabled account. Historical unassigned readings remain separate from the pool.

## Distribution policy and live switching

The **distribution policy** card sits under the account list and follows the engine filter (with **All** it shows Claude). It decides which account new sessions use and when running sessions move. Changes need **Save policy**; nothing applies before it, and a background refresh does not overwrite unsaved edits.

- **Mode.** **Automatic** (default): the server picks the account and requests switches. **Manual**: no automatic switches; new sessions still start on the account with the most headroom, and moving a running scope is an explicit action.
- **Strategy** (automatic only). **Balanced** raises the accounts together: a running scope only moves when its account is further ahead of the least-used account than the band, **Tight** 10, **Normal** 20 (default) or **Loose** 30 percentage points. **Exhaust** uses account 1 up to the **soft limit** (default 90 %), then the next one; only when every account is past the soft limit does work continue up to the **hard limit** (default 99 %). **Expiring first** uses the same two limits, but takes the accounts in the order of their weekly resets: the one that resets soonest first, a freshly reset one last. The hard limit cannot be below the soft limit.
- **Minimum dwell** (minutes, 0 to 240, default 15): after a switch the scope stays on its account at least this long, which protects against flapping and repeated prompt-cache rebuilds.

**When to pick Expiring first.** Weekly quota that is still unused at its reset is lost, while quota in a window that has just started keeps for days. With accounts that reset on different days (say Wednesday, Thursday and Sunday), Balanced and Exhaust can spend the Sunday account while Wednesday's remainder expires. Expiring first spends Wednesday's quota, then Thursday's, then Sunday's.

- An account whose 5-hour window is full is skipped until that window resets, then used again.
- An account without a known weekly reset (no reading yet, or a reading from before its last reset) is never treated as expiring; it comes after the dated accounts. Unlimited accounts come last for the same reason.
- A running Claude scope only moves to an earlier-resetting account after the minimum dwell, when that reset is at least an hour earlier and at least 30 minutes away, and the account has at least 5 points of room. It concentrates work on one account at a time, so expect more switches than with Balanced.

Usage per account is the higher of its short and weekly window. Live switching of running sessions currently works only for Claude; for Codex, Grok and Kimi Code the policy decides which account a new launch picks.

**Active Claude scopes** lists every host and user with a live Claude session: the host, the bound account, the number of sessions and a pending switch with its target. Sessions of one user on one host share a single credential file, so they always run on the same account and a switch moves them all. **Switch to…** offers the enabled, verified Claude accounts; the switch applies at the next turn boundary (never during a turn), with a prompt-cache rebuild per session. Agents can ask for the same through the account-switch skill; in automatic mode the minimum dwell still applies.

Account rows show the provider login e-mail when it is known. **Identity unknown** means no provider identity is recorded yet, so a later login cannot be matched to that account automatically; use **Replace credentials** or log in again.

## Permissions and rollout

Viewing account metadata requires `auth.metadata.read`; adding, renaming, verifying, pausing, replacing or removing requires `auth.manage`. The metadata list and management responses never return credential bytes. Existing host-key/IP policy, insecure distribution windows and API kill switch remain in force.

Migration `0035_provider_accounts.sql` preserves each previous canonical head as its first engine account. cxx 0.9.7 supports launch reservations and account-scoped sync. Older wrappers continue using the stable compatibility head and do not balance accounts. Update wrappers to use the full pool.

## Source references

- api/src/services/provider-accounts.ts
- api/src/services/account-selection.ts
- api/src/routes/admin/accounts/index.ts
- api/src/routes/auth/index.ts
- wrappers/cxx/internal/accountpool/context.go
- frontend/src/routes/(providers)/accounts/+page.svelte
- frontend/src/lib/components/accounts/AccountPolicy.svelte
- frontend/src/lib/components/accounts/AccountScopes.svelte

## Quota warnings, reset recovery and PayG

Open an account's **Quota policy** action to override its engine defaults. Set short- and long-window warning percentages independently, or disable a window's warning. **Resume interrupted work after reset** is separate for each window; short-window recovery defaults on and long-window recovery defaults off. The settings apply to the bound provider account, across its managed sessions.

Enable **PayG / unlimited** for an account whose provider billing permits continued use. This disables quota warnings, quota startup blocks and quota-triggered recovery. It does not enable billing at the provider. Use **Use engine defaults** to remove the complete account override. Engine defaults are edited under Providers → Usage limits.

Agents call **quota_get** before heavy work or large delegations. It returns available short/long readings, reset times, observation age and the effective policy. Missing readings are unknown; a displayed zero is an actual reading. Claude measurements come from its native statusline, so a paused client may have stale data.

A warning asks for a checkpoint and does not force a pause. Confirmed quota interruptions can resume the original native session after reset on persistent hosts. The Watchdog panel shows the window, next wake, attempts and any failure. Manual stop, task completion, changed identity or a missing transcript prevents further recovery. No replacement session or independent replacement subagent is started.


## Emulated short quotas

Open **Providers → Usage limits → Quota warnings and resume** and select an engine.
Enable **Emulated short quota** when you want a local budget for accounts whose
provider reports a weekly allowance without a native short window. Both emulation
and **Server resume after reset** start off. Choose 5h (2.98% of weekly allowance)
or 8h (4.76%), counted across all hosts sharing the account. The first observed
consumption starts the fixed window. Unused allowance expires; duration edits apply
to the next window. Provider sampling and rounding make this an estimate.

**Warn only — suggest pause** recommends waiting until reset. **Warn only — suggest
ignore** recommends continuing. **Hard stop** prevents new managed starts and
follow-up tasks at 100%, including VIP hosts; the current turn can finish. Existing
short-window warning thresholds apply. Real provider limits remain in force.
Native short windows take precedence, PayG/unlimited bypasses emulation, and
missing/stale weekly data allows work with an explicit unavailable/stale indication.

When enabled, server resume offers only follow-up work held by this hard stop after
reset, in the original native session through an available managed receiver or
resident relay. Stopped/canceled/expired work and missing transcripts are not
replaced. With automatic resume off, open **Messages → Delivery log** and choose
**Retry held work**, or cancel its conversation. A retry checks the current budget;
it does not bypass an exhausted limit. Turning emulation off releases new starts
and stops automatic release of earlier holds, which remain available for an explicit
retry. Accounts and Overview identify local meters as **Emulated**.

## Kimi Code

Kimi Code accounts use a dedicated `ckx login` device login. The server owns renewal; hosts receive access-only credentials. Accounts shows 5-hour, optional weekly, monthly total and monthly code readings, with unknown windows left absent. See [Kimi Code (ckx)](ckx) for login, quota and receiver details.
