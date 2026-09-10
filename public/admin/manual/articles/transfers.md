---
title: File Transfer
section: Admin workspace
summary: The expiring file pool agents hand each other: module switch, limits, held files, downloads, and the audit trail.
tags: [transfers, files, mcp]
verified: 2026-09-09
sources: api/src/routes/admin/transfers/index.ts, api/src/services/agent-transfers.ts, api/src/services/agent-transfers-tool-names.ts, api/src/ops/agent-transfers-worker.ts, api/src/db/migrations/0028_add_agent_transfers.sql, api/src/services/mcp-tools.ts, api/src/services/managed-agents-features.ts, api/src/security/capabilities.ts, api/src/security/route-capabilities.ts, api/src/env.ts, frontend/src/routes/transfers/+page.svelte, frontend/src/lib/components/transfers/TransferLimitsSection.svelte, frontend/src/lib/components/transfers/TransferAuditSheet.svelte, frontend/src/lib/api/transfers.ts, frontend/src/lib/ws/events.ts
---

**File Transfer** (`/transfers`, under *Coordinate*) is an expiring pool of files that agents hand each other. An agent on one host uploads a file over MCP, tells the peer its id, and the peer fetches it — across hosts, across engines, without a shared filesystem. Every file has a TTL, every byte counts against one fleet-wide quota, and every fetch is recorded, because the pool has **no addressing**: there is no recipient, and knowing an id is sufficient to fetch. What that owes an operator instead is a record of who actually took a copy, which is what this page is for.

## The module switch

The page opens with **Enable file transfer** (`POST /admin/transfers/state`, `transfers.manage`). The module is off until an owner, admin, or fleet operator turns it on. While it is on, every managed host receives a *File Transfer* section in its `AGENTS.md` / `CLAUDE.md` on the next wrapper launch — the section is rendered only when the host's MCP is enabled and the module flag is set, exactly like Git Director — and the five `transfer_*` MCP tools become callable.

Turning the module **off** stops `transfer_put`, `transfer_get`, `transfer_info`, and `transfer_delete` (they throw), but deletes nothing: files already held keep expiring on their own deadlines and are swept as usual. `transfer_list` is the deliberate exception — it always answers, returning `status: 'disabled'` with an empty list, so an agent can tell "disabled" from "empty pool" without an error.

## Limits

The **Limits** card (`POST /admin/transfers/limits`, `transfers.manage`) holds the four bounds, all stored in `versions` rather than the environment so an operator can change them from the console. Defaults and ceilings come from `api/src/services/agent-transfers.ts`:

| Setting | Default | Server bounds |
|---|---|---|
| Default TTL | 1 hour (`DEFAULT_TTL_SECONDS = 3600`) | 60 s (`MIN_TTL_SECONDS`) … maximum TTL |
| Maximum TTL | 1 day (`DEFAULT_MAX_TTL_SECONDS = 86400`) | 60 s … 7 days (`HARD_MAX_TTL_SECONDS = 604800`) |
| Maximum file size | 8 MiB (`DEFAULT_MAX_FILE_BYTES`) | 1 KiB … 64 MiB (`HARD_MAX_FILE_BYTES`) |
| Pool quota | 2 GiB (`DEFAULT_QUOTA_BYTES`) | at least the maximum file size; no upper ceiling |

The request body is strict (`default_ttl_seconds`, `max_ttl_seconds`, `max_file_bytes`, `quota_bytes`, all positive integers); an incoherent set — a default TTL above the maximum, a quota below one file — is refused as a whole rather than partially applied. The inputs are shown in minutes and MiB; their `max` attributes mirror the 7-day and 64 MiB ceilings but the server is what enforces them. The usage meter under the inputs shows `used_bytes` against `quota_bytes` and turns amber at 80% and red at 90%.

An agent that asks for a TTL outside the bounds is not refused: the request is **clamped** to the floor or the maximum TTL and the row is flagged `ttl_clamped`, which the table shows as a *clamped* badge.

## Held files

The **Held files** table (`GET /admin/transfers`, `transfers.read`, at most 200 rows, refreshed every 30 seconds because every row carries a deadline the server sweeps past) lists each file with its name and MIME type, status, size, who claims to have uploaded it, how many times it has been fetched, and when it expires (a countdown). `?include_retired=1` also returns expired and deleted rows. Per row:

- **Download** (`GET /admin/transfers/{id}/content`) streams the file with its original name. It needs `transfers.download` — owner and admin only — and is enabled only while the row is `live`. The fetch is written to the audit trail as an admin download and bumps the row's download count; it deliberately publishes no WebSocket event, because an operator reading a file changes nothing the console is showing.
- **Copy id** puts the transfer id on the clipboard so you can hand it to an agent.
- **Delete** (`DELETE /admin/transfers/{id}`, `transfers.manage`) retires a live file after a confirmation. The bytes are unlinked immediately; the row and its full event trail are kept.

Clicking a row opens the **audit sheet** (`GET /admin/transfers/{id}/events`): id, uploaded-by and uploaded-from, SHA-256, the requested TTL (and whether it was clamped), the description, and the ordered event trail — `uploaded`, `appended`, `sealed`, `downloaded`, `deleted`, `expired` — each attributed to an agent, an admin, or the sweeper.

`uploaded_by` and `uploaded_from` are **asserted by the uploading agent** (`username` and `worktree_path` on `transfer_put`), not verified by the fleet, and the sheet says so. The only field the orchestrator knows first-hand is `source_host_id`: a host API key identifies a machine, not an individual agent.

## Lifecycle

A transfer is `uploading` while a chunked put is open, `live` once sealed, and then `expired` (swept past its deadline) or `deleted` (retired early by an agent or an operator). Only `uploading` and `live` rows count against the quota and the `live_count` on the state card. Bytes live under `<DATA_ROOT>/transfers/<first two characters of the id>/<id>`.

The sweeper (`api/src/ops/agent-transfers-worker.ts`) runs once at boot and then every `TRANSFERS_PURGE_INTERVAL_SECONDS` (default 300); every twelfth tick it also reclaims orphaned files on disk that are older than one hour. The service additionally sweeps on every read — list, info, get, download, and put — so a file that expired between ticks is gone by the time anyone looks. During a sweep the bytes are unlinked **before** the row's status changes: a crash in between leaves a `live` row with missing bytes, which is a harmless retry, rather than an `expired` row silently guarding an undeleted file.

## How agents use it

All five tools ride the host-authenticated `POST /mcp` endpoint; there is no separate HTTP upload route and the wrappers have no dedicated `transfer` subcommand.

| Tool | Parameters | Notes |
|---|---|---|
| `transfer_list` | `limit?` | Always callable; the probe for whether the module is on. |
| `transfer_put` | `content_b64`, `name`, `ttl_seconds` (required on a new upload), `mime_type?`, `description?`, `username?`, `worktree_path?`; `id?`, `offset?`, `final?` for chunking | Up to 4 MiB of decoded bytes per call (`MAX_CHUNK_BYTES`); send `final: false` to keep appending, then a final chunk to seal. |
| `transfer_get` | `id`, `offset?`, `max_bytes?` | Chunked reads; the download count is bumped only when a read reaches the end of the file. |
| `transfer_info` | `id` | Metadata without the bytes. |
| `transfer_delete` | `id`, `username?` | Retires the file early. |

`transfer_list` also returns a `capabilities` object (`put`, `get`, `info`, `delete`, `chunked`, and `private_to_recipient: false`) — the last flag is the code's own statement that the pool has no addressing.

## Roles

| Capability | Who holds it | What it covers |
|---|---|---|
| `transfers.read` | every role | the state card, the table, the audit sheet |
| `transfers.manage` | owner, admin, fleet operator | the switch, the limits, deleting a file |
| `transfers.download` | owner, admin | reading the bytes back |

`transfers.download` is deliberately not part of the fleet-operator set: a fleet operator may empty the pool without reading what was in it, the same line `secrets.reveal` draws between metadata and content. Controls a role does not hold are disabled with a tooltip naming the missing capability.

## Live updates

`transfers.changed` (create, append, seal, delete, expire), `transfers.module_toggled`, `transfers.limits_changed`, and `transfers.deleted` all invalidate the `transfers` query root, so the state card, the meter, and the table refresh together. Toggling the module and changing limits also write `transfers.module_toggled` / `transfers.limits_changed` admin events with the acting user's id.

## Source references

- api/src/routes/admin/transfers/index.ts (every `/admin/transfers*` route; `/content` streams the file itself)
- api/src/services/agent-transfers.ts (defaults, hard ceilings, clamping, statuses, sweep ordering, storage layout)
- api/src/services/agent-transfers-tool-names.ts (the five MCP tool names)
- api/src/services/mcp-tools.ts (tool definitions and the `transfer_list` disabled probe)
- api/src/ops/agent-transfers-worker.ts (expiry sweep cadence, orphan reclaim every twelfth tick)
- api/src/db/migrations/0028_add_agent_transfers.sql (`agent_transfers`, `agent_transfer_events`)
- api/src/services/managed-agents-features.ts (the *File Transfer* section rendered into managed AGENTS.md / CLAUDE.md)
- api/src/security/capabilities.ts, api/src/security/route-capabilities.ts (`transfers.read` / `transfers.download` / `transfers.manage`)
- api/src/env.ts (`TRANSFERS_PURGE_INTERVAL_SECONDS`)
- frontend/src/routes/transfers/+page.svelte (the page: switch, table, row actions)
- frontend/src/lib/components/transfers/TransferLimitsSection.svelte (limits form and usage meter)
- frontend/src/lib/components/transfers/TransferAuditSheet.svelte (per-file audit trail)
- frontend/src/lib/api/transfers.ts (queries, mutations, 30-second refetch, status and action labels)
- frontend/src/lib/ws/events.ts (`transfers.*` invalidations)
