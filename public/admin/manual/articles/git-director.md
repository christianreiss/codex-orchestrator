---
title: Git Director
section: Admin workspace
summary: Fleet commit preferences, clone and worktree registry, merge leases and verdicts, the judge, and operator overrides.
tags: [git, merge, worktree, coordination]
verified: 2026-10-17
sources: api/src/services/git-commit-settings.ts, api/src/services/managed-agents-features.ts, frontend/src/lib/components/settings/GitCommitSettingsSection.svelte, api/src/routes/admin/git-director/index.ts, api/src/services/git-director.ts, api/src/services/git-director-judge.ts, api/src/services/git-director-tool-names.ts, api/src/services/mcp-tools.ts, api/src/security/capabilities.ts, api/src/security/route-capabilities.ts, api/src/env.ts, frontend/src/routes/(coordination)/git-director/+page.svelte, frontend/src/lib/components/git-director/GitDetail.svelte, frontend/src/lib/api/gitDirector.ts
---

Several agents work this fleet's repositories at once, often in separate worktrees of one checkout. The **Git Director** (called **Git merges** in the console; `/git-director`, in the *Coordination* group) is how they see each other: a registry of who is working in which clone, and an arbiter for merges into shared branches. It never touches a worktree — every agent runs its own git commands and reports what it did. The console page is where an operator watches the registry, forces a verdict, or releases a worktree an agent abandoned.

## Page layout

The page header carries the **Enable git merges** switch (Director activation) and **Refresh**. A strip of counts shows open merge requests, active worktrees and clones. A view switch selects **Merge requests**, **Worktrees** or **History**; search by repository, host, user, task or branch; select a row for full details in the side panel. Release and verdict overrides live in the relevant detail panel. Views support direct links through `?view=merges|worktrees|history` (older `?tab=` links still resolve). The panel fills the screen on mobile. The **Settings** section at the bottom of the page holds the commit preferences, with a single preview selectable by engine. Changes save immediately; extended explanations are under **Details**.

## Commit messages

The **Commit messages** card applies one shared preference to Codex, Claude and Grok, even when the Git Director or Skills are disabled:

- **Short** (default): one precise subject line, without an explanatory body.
- **Long**: a subject, blank line, then what changed and why, with relevant verification results. Unperformed checks must never be presented as passed.
- **AI Attribution** (default off): when enabled, append one `AI-Assisted-By: Codex`, `AI-Assisted-By: Claude` or `AI-Assisted-By: Grok` trailer after a blank line. This is also allowed with short messages. When off, add no automatic AI trailers, AI co-authors or Generated-by markers. Git author and committer identities remain unchanged.

Changes save immediately, with engine previews, save/error feedback and updates across open tabs. Reads require `git_director.read`; saves require `git_director.manage` and record the operator in the admin audit. Hosts receive the rules through managed AGENTS.md / CLAUDE.md at their next wrapper content sync or launch. Existing sessions may keep their earlier instructions. Explicit operator instructions take precedence; these preferences do not grant permission to commit or push. The explicit blank AGENTS generation mode still suppresses managed instructions.

## Director activation

**Enable git merges** (the Git Director switch in the page header; `GET`/`POST /admin/git-director/state`, `git_director.manage`) turns the registry on fleet-wide. While it is on, hosts with MCP enabled receive a Git Director section in their managed `AGENTS.md` / `CLAUDE.md` and the six `git_*` MCP tools answer. While it is off the page says so, existing registrations are kept, and the `git_*` tools stop serving.

## The registry

The page (`GET /admin/git-director`, `git_director.read`, refreshed by **Refresh** or by the `git_director.*` WebSocket events) groups registered worktrees by their normalized remote. The **Worktrees** view lists the live worktrees — the agent's task, the branch it means to merge into, the paths it declared, and how fresh its registration is — and **Merge requests** lists open requests with their verdict; the repository column names the clone and its host.

Two actions in a row's detail panel need `git_director.manage`:

- **Release registration** (`POST /admin/git-director/worktrees/{id}/release`) withdraws every live merge request the worktree holds (`verdict: 'withdrawn'`), marks it released, and frees any branch lease it held immediately instead of waiting out the TTL. Use it when an agent stopped without calling `git_release`.
- **Force allow** / **Deny** (`POST /admin/git-director/requests/{id}/decide` with `{ verdict: 'allow' | 'deny', reason? }`) overrides a pending verdict. The decision is recorded as made by an operator; an allow hands out a normal lease, and the reason — or the default *"Forced allow by an operator from the console."* — is what the waiting agent reads on its next status poll.

The **History** view shows **Reclaimed** registrations (rows that expired or whose agent is known to have ended — nothing is deleted, so a stale row stays visible with `expired` or `abandoned`) and recent verdicts.

## How arbitration works

The vocabulary (`api/src/services/git-director-tool-names.ts`): `git_list`, `git_register`, `git_join`, `git_merge_request`, `git_merge_status`, `git_release`. Constants in `api/src/services/git-director.ts`:

- An unbound registration lives `REGISTRATION_TTL_SECONDS = 3600` and is refreshed by calls naming its worktree, including `git_list`, and by polling an active merge request. A registration bound to a fresh live session survives that TTL.
- A worktree's `branch` and `head_sha` are the agent's own report, never read from disk, and `head_observed_at` is when that HEAD was reported. A `git_list` heartbeat refreshes `heartbeat_at` only; it updates the recorded snapshot when it also carries `head_sha` and/or `branch`.
- An `allow` verdict is a lease of `LEASE_TTL_SECONDS = 900` on the target branch. `git_merge_status` re-decides a `wait` in place on the same request id (that is also how a lease renews), and `git_merge_request` requires a `client_request_id` so a retry reuses its row instead of queueing a phantom second contender.
- Expiry is swept on read (register, merge request, merge status, and the admin listing), not by a timer. A bound registration is reclaimed when its session ends or its heartbeat becomes stale; an unbound one uses the TTL. Registration uses the MCP caller's engine and infers an omitted username only from one fresh live address matching that host, engine and directory. Ambiguous matches remain unbound.
- Declared paths are capped at 500 per registration (`MAX_PATHS`), a task description at 2,000 characters, a path at 1,024.

Verdicts are deterministic first: an uncontended request is allowed by policy. A contended one — two worktrees with overlapping declared or changed paths on the same branch — goes to the **judge** (`api/src/services/git-director-judge.ts`), which asks the fleet's Claude model (`GIT_DIRECTOR_DEFAULT_MODEL = 'claude-sonnet-5'`) with a 20-second timeout. The judge may decline but never blocks: on a timeout, transport failure, or unparsable answer the request falls back to `wait`, and the reason says so. Agent-authored task text is fenced as untrusted before it reaches the model. The admin routes construct the service without a judge at all — nothing on the console arbitrates; `decide` is an override.

Agents are told to pass `changed_paths` from `git diff --name-only base...head`: without them the Director can only say wait, with them the answer names the exact files two contenders both touch. The verdict is advice the fleet expects agents to take — nothing prevents a merge anyway, which is why an ignored `wait` is a real failure rather than a technicality.

## Roles

`git_director.read` is held by every role. `git_director.manage` — the switch, forcing a verdict, releasing a worktree — is held by owner, admin, and fleet operator: arbitrating merges between running agents is fleet operation, not content authorship. Trusted users and viewers see the registry with the action buttons hidden.

## Live updates

`git_director.changed`, `git_director.module_toggled`, `git_director.decision_forced`, and `git_director.worktree_evicted` invalidate the `git-director` query root. Toggling the switch, forcing a verdict, and releasing a worktree each write an admin event of the same name with the acting user's id.

## Source references

- api/src/routes/admin/git-director/index.ts (state, listing, decide, release — built without a judge)
- api/src/services/git-director.ts (registration and lease TTLs, sweep-on-read, deterministic verdicts, `adminDecide`, `adminEvictWorktree`)
- api/src/services/git-director-judge.ts (the Claude judge: 20-second timeout, declines rather than blocks, fences agent text)
- api/src/services/git-director-tool-names.ts (the six MCP tool names)
- api/src/services/mcp-tools.ts (tool definitions)
- api/src/security/capabilities.ts, api/src/security/route-capabilities.ts (`git_director.read` / `git_director.manage`)
- api/src/env.ts (`AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS`, reused as the registry's freshness window)
- frontend/src/routes/(coordination)/git-director/+page.svelte (module switch, Merge requests, Worktrees, History, Settings)
- frontend/src/lib/components/git-director/GitDetail.svelte (detail-panel operator actions)
- frontend/src/lib/api/gitDirector.ts (queries and mutations)

Git Director registrations require absolute worktree, repository and common-directory paths (`git rev-parse --path-format=absolute --show-toplevel --git-common-dir`). A correct re-registration supersedes earlier mappings for that host/path and withdraws their queued requests while retaining history. A live lease on an earlier mapping blocks reassignment. Join/list/merge/release never select an arbitrary legacy duplicate: `git_director_worktree_ambiguous` requires explicit re-registration with the correct clone facts. Superseded rows cannot be revived by path lookups.
