---
title: Git Director
section: Admin workspace
summary: Clone and worktree registry, merge leases and verdicts, the judge, and the operator overrides.
tags: [git, merge, worktree, coordination]
verified: 2026-09-09
sources: api/src/routes/admin/git-director/index.ts, api/src/services/git-director.ts, api/src/services/git-director-judge.ts, api/src/services/git-director-tool-names.ts, api/src/services/mcp-tools.ts, api/src/security/capabilities.ts, api/src/security/route-capabilities.ts, api/src/env.ts, frontend/src/routes/git-director/+page.svelte, frontend/src/lib/components/settings/GitDirectorSection.svelte, frontend/src/lib/api/gitDirector.ts
---

Several agents work this fleet's repositories at once, often in separate worktrees of one checkout. The **Git Director** (`/git-director`, under *Coordinate*) is how they see each other: a registry of who is working in which clone, and an arbiter for merges into shared branches. It never touches a worktree — every agent runs its own git commands and reports what it did. The console page is where an operator watches the registry, forces a verdict, or releases a worktree an agent abandoned.

## The module switch

**Enable the Git Director** (`GET`/`POST /admin/git-director/state`, `git_director.manage`) turns the registry on fleet-wide. While it is on, hosts with MCP enabled receive a Git Director section in their managed `AGENTS.md` / `CLAUDE.md` and the six `git_*` MCP tools answer. The state badge next to the switch reports the clone and worktree counts and the model the judge uses.

## The registry

The page (`GET /admin/git-director`, `git_director.read`, refreshed by **Refresh** or by the `git_director.*` WebSocket events) groups registered worktrees by their normalized remote. For each clone it shows the live worktrees — the agent's task, the branch it means to merge into, the paths it declared, and how fresh its registration is — and any open merge requests with their verdict.

Two per-row actions need `git_director.manage`:

- **Release** (`POST /admin/git-director/worktrees/{id}/release`) withdraws every live merge request the worktree holds (`verdict: 'withdrawn'`), marks it released, and frees any branch lease it held immediately instead of waiting out the TTL. Use it when an agent stopped without calling `git_release`.
- **Force allow** / **Deny** (`POST /admin/git-director/requests/{id}/decide` with `{ verdict: 'allow' | 'deny', reason? }`) overrides a pending verdict. The decision is recorded as made by an operator; an allow hands out a normal lease, and the reason — or the default *"Forced allow by an operator from the console."* — is what the waiting agent reads on its next status poll.

Two collapsible panels show **Reclaimed** registrations (rows that expired or whose agent is known to have ended — nothing is deleted, so a stale row stays visible with `expired` or `abandoned`) and **Recent verdicts**.

## How arbitration works

The vocabulary (`api/src/services/git-director-tool-names.ts`): `git_list`, `git_register`, `git_join`, `git_merge_request`, `git_merge_status`, `git_release`. Constants in `api/src/services/git-director.ts`:

- A registration lives `REGISTRATION_TTL_SECONDS = 3600` and is refreshed by any call that names the worktree — including `git_list` — so an agent that keeps talking is never reclaimed.
- An `allow` verdict is a lease of `LEASE_TTL_SECONDS = 900` on the target branch. `git_merge_status` re-decides a `wait` in place on the same request id (that is also how a lease renews), and `git_merge_request` requires a `client_request_id` so a retry reuses its row instead of queueing a phantom second contender.
- Expiry is swept on read (register, merge request, merge status, and the admin listing), not by a timer. A registration bound to an Agent Messaging address is reclaimed the moment that address loses its session; an unbound one waits out the TTL.
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
- frontend/src/routes/git-director/+page.svelte (registry, Release, Force allow / Deny, Reclaimed and Recent verdicts)
- frontend/src/lib/components/settings/GitDirectorSection.svelte (the module switch)
- frontend/src/lib/api/gitDirector.ts (queries and mutations)
