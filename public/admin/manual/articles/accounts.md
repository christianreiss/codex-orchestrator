---
title: Provider accounts
section: Fleet operations
verified: 2026-09-30
sources: api/src/routes/admin/accounts/index.ts, api/src/routes/auth/index.ts, api/src/services/provider-accounts.ts, api/src/services/account-selection.ts, api/src/services/pooled-auth-store.ts, wrappers/cxx/internal/accountpool/context.go, frontend/src/routes/accounts/+page.svelte
---

Grok Build is supported as the third engine (`cgx`); see [Grok Build](cgx) for
subscription login, centralized renewal, native receiver, and gateway details.

Open **Fleet → Accounts** to manage the ChatGPT and Claude credentials shared by your fleet. Each engine has its own pool: three Claude subscriptions work with clx even when there are no ChatGPT accounts. cdx requires its own ChatGPT or OpenAI credentials.

## Add and maintain accounts

Choose **ChatGPT** or **Claude**, then **Add account**. Give it an optional name and upload native credentials through the same panel used during setup and host seeding. A live runner verification must succeed before credentials can be assigned. The command tab issues a one-time seed command; uploading directly lets you name the account immediately.

An account is a subscription, not a login session. Client uploads with a known distinct provider identity can enroll another account automatically. Fresh opaque OAuth tokens reuse the sole account or the account assigned to that session/host; access/refresh lineage also matches known credentials. With multiple accounts and no assignment, an opaque upload needs **Replace credentials** on the intended account. Use **Add account** (upload or untargeted seed command) to explicitly enroll an additional opaque account.

**Rename** changes the operator label. **Verify** performs a live probe. **Pause** excludes the account from new session scopes while allowing active sessions and refreshes to finish; **Resume** makes verified credentials eligible again. **Remove** immediately stops new assignments and waits for active reservations to drain or expire, then clears the stored encrypted credential bodies and auth entries. A retired identity tombstone prevents old known credentials from silently enrolling again. Re-adding a retired identity requires an explicit administrative recovery in the database; the normal Add form does not undo retirement.

## Usage and assignments

Every account shows separate short and weekly utilization, reset times, observation freshness, verification state, and active hosts. Unknown quota remains unknown; stale readings are labeled and retained conservatively until their reset. The dashboard also shows each account separately. Percentages from different subscriptions are never added together.

At a new native CLI launch, cxx chooses a verified enabled account with lower quota utilization. Accounts within five percentage points share work by active reservation count, then least recent assignment. An idle account without usable quota observations receives a bounded trial so native usage can become known. Existing hard-fail, warning and VIP controls still apply when all known accounts are exhausted.

The selected account stays fixed for that session. Overlapping invocations sharing one native auth directory use the same account; balancing happens after that scope is idle. Heartbeats extend five-minute reservations, and normal exits release them. A crashed wrapper's reservation expires automatically. Routine sync and maintenance preserve the current account rather than rebalance. There is no manual host pinning and no cross-engine fallback.

Claude usage reports carry the account and session inherited from their native process, so a delayed report cannot be attributed to the next selected account. ChatGPT usage refreshes run separately for each enabled account. Historical unassigned readings remain separate from the pool.

## Permissions and rollout

Viewing account metadata requires `auth.metadata.read`; adding, renaming, verifying, pausing, replacing or removing requires `auth.manage`. The metadata list and management responses never return credential bytes. Existing host-key/IP policy, insecure distribution windows and API kill switch remain in force.

Migration `0035_provider_accounts.sql` preserves each previous canonical head as its first engine account. cxx 0.9.7 supports launch reservations and account-scoped sync. Older wrappers continue using the stable compatibility head and do not balance accounts. Update wrappers to use the full pool.

## Source references

- api/src/services/provider-accounts.ts
- api/src/services/account-selection.ts
- api/src/routes/admin/accounts/index.ts
- api/src/routes/auth/index.ts
- wrappers/cxx/internal/accountpool/context.go
- frontend/src/routes/accounts/+page.svelte
