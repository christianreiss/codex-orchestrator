-- Project Board: cards as the unit of coordinated work, with claim/lease
-- semantics mirroring the Git Director (0025).
--
-- The board answers the question `coord_project_todos` cannot: who is working on
-- this right now, in what capacity, and is that agent still alive. A todo is a
-- checkbox; a card is a claim. Everything below exists to make that claim
-- reclaimable when the agent holding it dies, which is the failure mode a flat
-- list has no way to notice.
--
-- Card MOVEMENTS are not stored here. Every create, move, claim, release and
-- reclaim is a `coord_project_events` row with entity_type='card', which is the
-- same append-only per-project log `project_changes` already serves -- so an
-- agent polling for changes sees board activity without a second sync surface,
-- and the board needs no history table of its own. `entity_type`/`entity_id` are
-- VARCHAR(64), so the CHAR(36) ids below fit, and `listChanges` filters only on
-- `seq > since` with no entity allowlist to extend. This mirrors 0025's refusal
-- to add a lease table: the live claim on a card IS the card row, held by the
-- claim_* columns below with claim_released_at IS NULL and claim_expires_at in
-- the future.
--
-- Exclusivity: MySQL has no partial unique index, so a claim is made exclusive
-- by `SELECT ... FOR UPDATE` on the parent `coord_projects` row -- the same lock
-- the event-seq allocator already takes, and the pattern used everywhere else in
-- this codebase, which uses no advisory locks. Every card mutation therefore
-- serialises per project, and a card claim cannot race a card move. That shared
-- lock is also why the service must allocate its event seq through a
-- transaction-scoped recorder: an inner transaction would block on a different
-- pool connection until innodb_lock_wait_timeout. See project-board.ts.
--
-- Advisory, like everything else the orchestrator says about a machine it cannot
-- see. A role that does not match a column and a WIP limit that is exceeded do
-- not refuse the move; they attach an advisory to it and record it. The only
-- thing the board declines to do is record a claim someone else already holds,
-- which is a fact about this table rather than a restriction on the agent.
--
-- Idempotency: three plain `CREATE TABLE IF NOT EXISTS` plus `INSERT IGNORE`
-- backfills guarded by unique keys, and two UPDATEs that recompute rather than
-- accumulate. Like 0010 and 0025, and unlike 0003/0006, this needs no
-- `information_schema` guard behind `PREPARE`/`EXECUTE`, because every index
-- below is inline in its CREATE and expressible in schema.ts -- so a database
-- built by `drizzle-kit push` or from the generated baseline already has all of
-- them. Those files carry guards only for FULLTEXT indexes and foreign keys,
-- which drizzle-orm's mysql-core cannot express; none of these tables declares
-- either.
--
-- No foreign keys, matching the agent-bus and git-director tables: referential
-- integrity is held in the service layer so a project's cascade delete stays one
-- explicit ordered transaction rather than an implicit one.

-- One board per project today. `slug` is unique per project, so a second board
-- (a release board, a bug board) needs no migration -- only a row.
--
-- `next_card_number` allocates the human-readable per-project card number. It is
-- bumped under the same project row lock as the event seq, so it costs nothing
-- extra and cannot skip or collide.
--
-- `claim_ttl_seconds` NULL means "use the service default". Per-board override
-- exists because a board whose cards are hours of work wants a longer lease than
-- one whose cards are minutes, and that is a property of the work, not the fleet.
CREATE TABLE IF NOT EXISTS coord_project_boards (
    id CHAR(36) NOT NULL PRIMARY KEY,
    project_id BIGINT UNSIGNED NOT NULL,
    slug VARCHAR(64) NOT NULL DEFAULT 'default',
    title VARCHAR(255) NOT NULL,
    next_card_number BIGINT UNSIGNED NOT NULL DEFAULT 1,
    claim_ttl_seconds INT UNSIGNED NULL,
    archived_at VARCHAR(100) NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    UNIQUE KEY uq_coord_project_boards_slug (project_id, slug),
    INDEX idx_coord_project_boards_project (project_id, archived_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Columns are rows, not an enum in code: a fixed set would need a deploy to
-- reshape one project's pipeline, and `wip_limit`, `allowed_roles` and
-- `default_next_column_id` need somewhere to live that an operator can edit.
--
-- `column_key` rather than `key`, which is reserved in MySQL.
--
-- `allowed_roles` is the role -> column mapping and is ADVISORY. A move by an
-- agent whose declared role is not listed still happens; the response and the
-- recorded event carry the advisory, and a `logs` row records it. NULL means any
-- role, which is how the intake, terminal and blocked lanes stay open to
-- everyone. See the Git Director header for why enforcement the orchestrator
-- cannot observe is worse than advice it can log.
--
-- `default_next_column_id` is what makes `project_card_release` advance a card on
-- its own. Releasing without naming a column moves it here, so an agent that
-- finishes coding does not have to know that review comes next -- the board does.
-- NULL ends the chain, which is correct for the terminal and blocked lanes.
--
-- The three flags are not unique per board and MySQL cannot make them so without
-- a partial index. Two intake columns is an operator error, not a corruption:
-- the service resolves it by lowest `position` and keeps going.
CREATE TABLE IF NOT EXISTS coord_project_board_columns (
    id CHAR(36) NOT NULL PRIMARY KEY,
    board_id CHAR(36) NOT NULL,
    project_id BIGINT UNSIGNED NOT NULL,
    column_key VARCHAR(64) NOT NULL,
    title VARCHAR(255) NOT NULL,
    position INT UNSIGNED NOT NULL,
    wip_limit INT UNSIGNED NULL,
    allowed_roles JSON NULL,
    default_next_column_id CHAR(36) NULL,
    is_intake TINYINT NOT NULL DEFAULT 0,
    is_terminal TINYINT NOT NULL DEFAULT 0,
    is_blocked TINYINT NOT NULL DEFAULT 0,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    UNIQUE KEY uq_coord_project_board_columns_key (board_id, column_key),
    INDEX idx_coord_project_board_columns_order (board_id, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A card AND, when claimed, the claim itself.
--
-- `card_number` is a per-project integer alongside the UUID; every tool accepts
-- either. It is BIGINT UNSIGNED to match `coord_project_todos.id` exactly,
-- because the backfill below reuses todo ids as card numbers so that
-- `project_todo_done(4711)` keeps resolving to the same work item forever. Card
-- numbers are unique per project, not fleet-wide -- safe because every consumer
-- of a todo id already has the project slug in scope (the SPA reads `todo.id`
-- only inside the [slug] route, every REST path is /projects/:slug/todos/:id,
-- and every project.todo.* ws payload carries `slug` beside `todo_id`).
--
-- `claimed_agent_bus_address_id` is enrichment, never a requirement, exactly as
-- in git_worktrees: resolved by joining agent_bus_addresses on
-- (host_id, cwd_hash), which hands us liveness for free rather than inventing a
-- second heartbeat. With Agent Messaging off it stays NULL and the TTL is the
-- only reclaim signal -- the fallback, never the primary.
--
-- `claim_client_request_id` is the retry guard. MCP tool calls get retried and
-- models re-call tools on ambiguous results; without it a retry reads as a
-- second contender for a card the caller already holds. There is deliberately no
-- unique index on it: the claim lives ON the card, so the card row is already
-- the guard, and a project-wide unique key would instead turn a client that
-- reuses one id across two different cards into a spurious failure. It is
-- honoured only while the claim is live.
--
-- `source_todo_id` links a card backfilled from coord_project_todos and makes
-- that backfill idempotent. After this migration the todo tools write cards
-- through the shim in host-projects.ts, so it is provenance rather than a live
-- projection -- there is exactly one row per work item, never two to reconcile.
--
-- `entered_column_at` is the cycle-time signal and the tie-break for card order
-- within a column. There is no per-column dwell history here on purpose: it is
-- reconstructible from coord_project_events, which is a read-side concern.
CREATE TABLE IF NOT EXISTS coord_project_cards (
    id CHAR(36) NOT NULL PRIMARY KEY,
    project_id BIGINT UNSIGNED NOT NULL,
    board_id CHAR(36) NOT NULL,
    column_id CHAR(36) NOT NULL,
    card_number BIGINT UNSIGNED NOT NULL,
    title VARCHAR(255) NOT NULL,
    detail LONGTEXT NOT NULL,
    labels JSON NULL,
    priority INT NOT NULL DEFAULT 0,
    blocked_reason VARCHAR(500) NULL,
    source_todo_id BIGINT UNSIGNED NULL,
    created_by_host_id BIGINT UNSIGNED NULL,
    claim_role VARCHAR(32) NULL,
    claimed_by_host_id BIGINT UNSIGNED NULL,
    claimed_by_username VARCHAR(255) NULL,
    claimed_worktree_path VARCHAR(1024) NULL,
    claimed_worktree_hash CHAR(64) NULL,
    claimed_agent_bus_address_id CHAR(36) NULL,
    claim_client_request_id VARCHAR(191) NULL,
    claimed_at VARCHAR(100) NULL,
    claim_expires_at VARCHAR(100) NULL,
    claim_released_at VARCHAR(100) NULL,
    claim_release_reason VARCHAR(255) NULL,
    entered_column_at VARCHAR(100) NOT NULL,
    archived_at VARCHAR(100) NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    UNIQUE KEY uq_coord_project_cards_number (project_id, card_number),
    UNIQUE KEY uq_coord_project_cards_todo (project_id, source_todo_id),
    INDEX idx_coord_project_cards_column (column_id, priority, entered_column_at),
    INDEX idx_coord_project_cards_project (project_id, archived_at, updated_at),
    INDEX idx_coord_project_cards_claim (claimed_agent_bus_address_id, claim_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Backfill. Every statement below is `INSERT IGNORE` against a unique key or an
-- UPDATE that recomputes from current state, so re-applying this file is a
-- no-op -- which migrator.test.ts checks by applying every shipped file twice.
-- UUID() mints a fresh primary key on each attempt, so the unique key is the
-- only thing that can catch a repeat; that is why each INSERT has one.
--
-- Nothing here writes coord_project_events. Doing so from SQL would advance
-- `latest_event_seq` outside the service's row lock, and on a populated
-- deployment it would hand every `project_changes` poller a burst of several
-- hundred synthetic events the moment the container came up. Agents discover the
-- board through `project_board_list`, which needs no event to be visible.

-- One default board per existing project.
INSERT IGNORE INTO coord_project_boards
    (id, project_id, slug, title, next_card_number, claim_ttl_seconds,
     archived_at, created_at, updated_at)
SELECT UUID(), p.id, 'default', 'Board', 1, NULL, NULL,
       DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ'),
       DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ')
FROM coord_projects p;

-- The seven seeded columns. `ops` gets no lane of its own by design -- it is the
-- role that acts on the open ones (intake, done, blocked), where allowed_roles
-- is NULL. `default_next_column_id` is wired in a second pass below, once every
-- column has an id to point at.
INSERT IGNORE INTO coord_project_board_columns
    (id, board_id, project_id, column_key, title, position, wip_limit,
     allowed_roles, default_next_column_id, is_intake, is_terminal, is_blocked,
     created_at, updated_at)
SELECT UUID(), b.id, b.project_id, seed.column_key, seed.title, seed.position,
       NULL, seed.allowed_roles, NULL, seed.is_intake, seed.is_terminal,
       seed.is_blocked,
       DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ'),
       DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ')
FROM coord_project_boards b
JOIN (
    SELECT 'backlog'   AS column_key, 'Backlog'   AS title, 0 AS position, CAST(NULL AS JSON)      AS allowed_roles, 1 AS is_intake, 0 AS is_terminal, 0 AS is_blocked
    UNION ALL SELECT 'planning',  'Planning',  1, CAST('["plan"]'   AS JSON), 0, 0, 0
    UNION ALL SELECT 'coding',    'Coding',    2, CAST('["code"]'   AS JSON), 0, 0, 0
    UNION ALL SELECT 'review',    'Review',    3, CAST('["review"]' AS JSON), 0, 0, 0
    UNION ALL SELECT 'verifying', 'Verifying', 4, CAST('["verify"]' AS JSON), 0, 0, 0
    UNION ALL SELECT 'done',      'Done',      5, CAST(NULL AS JSON), 0, 1, 0
    UNION ALL SELECT 'blocked',   'Blocked',   6, CAST(NULL AS JSON), 0, 0, 1
) AS seed
WHERE b.slug = 'default';

-- Second pass: point each seeded column at its successor. Only fills columns
-- that have no successor yet, so an operator who has since re-pointed one keeps
-- their edit when this file is re-applied.
UPDATE coord_project_board_columns AS src
JOIN (
    SELECT 'backlog'   AS from_key, 'planning'  AS to_key
    UNION ALL SELECT 'planning',  'coding'
    UNION ALL SELECT 'coding',    'review'
    UNION ALL SELECT 'review',    'verifying'
    UNION ALL SELECT 'verifying', 'done'
) AS chain ON chain.from_key = src.column_key
JOIN coord_project_board_columns AS dst
  ON dst.board_id = src.board_id AND dst.column_key = chain.to_key
SET src.default_next_column_id = dst.id
WHERE src.default_next_column_id IS NULL;

-- Every todo becomes a card, keeping its id as the card number so that the
-- `project_todo_*` shim resolves the same integer to the same work item. A done
-- todo lands in the terminal lane, everything else in intake. `entered_column_at`
-- takes the todo's updated_at rather than now, so a board rendered straight after
-- the migration orders by when the work actually last moved.
INSERT IGNORE INTO coord_project_cards
    (id, project_id, board_id, column_id, card_number, title, detail,
     labels, priority, blocked_reason, source_todo_id, created_by_host_id,
     entered_column_at, archived_at, created_at, updated_at)
SELECT UUID(), t.project_id, b.id, c.id, t.id, t.title, t.detail,
       NULL, 0, NULL, t.id, t.source_host_id,
       t.updated_at, NULL, t.created_at, t.updated_at
FROM coord_project_todos t
JOIN coord_project_boards b
  ON b.project_id = t.project_id AND b.slug = 'default'
JOIN coord_project_board_columns c
  ON c.board_id = b.id
 AND c.column_key = IF(t.done = 1, 'done', 'backlog');

-- Recompute the allocator from what actually landed. Recomputed rather than
-- incremented, so this is safe on a re-run and safe after cards have been
-- created through the service.
UPDATE coord_project_boards b
SET b.next_card_number = (
    SELECT COALESCE(MAX(c.card_number), 0) + 1
    FROM coord_project_cards c
    WHERE c.board_id = b.id
);
