# Agent roles

An agent role is a specialist responsibility — design review is the first — packaged as a
versioned **role package**: a `ROLE.md` manifest (YAML frontmatter plus the role prompt)
and optional support files. An agent takes a role on an explicit assignment, keeps it for
the session (resume and compaction included) and works with other agents through it.
Holders improve their role through a proposal pipeline that publishes on its own; the
operator steers it rather than approving each change.

**A role grants no permission.** Tool availability, permissions, sandboxing and approval
stay where they are enforced today (host API key, host flags, module switches, the engine
master switch, the engine's own sandbox/approval settings). A role can *describe* tools it
expects and *point* to them; it cannot provision one. Role content is data below the fleet
policy.

Module switch: `versions` row `roles_enabled` (default off). Schema: migration
`0081_agent_roles.sql`, see [interface-db.md](interface-db.md#agent-roles-migration-0081).
Code: `api/src/services/roles.ts` (facade) and `api/src/services/roles/`.

## Where things run

| Surface | Served by | Authentication | Why there |
|---|---|---|---|
| `role_list`, `role://` resources | clx MCP (`/mcp`) | host API key | catalog and content are session-independent |
| `agent_role_*` tools | `cxx-agent` (wrapper) → `/host/agent-sessions/:id/agent-messaging/roles/*` | per-session bridge token | activation, proposals and reviews need the caller's own identity |
| `/admin/roles/*` | API | admin session, `content.read` / `content.manage` | operator steering |
| `roles` Skill | managed skill (`api/src/services/managed-roles-skill.ts`) | — | the generic procedure every agent follows; served only while `roles_enabled` |
| `## Agent Roles` guidance | managed AGENTS.md / CLAUDE.md block | — | always-on trigger; present when the switch is on, the host has the clx MCP and Agent Messaging, and its cxx is ≥ 0.9.108 |

## The package

```yaml
---
name: design                 # must equal the slug
label: Designer              # optional; session titles show "(Name) (Designer) task"
summary: ...
responsibilities: [ ... ]
boundaries: [ ... ]
tools:
  required:    [{ name: agent_request, why: ... }]
  recommended: [{ capability: browser-screenshot, candidates: [...], why: ... }]
collaboration:
  accepts: [review]
  finding_classes: [ ... ]   # vocabulary for REVIEW/1 findings
  priorities: [ ... ]
---
<role prompt>
```

Every field but `name` is optional and descriptive. Support files carry a path, MIME type,
description and a load mode: `core` files are delivered with every activation, `on_demand`
files are read through `role://` when a task needs them.

Limits: manifest plus core files ≤ 48 KiB (text only); a file ≤ 4 MiB; a version ≤ 256
files and 16 MiB. Paths are relative, forward-slash, no dot segments; `ROLE.md` is
reserved for the manifest.

Versions are immutable once published. Bodies are content-addressed blobs shared across
versions. A revert publishes a **new** version carrying the older content; a faulty version
can be **withdrawn** (no new activations; holders are told). Nothing is physically deleted.

## Catalog and content (clx MCP)

- `role_list {query?, include_retired?}` → `{roles: [{slug, display_name, summary, status, current_version, sha, uri}], note}`.
  Listed only while `roles_enabled`. Roles without a published version are not listed.
- `resource_read role://{slug}` — current version: JSON with manifest and file index.
- `resource_read role://{slug}@{n}` — version `n`; a withdrawn version is readable and carries a `warning`.
- `resource_read role://{slug}@{n}/{path}` — one file: `text` for text, MCP `blob` (base64) for binary.
- `role://` is read-only: `resource_create`/`resource_update` refuse it, and `skill_store` cannot touch roles.

Errors: `roles_disabled` (403), `role_not_found`, `role_version_not_found`, `role_file_not_found` (404).

## Assignment (cxx-agent)

An assignment binds one **pinned version** to one agent **address**. The address is the
identity a resume keeps (`session.ts` re-finds it through the native session id); a fresh
launch gets a new address and therefore no role. When an address is rebound with
`continuity = reset`, its role ends (`continuity_reset`): the transcript that was told the
role is gone. An address holds at most one active role (unique `active_address_id`).

| Tool | Input | Result | Errors |
|---|---|---|---|
| `agent_role_activate` | `role`, `version?` (`latest` or n), `reason` (quote the assignment), `client_request_id`, `replace?`, `activated_by?` (`operator_prompt` default, `portal`, `spawn`, `peer`, `self_upgrade`), `peer_address?`, `message_id?` | `{created, assignment, role{slug, version, sha, uri, holder_upgrade}, newer_version, manifest, core_files, files_index, tools, collaboration}` | `role_not_found` (with `candidates`), `role_retired`, `role_version_withdrawn`, `role_version_not_found`, `role_already_active`, `role_upgrade_manual`, `role_upgrade_not_newer`, `no_active_role`, `roles_disabled` |
| `agent_role_current` | `include_core?` | `{active: null, last_ended}` or `{active: true, assignment, role, newer_version, …core}` — always the pinned version | `roles_disabled` |
| `agent_role_release` | `reason` | `{ended_assignment_id}` | `no_active_role` |

Rules: the same `client_request_id` replays the same result. Re-activating the version you
hold is a no-op. A different role needs `replace:true` (the principal's instruction); a
`peer` may assign only to an agent without a role; `self_upgrade` moves only to a newer
version of the same role and is refused when the role's policy says `holder_upgrade: manual`.

`agent_self` and every `agent_list` entry carry `role: {slug, display_name, label, version,
sha, version_state, assignment_id, activated_at}` or `null`; `agent_self` also returns
`role_labels` (every label the address has carried). `agent_list {role}` filters to holders.

### Session titles

The receiver's session-name reporter (all engines) asks `agent_self` on each heartbeat and
writes the native title as `(Name) (Label) task`; it posts `(Label) task` as the
`session_named` title, so dashboards render `(Name) (Label) task` too. Old labels from
`role_labels` are stripped on a switch or release.

### Keeping the role across compaction and resume

- **Claude:** the `SessionStart` hook (`cxx agent native-session`) reads `source`; on
  `resume` and `compact` it emits `additionalContext` with a `ROLE/1` anchor (role, version,
  sha and the instruction to reload with `agent_role_current {include_core:true}`). The
  anchor, not the full core, keeps the hook output small.
- **Codex:** no hook surface. The managed guidance tells the agent to check `agent_self`
  after resume and reload when its role's instructions are missing. Compaction is not
  observable to the wrapper; this is the documented limit.
- **Grok:** same as Codex until its SessionStart output is verified to inject context.

### Notices (Server → holder, informational)

Server-originated `publication`-kind messages, no reply:

- `ROLE-UPDATE/1` — a newer version was published (or `severity=withdrawn`). The holder
  stays pinned; with `holder_upgrade: at_task_boundary` it switches itself between two work
  items (`activated_by: self_upgrade`) and says so.
- `ROLE-REVIEW/1` — "review this proposal" to the chosen independent holder.
- `ROLE-PROPOSAL/1` — the outcome of the author's proposal.

### Starting an agent in a role

There is no `role` argument on `agent_spawn`. The launch prompt carries the assignment
("You are the design agent; activate role `design` with `activated_by: spawn`"), and the
spawned agent activates it itself through the `roles` Skill. The address does not exist
before the launch, so a server-side pre-assignment would have nothing to bind to; the
prompt keeps the assignment explicit and attributable (`activated_by`, `reason`).

## Collaboration protocol

Defined in the `roles` Skill, carried on existing tools:

- Find a holder: `agent_list {role, online:true}`; prefer project scope, then host, then
  fleet; ask one holder. None available: note it and continue — a review never blocks.
- Request: `agent_request` with a `REVIEW/1` header (`role`, `mandate=advise|accept`,
  `previous=`), subject, state, how to run it, criteria (with `mandate=accept`), attachments.
- Answer: `agent_task_result` — `succeeded` = review done whatever it found, `blocked` = not
  reachable; summary with `outcome`, `checked`, `criteria`, `gaps`, `findings` (role
  vocabulary). Finding status `open → reported_fixed → verified_fixed | wont_fix | disputed`;
  only the reviewer sets `verified_fixed`.
- Acceptance authority comes from the requester's `mandate`, never from the role.

## Improvement pipeline (self-mutating, operator-steered)

| Tool | Input | Result | Errors |
|---|---|---|---|
| `agent_role_propose` | `kind` (`file_add`, `file_change`, `file_remove`, `manifest_change`, `note`, `revert`), `title`, `rationale`, `evidence?`, `ops?` (`{op: put\|delete, path, content?, encoding?, mime_type?, load?, description?, base_sha256?}`), `revert_to_version?`, `client_request_id` | `{created, proposal}` | `no_active_role`, `rate_limited` (20/hour), validation |
| `agent_role_proposals` | `proposal_id?`, `status?` | own proposals plus open ones for the held role; one in full with bodies and events | `proposal_not_found` |
| `agent_role_review` | `proposal_id`, `verdict` (`accept`, `reject`, `revise`), `reason`, `expected_version` | `{proposal}` | `review_self_forbidden`, `review_not_assigned`, `proposal_not_in_review`, `proposal_version_conflict` |

Bases default to the proposer's pinned version. **Risk** is computed by the server:
`revert`; `core` (manifest, a core file, or a put with `load: core`); `modifying` (changes or
deletes an existing file); otherwise `additive`.

1. **Gates** (deterministic): role active; every op's base equals the current version
   (else `superseded`, `proposal_base_stale` — re-propose); no credential shapes; the
   resulting version is publishable (manifest, budgets); protected paths → `held`;
   `frozen` → `held`.
2. **Judge** (`api/src/services/roles/judge.ts`, same runner adapter and model as the Git
   Director arbiter): agent text is fenced as untrusted, the verdict is an enum, the reason
   must cite the change. It checks the fleet invariants (no permission claims, no secrets,
   no project-specific content, generality proportional to evidence, consistency with the
   role's boundaries). **It may decline, never block, and never publishes alone:** no
   runner, a timeout or an invalid reply keeps the proposal in `checking` with backoff.
3. **Independent review** for `modifying` and `core`: the server picks another active
   holder of the role (preferring another engine), sends `ROLE-REVIEW/1` and waits for
   `agent_role_review`. No holder → stays `in_review`. After 72 h a `modifying` proposal
   gets one stricter judge pass instead; `core` has no fallback.
4. **Publish** under the role row lock, re-checking the base (a concurrent publish
   supersedes the loser), the policy (`supervised` → `held`) and the daily budget. The new
   version announces itself with `ROLE-UPDATE/1`.

Open proposals untouched for 14 days are `superseded`. The worker runs every 30 s in the
API process while `roles_enabled` is on.

Project-specific decisions never go into a role: they belong to the project's own records
(its decision register, or `project_memory_upsert` key `role.<slug>.decision.<topic>`).

## Operator steering

Per-role `policy` (JSON on `agent_roles`):

| Field | Values (default) | Effect |
|---|---|---|
| `mutation` | `autonomous` / `supervised` / `frozen` (`autonomous`) | publish on its own / hold every publish for `decide` / hold everything |
| `protected_paths` | list (`[]`) | proposals touching them are held for the operator |
| `daily_budget` | 0–1000 (`10`) | published versions per 24 h before proposals are held |
| `holder_upgrade` | `at_task_boundary` / `manual` (`at_task_boundary`) | whether holders move to new versions themselves |
| `verdict_binding` | boolean (`false`) | reserved; nothing enforces it yet |

Admin routes (all `requireAdmin`; reads `content.read`, writes `content.manage`, every
mutation audited in `admin_events` as `agent_roles.*`):

- `GET/POST /admin/roles/state` — module switch `{enabled}`.
- `GET /admin/roles`, `POST /admin/roles` (`{slug, display_name, summary, policy?}`; `state` and `proposals` are reserved slugs).
- `GET /admin/roles/:slug`, `PATCH /admin/roles/:slug` (`display_name`, `summary`, `status`, `policy`, `expected_version`).
- `GET /admin/roles/:slug/timeline`, `GET /admin/roles/:slug/versions/:version`.
- `PUT /admin/roles/:slug/draft` (`{manifest, files[{path, content|blob_sha256, encoding?, mime_type?, load?, description?}], changelog?}`), `DELETE /admin/roles/:slug/draft`, `POST /admin/roles/:slug/publish`.
- `POST /admin/roles/:slug/revert` (`{version, reason}`), `POST /admin/roles/:slug/versions/:version/withdraw` (`{reason}`).
- `GET /admin/roles/proposals/:id`, `POST /admin/roles/proposals/:id/decide` (`{verdict: accept|reject, reason, expected_version}`): `accept` publishes now past judge, review, budget and policy; `reject` closes an open proposal or, on an applied one, vetoes it by reverting to the version current before it.
