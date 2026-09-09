---
title: Secrets
section: Admin workspace
summary: The fleet credential store: module switch, metadata table, audited reveal, host ownership, and the secret_* MCP tools.
tags: [secrets, credentials, mcp]
verified: 2026-09-09
sources: api/src/routes/admin/secrets/index.ts, api/src/services/secrets.ts, api/src/services/mcp-tools.ts, api/src/security/capabilities.ts, api/src/security/route-capabilities.ts, frontend/src/routes/secrets/+page.svelte, frontend/src/lib/components/secrets/SecretsTable.svelte, frontend/src/lib/components/secrets/NewSecretDialog.svelte, frontend/src/lib/api/secrets.ts, frontend/src/lib/ws/events.ts
---

**Secrets** (`/secrets`, under *Access*) is the fleet credential store: API tokens, database passwords, service accounts — working credentials that agents fetch over MCP instead of finding in env files, config files, or shell history. Values are encrypted at rest with the same keyring as canonical auth, and nothing on this page shows one without an explicit, audited reveal.

## The module switch

**Enable secrets** (`GET`/`POST /admin/secrets/state`, `secrets.manage`) turns the store on. The state card shows a live count. While the module is on, hosts with MCP enabled receive the Secrets guidance in their managed `AGENTS.md` / `CLAUDE.md` and the five `secret_*` tools answer; while it is off, `secret_list` still responds so an agent can tell that the store is unavailable rather than empty.

## The table

`GET /admin/secrets` (`secrets.read_metadata`, held by every role; `?include_deleted=1` adds retired rows) lists each secret's slug, description, tags, engine scope (`codex`, `claude`, or both), and owner. Owner is **Operator** for a secret created here (`source_host_id` is null — agents cannot rotate or delete it) or **Host #N** for one an agent stored through `secret_store` from that host. Values are never in the listing.

Controls, and the capability each needs:

- **New secret** (`POST /admin/secrets`, `secrets.manage`) — slug (at most 96 characters), value, description, tags (at most 32), and engine scope.
- **Edit** (`PATCH /admin/secrets/{id}`, `secrets.manage`) — metadata and value; the body is strict and the slug is immutable.
- **Reveal** (`POST /admin/secrets/{id}/reveal`, `secrets.reveal`) — returns the plaintext once. It is a `POST` rather than a `GET` on purpose, so a browser cannot prefetch, cache, or replay it, and it writes a `secret.revealed` audit event that is deliberately **not** broadcast: a human reading a credential is an audit fact, not a reason to nudge any UI into refetching.
- **Delete** (`DELETE /admin/secrets/{id}`, `secrets.manage`).

`secrets.reveal` and `secrets.manage` are owner/admin only; a fleet operator sees metadata and nothing else.

## How agents use it

The MCP tools are `secret_list` (no arguments; its `status` and `capabilities` report live availability), `secret_search`, `secret_get` (by slug), `secret_store` (create, or rotate one the calling host owns), and `secret_delete` (retire one the calling host owns). The fleet policy served to agents tells them to check the store *before* asking a person for a credential, to prefer a tool-native secret parameter, stdin, or a process-scoped environment variable when using one, and never to write a value into shared memory or project state.

## Live updates

`secret.created`, `secret.updated`, `secret.deleted`, and `secret.module_toggled` refresh both the listing and the state card.

## Source references

- api/src/routes/admin/secrets/index.ts (state, list, create, detail, patch, delete, reveal; slug and tag limits)
- api/src/services/secrets.ts (encrypted storage, host ownership)
- api/src/services/mcp-tools.ts (`secret_list`, `secret_search`, `secret_get`, `secret_store`, `secret_delete`)
- api/src/security/capabilities.ts, api/src/security/route-capabilities.ts (`secrets.read_metadata` / `secrets.reveal` / `secrets.manage`)
- frontend/src/routes/secrets/+page.svelte (module switch, count, table host)
- frontend/src/lib/components/secrets/SecretsTable.svelte, frontend/src/lib/components/secrets/NewSecretDialog.svelte (rows, reveal, edit, delete, creation form)
- frontend/src/lib/api/secrets.ts (queries, owner labelling, tool-name hints)
- frontend/src/lib/ws/events.ts (`secret.*` invalidations; `secret.revealed` intentionally absent)
