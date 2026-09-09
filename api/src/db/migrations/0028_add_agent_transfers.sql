-- Agent file transfer: a fleet-wide, TTL'd pool of arbitrary files that any
-- agent can put into and any agent can fetch out of.
--
-- Everything else agents hand each other is text -- shared memories, project
-- files, peer messages -- and each of those tables holds its content in a
-- LONGTEXT column. This one deliberately does not. The bytes live on the
-- mounted DATA_ROOT volume at `transfers/<first two chars of id>/<id>`, and
-- these rows hold only metadata plus the path. Two reasons: base64 in LONGTEXT
-- costs a third more than the file it stores and is bounded by
-- `max_allowed_packet` rather than by anything the application chose, and a
-- transfer is the one artifact here that a human operator downloads, which
-- wants a stream and not a SELECT. The consequence to keep in mind is that a
-- row and its bytes can now disagree: see the sweep ordering below.
--
-- EVERY TRANSFER EXPIRES. `expires_at` is NOT NULL and has no sentinel for
-- "never" -- an agent must pass `ttl_seconds`, which the service clamps to an
-- operator-set maximum. This is not storage and must not become storage: a file
-- worth keeping belongs in a repository or a shared memory. The pool is
-- fleet-wide by design, so any agent that knows an id can fetch it; there is no
-- addressing and no recipient column, because handing the id over is the
-- uploader's job.
--
-- IDENTITY IS ASSERTED, NOT AUTHENTICATED. `uploaded_by` and `uploaded_from`
-- are whatever the caller said, exactly like `git_worktrees.username` and
-- `coord_project_cards`'s claim holder. `POST /mcp` authenticates a HOST, and
-- every agent on that box shares one API key, so the credential cannot tell two
-- agents apart. `source_host_id` is the only field here the orchestrator knows
-- first-hand. Treat the rest as provenance for a human reading the console.
--
-- Sweep ordering, which the service depends on: bytes are unlinked BEFORE the
-- row's status changes. A crash in between leaves a `live` row whose file is
-- already gone, which the next sweep retries harmlessly; the other order would
-- leave an `expired` row nobody will ever look at again guarding a file nothing
-- will ever delete. Same retry-token reasoning as closeFleetWindow() in
-- api/src/services/insecure-window-admin.ts.
--
-- Idempotency: two plain `CREATE TABLE IF NOT EXISTS` statements. Like 0025 and
-- 0026, and unlike 0003/0006, this needs no `information_schema` guard behind
-- `PREPARE`/`EXECUTE`, because every index below is inline in its CREATE and
-- expressible in schema.ts -- so a database built by `drizzle-kit push` or from
-- the generated baseline already has all of them. Those files carry guards only
-- for FULLTEXT indexes and foreign keys, which drizzle-orm's mysql-core cannot
-- express; neither table declares either.
--
-- No foreign keys, matching the git-director and agent-bus tables: referential
-- integrity is held in the service layer so a host row can be retired without
-- cascading into coordination state an operator may still want to read.

-- One uploaded file.
--
-- `status` is the lifecycle: `uploading` while a chunked put is still open,
-- `live` once sealed, `expired` once the deadline passed, `deleted` once an
-- operator or the uploader retired it early. Rows are never removed -- the
-- bytes are, and `purged_at` records when -- because agent_transfer_events
-- points here and an audit trail whose subject has been deleted is not one.
--
-- `content_sha256` is NULL until the transfer is sealed: it is computed over
-- the whole reassembled file, so a put that is still accepting chunks has
-- nothing honest to put there. `size_bytes` grows with each chunk and doubles
-- as the append offset, which is what makes a resumed upload verifiable.
--
-- `requested_ttl_seconds` keeps what the agent ASKED for, next to the
-- `expires_at` it actually got. When the two disagree the fleet clamped the
-- request, and an operator looking at a transfer that vanished sooner than its
-- uploader expected can see that here rather than inferring it.
CREATE TABLE IF NOT EXISTS agent_transfers (
    id CHAR(36) NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT NULL,
    mime_type VARCHAR(255) NULL,
    size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
    content_sha256 CHAR(64) NULL,
    storage_path VARCHAR(512) NOT NULL,
    status VARCHAR(32) NOT NULL,
    source_host_id BIGINT UNSIGNED NULL,
    uploaded_by VARCHAR(255) NULL,
    uploaded_from VARCHAR(512) NULL,
    requested_ttl_seconds INT UNSIGNED NULL,
    download_count INT UNSIGNED NOT NULL DEFAULT 0,
    expires_at VARCHAR(100) NOT NULL,
    sealed_at VARCHAR(100) NULL,
    purged_at VARCHAR(100) NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    INDEX idx_agent_transfers_expiry (status, expires_at),
    INDEX idx_agent_transfers_created_at (created_at),
    INDEX idx_agent_transfers_host (source_host_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only audit trail. The point of it is the `downloaded` rows: a
-- fleet-wide pool where knowing an id is sufficient to fetch has no access
-- control worth the name, so what it owes an operator instead is a record of
-- who actually took a copy.
--
-- `actor_kind` separates the three writers, because they are trusted
-- differently: `agent` is caller-asserted like the columns above, `admin` is a
-- real authenticated console user whose id goes in `actor_label`, and `system`
-- is the sweeper.
CREATE TABLE IF NOT EXISTS agent_transfer_events (
    id CHAR(36) NOT NULL PRIMARY KEY,
    transfer_id CHAR(36) NOT NULL,
    action VARCHAR(32) NOT NULL,
    actor_kind VARCHAR(16) NOT NULL,
    actor_label VARCHAR(255) NULL,
    source_host_id BIGINT UNSIGNED NULL,
    detail TEXT NULL,
    created_at VARCHAR(100) NOT NULL,
    INDEX idx_agent_transfer_events_transfer (transfer_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
