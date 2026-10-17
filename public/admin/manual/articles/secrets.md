---
title: Secrets
section: Admin workspace
summary: The fleet credential store: module switch, metadata table, audited reveal, host ownership, and the secret_* MCP tools.
tags: [secrets, credentials, mcp]
verified: 2026-10-17
sources: api/src/routes/admin/secrets/index.ts, api/src/services/secrets.ts, api/src/services/mcp-tools.ts, api/src/security/capabilities.ts, api/src/security/route-capabilities.ts, frontend/src/routes/(access)/access/+page.svelte, frontend/src/lib/components/secrets/SecretsSection.svelte, frontend/src/lib/components/secrets/SecretsList.svelte, frontend/src/lib/components/secrets/NewSecretDialog.svelte, frontend/src/lib/api/secrets.ts, frontend/src/lib/ws/events.ts
---

**Secrets** (a section of the **Access** page, `/access#secrets`, next to People and API keys) is the fleet credential store: API tokens, database passwords, service accounts — working credentials that agents fetch over MCP instead of finding in env files, config files, or shell history. Values are encrypted at rest with the same keyring as canonical auth, and nothing on this page shows one without an explicit, audited reveal.

## The module switch

The **Store enabled** switch in the Secrets section header (`GET`/`POST /admin/secrets/state`, `secrets.manage`) turns the store on; a note under the list says when the store is off or on but empty. While the module is on, hosts with MCP enabled receive the Secrets guidance in their managed `AGENTS.md` / `CLAUDE.md` and the five `secret_*` tools answer; while it is off, `secret_list` still responds so an agent can tell that the store is unavailable rather than empty.

## The table

`GET /admin/secrets` (`secrets.read_metadata`, held by every role; `?include_deleted=1` adds retired rows) lists each secret's slug, description, tags and owner (the table's **Secret**, **Used for**, **Managed by**, and **Rotated** columns). Every working credential is available to Codex, Claude and Grok. The owner shows as **Operator** for a secret created here (`source_host_id` is null — agents cannot rotate or delete it) or **Host #N** for one an agent stored through `secret_store` from that host. Values are never in the listing.

Controls, and the capability each needs:

- **New secret** (`POST /admin/secrets`, `secrets.manage`) — slug (at most 96 characters), value, description, and tags (at most 32). Credentials are shared across all engines.
- **Edit** (`PATCH /admin/secrets/{id}`, `secrets.manage`) — metadata and value; the body is strict and the slug is immutable.
- **Reveal** (`POST /admin/secrets/{id}/reveal`, `secrets.reveal`) — returns the plaintext once. It is a `POST` rather than a `GET` on purpose, so a browser cannot prefetch, cache, or replay it, and it writes a `secret.revealed` audit event that is deliberately **not** broadcast: a human reading a credential is an audit fact, not a reason to nudge any UI into refetching.
- **Revoke** (the row action that calls `DELETE /admin/secrets/{id}`, `secrets.manage`), after a confirmation.

`secrets.reveal` and `secrets.manage` are owner/admin only; a fleet operator sees metadata and nothing else.

## How agents use it

The MCP tools are `secret_list` (no arguments; its `status` and `capabilities` report live availability), `secret_search`, `secret_get` (by slug), `secret_store` (create, or rotate one the calling host owns), and `secret_delete` (retire one the calling host owns). The fleet policy served to agents tells them to check the store *before* asking a person for a credential, to prefer a tool-native secret parameter, stdin, or a process-scoped environment variable when using one, and never to write a value into shared memory or project state.

## Live updates

`secret.created`, `secret.updated`, `secret.deleted`, and `secret.module_toggled` refresh both the listing and the store switch.

## Source references

- api/src/routes/admin/secrets/index.ts (state, list, create, detail, patch, delete, reveal; slug and tag limits)
- api/src/services/secrets.ts (encrypted storage, host ownership)
- api/src/services/mcp-tools.ts (`secret_list`, `secret_search`, `secret_get`, `secret_store`, `secret_delete`)
- api/src/security/capabilities.ts, api/src/security/route-capabilities.ts (`secrets.read_metadata` / `secrets.reveal` / `secrets.manage`)
- frontend/src/routes/(access)/access/+page.svelte (the Access page that hosts the Secrets section)
- frontend/src/lib/components/secrets/SecretsSection.svelte (module switch, notes)
- frontend/src/lib/components/secrets/SecretsList.svelte, frontend/src/lib/components/secrets/NewSecretDialog.svelte (rows, reveal, edit, revoke, creation form)
- frontend/src/lib/api/secrets.ts (queries, owner labelling, tool-name hints)
- frontend/src/lib/ws/events.ts (`secret.*` invalidations; `secret.revealed` intentionally absent)
