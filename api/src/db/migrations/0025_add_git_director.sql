-- Git Director: a registry of who is working in which clone, plus an advisory
-- merge arbiter over shared branches.
--
-- The orchestrator never touches a worktree. It has no filesystem access to any
-- host, so it cannot merge, cannot read an index, and cannot verify that an
-- agent did what it said. Every git fact in these tables is REPORTED by the
-- agent that owns the worktree. That is a deliberate trade: the feature is
-- advisory, and an agent willing to fabricate its own diff was already willing
-- to ignore the verdict.
--
-- Arbitration unit is the CLONE ON A HOST, keyed by `git rev-parse
-- --git-common-dir`, which collapses every linked worktree of one checkout to a
-- single id. That is the contention that actually exists: four worktrees off one
-- clone racing to merge into the same branch. Clones are GROUPED across hosts by
-- normalized remote URL for visibility only -- a local merge on one host must
-- never block a different machine.
--
-- Idempotency: three plain `CREATE TABLE IF NOT EXISTS` statements. Like 0010
-- and unlike 0003/0006 this needs no `information_schema` guard behind
-- `PREPARE`/`EXECUTE`, because every index below is inline in its CREATE and
-- expressible in schema.ts -- so a database built by `drizzle-kit push` or from
-- the generated baseline already has all of them. Those files carry guards only
-- for FULLTEXT indexes and foreign keys, which drizzle-orm's mysql-core cannot
-- express; none of these tables declares either.
--
-- No foreign keys, matching the agent-bus tables: referential integrity is held
-- in the service layer so a host row can be retired without cascading into
-- coordination state an operator may still want to read.

-- One physical clone on one host. `clone_key` is sha256 of the realpath'd
-- `--git-common-dir`, so `/repo/.git` and `/repo/.git/worktrees/wt-1`'s common
-- dir both hash to the same value and land on this row.
--
-- `remote_key` is sha256 of the NORMALIZED remote (scheme, userinfo, trailing
-- `.git` and trailing slash stripped, host lowercased) so `git@host:org/repo.git`
-- and `https://host/org/repo` group together. Un-normalized it would silently
-- never group, which is an invisible failure -- see normalizeRemote() and its
-- unit test in api/src/services/git-director.ts.
CREATE TABLE IF NOT EXISTS git_clones (
    id CHAR(36) NOT NULL PRIMARY KEY,
    host_id BIGINT UNSIGNED NOT NULL,
    clone_key CHAR(64) NOT NULL,
    clone_dir VARCHAR(1024) NOT NULL,
    repo_root VARCHAR(1024) NOT NULL,
    remote_url VARCHAR(1024) NULL,
    remote_key CHAR(64) NULL,
    default_branch VARCHAR(255) NULL,
    first_seen_at VARCHAR(100) NOT NULL,
    last_seen_at VARCHAR(100) NOT NULL,
    archived_at VARCHAR(100) NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    UNIQUE KEY uq_git_clones_host_clone (host_id, clone_key),
    INDEX idx_git_clones_remote (remote_key),
    INDEX idx_git_clones_host (host_id, archived_at, last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One registered worktree. The actor identity is the worktree PATH, not the
-- credential: `POST /mcp` authenticates a host, and every agent on that box
-- shares one API key, so the credential cannot tell two worktrees apart.
--
-- `agent_bus_address_id` is enrichment, never a requirement. When Agent
-- Messaging is on it is resolved by joining agent_bus_addresses on
-- (host_id, cwd_hash), which hands us engine/readiness/liveness for free rather
-- than inventing a second heartbeat. With Agent Messaging off it stays NULL and
-- everything still works.
--
-- `expires_at` is load-bearing. Agents die mid-session constantly; without a TTL
-- the first crashed one wedges its clone forever and the feature gets switched
-- off. Expiry is swept on read (see sweepExpired), matching the call-PIN sweep
-- in agent-messaging.ts rather than adding a cron.
CREATE TABLE IF NOT EXISTS git_worktrees (
    id CHAR(36) NOT NULL PRIMARY KEY,
    clone_id CHAR(36) NOT NULL,
    host_id BIGINT UNSIGNED NOT NULL,
    worktree_path VARCHAR(1024) NOT NULL,
    worktree_hash CHAR(64) NOT NULL,
    username VARCHAR(255) NOT NULL,
    engine VARCHAR(16) NULL,
    agent_bus_address_id CHAR(36) NULL,
    branch VARCHAR(255) NULL,
    head_sha VARCHAR(64) NULL,
    task TEXT NULL,
    declared_paths JSON NULL,
    target_branch VARCHAR(255) NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    registered_at VARCHAR(100) NOT NULL,
    heartbeat_at VARCHAR(100) NOT NULL,
    expires_at VARCHAR(100) NOT NULL,
    released_at VARCHAR(100) NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    UNIQUE KEY uq_git_worktrees_clone_path (clone_id, worktree_hash),
    INDEX idx_git_worktrees_clone (clone_id, status, expires_at),
    INDEX idx_git_worktrees_address (agent_bus_address_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A merge request AND, when granted, the lease itself. There is deliberately no
-- separate lease table: the live lease on (clone_id, target_branch) is the row
-- here with verdict='allow', completed_at IS NULL and lease_expires_at in the
-- future. MySQL has no partial unique index, so exclusivity is held by a
-- `SELECT ... FOR UPDATE` transaction on the clone row -- the pattern used
-- everywhere else in this codebase, which uses no advisory locks.
--
-- `uq_git_merge_requests_client` is the retry guard. MCP tool calls get retried
-- and models re-call tools on ambiguous results; without it a retry mints a
-- second queued row for the same worktree, inflating queue depth and showing the
-- arbiter a contender that does not exist. Same fix agent_bus_messages carries
-- as uq_agent_bus_messages_sender_client.
--
-- `decided_by` distinguishes 'policy' (deterministic: the uncontended fast path,
-- or the fallback when no model is reachable), 'llm' (a model judged a genuine
-- contention) and 'operator' (forced from the console). A verdict whose reason
-- cannot be reproduced is still auditable because the reason is stored here.
CREATE TABLE IF NOT EXISTS git_merge_requests (
    id CHAR(36) NOT NULL PRIMARY KEY,
    clone_id CHAR(36) NOT NULL,
    worktree_id CHAR(36) NOT NULL,
    client_request_id VARCHAR(191) NOT NULL,
    target_branch VARCHAR(255) NOT NULL,
    base_sha VARCHAR(64) NULL,
    head_sha VARCHAR(64) NULL,
    changed_paths JSON NULL,
    verdict VARCHAR(16) NOT NULL,
    decided_by VARCHAR(16) NOT NULL,
    reason TEXT NULL,
    overlap JSON NULL,
    holder_worktree_id CHAR(36) NULL,
    model VARCHAR(128) NULL,
    lease_expires_at VARCHAR(100) NULL,
    requested_at VARCHAR(100) NOT NULL,
    decided_at VARCHAR(100) NOT NULL,
    renewed_at VARCHAR(100) NULL,
    completed_at VARCHAR(100) NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    UNIQUE KEY uq_git_merge_requests_client (worktree_id, client_request_id),
    INDEX idx_git_merge_requests_lease (clone_id, target_branch, verdict, completed_at),
    INDEX idx_git_merge_requests_worktree (worktree_id, requested_at),
    INDEX idx_git_merge_requests_recent (clone_id, requested_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
