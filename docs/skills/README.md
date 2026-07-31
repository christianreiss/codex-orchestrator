# Authored skill manifests

Fleet skills live in the `skills` table and are served over `/skills` and MCP
(`skill_list` / `skill_retrieve`); `clx` syncs them to `~/.claude/skills/<slug>/SKILL.md`
on Claude hosts. **The database is the runtime source of truth** — nothing reads this
directory, and a file here does not ship anything.

Manifests are kept here only when they need review in git before being stored, the
same way `api/src/db/migrations/*.sql` holds DDL that no runner applies automatically.
Both are deploy artifacts: apply them by hand, in order.

If you change a skill through the authoring UI (`/authoring/skills/<slug>`), the
admin API, or the MCP Skill tools, the copy here goes stale. Treat the DB as
authoritative and re-export, or delete the file rather than let it drift.
Code-managed Skills are the exception: they are synthesized from constants under
`api/src/services/` and cannot be stored through the normal paths.

## Optional external source: Matt Pocock skills

Authoring → Skills can subscribe the canonical library to
`https://github.com/mattpocock/skills`. This is an **external instruction supply
chain**, not a bundled default: inclusion is off on every fresh deployment and
causes no GitHub request while off. Review upstream before enabling it.

- `GET /admin/skill-sources/mattpocock` is readable by any authenticated admin
  role and returns source/repository/ref, switches, `disabled|ok|error` status,
  immutable revision, upstream plugin version, Skill/file counts, check/sync
  timestamps, and the last error.
- `POST /admin/skill-sources/mattpocock` requires owner/admin and accepts a
  non-empty body containing one or both strict `enabled` / `auto_update`
  booleans. Fresh source state defaults auto-update on, but a preference set
  while disabled is preserved when inclusion is enabled. Turning only
  auto-update off pins the last-known-good SHA.
- `POST /admin/skill-sources/mattpocock/refresh` requires owner/admin and no
  request body. It runs **Check now** for an enabled source even when periodic
  auto-update is off. The background updater checks enabled, auto-updating
  sources every six hours.

Every refresh resolves upstream `main` to one immutable 40-hex commit SHA and
then fetches every input at that SHA. It never mixes moving-branch responses.
The complete candidate validates before one database transaction advances the
served revision; any network, manifest, path, digest, or content error records
`last_checked_at`/`last_error` and leaves the prior last-known-good Skills and
revision untouched.

The importer does not recursively ingest the repository. Its inclusion boundary
is exactly the `skills` array in upstream `.claude-plugin/plugin.json`, with each
entry constrained to a safe `./skills/engineering/<slug>` or
`./skills/productivity/<slug>` directory. At the upstream 1.2.0 manifest that
allowlist is exactly these 22 paths:

```text
./skills/engineering/ask-matt
./skills/engineering/diagnosing-bugs
./skills/engineering/grill-with-docs
./skills/engineering/triage
./skills/engineering/improve-codebase-architecture
./skills/engineering/setup-matt-pocock-skills
./skills/engineering/tdd
./skills/engineering/to-spec
./skills/engineering/to-tickets
./skills/engineering/wayfinder
./skills/engineering/implement
./skills/engineering/prototype
./skills/engineering/research
./skills/engineering/domain-modeling
./skills/engineering/codebase-design
./skills/engineering/code-review
./skills/engineering/resolving-merge-conflicts
./skills/productivity/grill-me
./skills/productivity/grilling
./skills/productivity/handoff
./skills/productivity/teach
./skills/productivity/writing-great-skills
```

Each imported directory becomes an ordinary `skills` row plus its complete
auxiliary tree in `skill_files`; there is no parallel host sync path. The row
uses `source_type = github:mattpocock/skills` and records repository, upstream
path, immutable revision, `source_license = MIT`, and a complete-bundle SHA-256.
The upstream root license is fetched at that same revision and copied into every
bundle as `LICENSE.mattpocock` so redistribution retains the notice: **MIT
License, Copyright (c) 2026 Matt Pocock**. A non-blank source type is an ownership
marker, so the ordinary admin/host Skill store and delete endpoints reject direct
changes; edits must come from a validated source refresh.

Delivery remains engine-native:

- Codex reads the manifest at `skill://<slug>` and support files at
  `skill://<slug>/<path>`. The MCP catalogue labels upstream
  `disable-model-invocation: true` as `[Explicit user invocation only]`, and a
  read-time note routes relative paths through MCP. Bundled scripts are reference
  text, not permission to execute them.
- Claude receives the complete directory in `claude_skills`; cxx 0.7.3 validates
  every path/digest, recomputes the canonical complete-bundle digest, stages it,
  and atomically swaps
  `~/.claude/skills/<slug>/`. Its ownership manifest records every fleet-owned
  file and content digest. Missing, modified, symlinked, or unexpected managed
  content withholds the cached bundle digest and is restored by the next
  bootstrap. Non-canonical cross-slug ownership records are quarantined, and
  pruning never removes a user-authored Skill directory.

Turning inclusion off soft-deletes only rows owned by this source. Codex stops
listing them immediately; Claude removes only those fleet-owned directories on
its next complete bootstrap. The cached rows, files, and last-known-good source
metadata remain server-side for a safe re-enable. Locally authored Skills and
code-derived managed Skills are untouched.

## Storing one

`POST /admin/skills/store` requires an admin session cookie. Only `slug` and `manifest`
are required; `display_name`, `description`, and `engine` (`null` = all engines) are
optional. The server computes `sha256` itself. Re-storing identical content returns
`unchanged`.

An authenticated host agent can instead use MCP `skill_store` with `slug`,
`manifest`, and optional `display_name` / `description`. It creates, fully replaces,
or revives a manifest-only Skill as shared `engine:null` state. MCP `skill_delete`
soft-deletes by slug. Both operations are last-writer-wins and reject every
code-managed or source-owned Skill. The managed `skill-manager` Skill instructs
agents to use `skill_list` / `skill_retrieve` before a mutation and retrieve again
afterward to verify it.

```bash
# 1. Log in (the API binds 127.0.0.1:8488; through Caddy add --cert/--key for mTLS)
curl -sc /tmp/cj -X POST http://127.0.0.1:8488/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"<user>","password":"<password>"}'

# 2. Store, reading the manifest straight from the file
#    (the managed slugs listed below are REJECTED here)
jq -n --arg m "$(cat docs/skills/<slug>.SKILL.md)" \
  '{slug:"<slug>", display_name:"<Display name>", engine:null,
    description:"<one-line description>",
    manifest:$m}' \
| curl -sb /tmp/cj -X POST http://127.0.0.1:8488/admin/skills/store \
    -H 'Content-Type: application/json' --data-binary @-
```

## Managed skills (code-derived, never stored)

`afk`, `coco`, `context`, and `skill-manager` are NOT rows in the `skills` table and
must never be stored with `POST /admin/skills/store` or MCP `skill_store`; the
mutation paths reject every managed slug. Their manifests are constants in
`api/src/services/managed-afk-skill.ts`, `api/src/services/managed-coco-skill.ts`,
`api/src/services/managed-context-skill.ts`, and
`api/src/services/managed-skill-manager.ts`, assembled by
`api/src/services/managed-skills.ts`, and served through the normal `/skills` and
MCP paths. A managed slug shadows any same-named row left over from before, so an
existing deployment needs no migration.

Editing the constant and shipping the API image IS the release: the manifest sha changes, and every
host picks it up on its next sync. `docs/skills/context.SKILL.md` used to be the authoring copy for
`context` and was deleted when it moved into code — a checked-in file that ships nothing is exactly
the drift this change removes. `coco` is served only while
`projects_module_enabled = 1`; `afk`, `context`, and `skill-manager` are
unconditional.

## Current manifests

- `#skill-manager` — code-derived in
  `api/src/services/managed-skill-manager.ts`. It documents the MCP
  list/retrieve/store/delete/verify lifecycle, last-writer-wins behavior, recoverable
  deletion, and the code/source ownership boundary. It is shared across engines and
  is itself immutable through the tools it documents.

- `#context` — **no longer a file and no longer a row.** Moved into
  `api/src/services/managed-context-skill.ts` on 2026-07-27; the checked-in
  `context.SKILL.md` was deleted with it. `engine` is `null`, so it serves codex over
  MCP *and* rides the clx bundle to `~/.claude/skills/context/SKILL.md` — that behaviour
  is unchanged, only the source of truth moved.

  Its "The store is MCP, not local files" section is load-bearing, not boilerplate:
  Claude Code ships a native file-memory feature (`~/.claude/projects/**/memory/` +
  `MEMORY.md`) injected into the system prompt, and Codex has no equivalent. Without a
  section naming those paths, clx silently wrote context to host-local files while cdx
  used MCP — the same skill, opposite substrates. Do not trim it back to "use
  `project_*` tools"; the override has to name what it is overriding.
