# Authored skill manifests

Fleet skills live in the `skills` table and are served over `/skills` and MCP
(`skill_list` / `skill_retrieve`); `clx` syncs them to `~/.claude/skills/<slug>/SKILL.md`
on Claude hosts. **The database is the runtime source of truth** — nothing reads this
directory, and a file here does not ship anything.

Manifests are kept here only when they need review in git before being stored, the
same way `api/src/db/migrations/*.sql` holds DDL that no runner applies automatically.
Both are deploy artifacts: apply them by hand, in order.

If you change a skill through the authoring UI (`/authoring/skills/<slug>`) or the
admin API, the copy here goes stale. Treat the DB as authoritative and re-export, or
delete the file rather than let it drift. (Exception: `coco` is not here and never
will be — it is synthesized from a constant in `api/src/services/managed-coco-skill.ts`
and cannot be stored through the normal path.)

## Storing one

`POST /admin/skills/store` requires an admin session cookie. Only `slug` and `manifest`
are required; `display_name`, `description`, and `engine` (`null` = all engines) are
optional. The server computes `sha256` itself. Re-storing identical content returns
`unchanged`.

```bash
# 1. Log in (the API binds 127.0.0.1:8488; through Caddy add --cert/--key for mTLS)
curl -sc /tmp/cj -X POST http://127.0.0.1:8488/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"<user>","password":"<password>"}'

# 2. Store, reading the manifest straight from the file
jq -n --arg m "$(cat docs/skills/context.SKILL.md)" \
  '{slug:"context", display_name:"Durable task context", engine:null,
    description:"Use #context for work that spans sessions or weeks: bootstrap from durable project memory before acting, and review that memory for adds/updates/deletes after every task.",
    manifest:$m}' \
| curl -sb /tmp/cj -X POST http://127.0.0.1:8488/admin/skills/store \
    -H 'Content-Type: application/json' --data-binary @-
```

## Current manifests

- `context.SKILL.md` — `#context`. **Stored on 2026-07-19** (migration
  `0003_add_coord_project_memories.sql` is applied and `project_memory_*` answers).
  `engine` is `null`, so it serves codex over MCP *and* rides the clx bundle to
  `~/.claude/skills/context/SKILL.md`.

  Its "The store is MCP, not local files" section is load-bearing, not boilerplate:
  Claude Code ships a native file-memory feature (`~/.claude/projects/**/memory/` +
  `MEMORY.md`) injected into the system prompt, and Codex has no equivalent. Without a
  section naming those paths, clx silently wrote context to host-local files while cdx
  used MCP — the same skill, opposite substrates. Do not trim it back to "use
  `project_*` tools"; the override has to name what it is overriding.
