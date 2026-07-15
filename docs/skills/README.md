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

- `context.SKILL.md` — `#context`. **Depends on the `project_memory_*` MCP tools**, so
  store it only after `api/src/db/migrations/0003_add_coord_project_memories.sql` is
  applied and the API is deployed. Storing it earlier ships instructions for tools that
  do not answer yet.
