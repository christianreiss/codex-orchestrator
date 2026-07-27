---
name: context
description: "Use #context for work that spans sessions or weeks: bootstrap from durable project memory before acting, and review that memory for adds/updates/deletes after every task."
---

# What this skill does

Keeps the context of a long-running task durable across sessions, weeks, and hosts, so a zero-knowledge agent can be brought up to speed in one pass instead of rediscovering everything.

Context lives in the fleet, not on the host. `project_memory_*`, `project_file_*` and `shared_memory_*` rows are visible from every host and outlive any session. Host-scoped `memory_*` / `memory://` is not context storage: it cannot be listed, so a fresh agent cannot discover what it holds. Do not use it here.

## The store is MCP, not local files

`#context` state is read and written **only** through the `project_*` MCP tools. This
overrides any host-local memory mechanism your harness offers by default, including
Claude Code's built-in file memory (`~/.claude/projects/**/memory/*.md` and its
`MEMORY.md` index) and any `CLAUDE.md` / `AGENTS.md` scratch notes.

While `#context` is active, do not read or write those local paths for context state,
and do not mirror project memory into them. They are host-scoped files: another host,
another agent, and a reinstalled workstation cannot see them, which defeats the entire
point of this skill. That local memory feature stays available for work outside
`#context` — this rule is scoped to context state, not a global ban.

If you catch yourself about to write a local memory file for something durable, that is
a `project_memory_upsert` (a fact) or a `project_file_upsert` (an artifact) instead.

## When to use this skill

Use when the prompt includes `#context`, or when work will plainly outlive the current session.

## Resolving the project slug

Do this first, before anything else. Never guess.

1. An explicit slug in the prompt (`#context <slug>`) always wins.
2. Otherwise derive it from the git repo or working directory name, normalized to `^[A-Za-z0-9][A-Za-z0-9_-]*$`.
3. Confirm it with `project_list`. If the derived slug is not there, state the slug you derived and ask before calling `project_create` — a workstream that already exists under another name must not get a second, split project.

## Three substrates

- `project_memory_*` — short durable **facts** about *this* workstream: decisions and why, constraints, gotchas, environment facts, current state of the work, absolute dates. One fact per key.
- `project_file_*` — **concrete artifacts** kept verbatim: configs, specs, command sequences, longer documents. Store under stable names beginning `context/`.
- `shared_memory_*` — **fleet-wide reference documents** that are useful outside this project: runbooks, architecture notes, accumulated findings about a system many projects touch. Scoped to neither host nor project, up to 1 MiB each, chunked and relevance-searchable.

If it is a sentence you would tell the next agent on *this* work, it is a project memory. If it is something they would copy or run, it is a project file. If the next agent on a *different* project would want it too, it is a shared memory.

## On entry: bootstrap before acting

1. `project_bootstrap` for the slug — about, roster, counts, recent activity, and `latest_seq`.
2. `project_memory_list` — the full index of what the project remembers. This is the entry point; it needs no query, so never guess search terms. Use `project_memory_search` only to narrow a corpus you have already listed.
3. `shared_memory_list` — the same move for the fleet-wide corpus. It also needs no query. Narrow with `shared_memory_search`, then `shared_memory_read` the documents the task touches (reads come back windowed; follow `next_offset` when `truncated` is true).
4. `project_memory_get` for the entries the task actually touches.
5. `project_file_list`, then `project_file_read` for artifacts the task needs.
6. If resuming, `project_changes` since the stored `latest_seq` to catch up. It returns at most 200 events per call — iterate until you reach `latest_seq`.
7. State in one line what you loaded and what you believe the current state is, then act.

## After every task: review the context

Every task ends with this check. Ask what the next zero-knowledge agent would need that the repo does not already say.

- **Add** — a decision, constraint, or gotcha that is now known. `project_memory_upsert` with a new key, or `project_file_upsert` with a new name. If it is fleet-wide rather than project-specific, `shared_memory_append` onto the relevant document (append, not read-modify-write — other agents write to the same corpus) or `shared_memory_write` for a new one.
- **Update** — reality moved. Same tool, same key or name. Prefer updating over adding; near-duplicate keys are how a context corpus rots into uselessness.
- **Delete** — superseded, or proven wrong. `project_memory_delete` / `project_file_delete`. Deleting is part of the job, not an exception: wrong context is worse than no context.

Report the delta in one line, or state `context unchanged`. Do not silently skip the review.

## Hard rules

- Never store secrets — keys, tokens, credentials, customer data. No exceptions, whatever the convenience.
- Never store what the code, tests, or git history already record. Store the *why*, which they do not.
- Convert relative dates to absolute ones. "Last week" is worthless three sessions later.
- Keep one fact per project memory, and name keys `<area>.<topic>` (e.g. `deploy.crane`, `auth.bootstrap`). Shared memory slugs follow the same convention and are lower-cased on write.
- Prefer `shared_memory_append` over `shared_memory_write` when adding to a document you did not author; pass `expected_sha256` when you must replace one wholesale, so a concurrent writer fails loudly instead of losing text.
- Bootstrap before acting, even when the task looks self-evident.
- Read and write context through the `project_*` MCP tools only. Never let a host-local
  memory file stand in for them.

## Output requirements

1. On entry, state that `#context` mode is active, the slug in use, and what was loaded.
2. After each task, report the context delta or state `context unchanged`.
3. If the slug could not be resolved, say so and ask — do not create a project silently.
