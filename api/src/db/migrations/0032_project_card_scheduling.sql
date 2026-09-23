-- Give a card a date and an order.
--
-- `coord_project_cards` carries labels, priority and a blocked reason, but
-- nothing that says WHEN a piece of work is due or WHAT it waits on. On the
-- live `dns_switch_work` board, card 5's detail begins "Noch nicht begonnen;
-- abhängig von Resolver/HA-, Netzwerk- und Puppet-Vorbereitung" — a dependency
-- on cards 2, 3 and 4 that exists only as prose, so nothing can act on it and
-- nothing notices when it is satisfied. A cutover is calendar-driven and
-- ordered; both facts lived in a text field.
--
-- `due_at` is VARCHAR(100) holding an RFC3339 instant, matching every other
-- timestamp in this schema (the service writes them through `nowIso()`), and is
-- indexed with `project_id` because "what is due next on this project" is the
-- only question anybody asks of it.
--
-- `coord_project_card_deps` is an edge table rather than a JSON column on the
-- card, because the interesting query runs the other way — "what is waiting on
-- this card" — and because a unique key is what stops the same edge being
-- recorded twice. It declares no foreign keys, matching the choice 0026 made
-- for the board tables and states its reasons for: referential integrity is
-- held in the service layer alongside every other board invariant. Deleting a
-- card deletes its edges there.
--
-- Cycles are refused by the service, not by the schema — SQL cannot express it,
-- and the error needs to name the chain to be worth anything.
--
-- Idempotent via information_schema guards behind PREPARE/EXECUTE: MySQL has no
-- `ADD COLUMN IF NOT EXISTS`, and the runner re-applies every shipped file
-- against an already-migrated schema.

SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'coord_project_cards'
      AND COLUMN_NAME = 'due_at'
);
SET @ddl := IF(
    @col_exists = 0,
    'ALTER TABLE coord_project_cards ADD COLUMN due_at VARCHAR(100) NULL AFTER blocked_reason',
    'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'coord_project_cards'
      AND INDEX_NAME = 'idx_coord_project_cards_due'
);
SET @ddl := IF(
    @idx_exists = 0,
    'ALTER TABLE coord_project_cards ADD INDEX idx_coord_project_cards_due (project_id, due_at)',
    'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS coord_project_card_deps (
    id CHAR(36) NOT NULL,
    project_id BIGINT UNSIGNED NOT NULL,
    card_id CHAR(36) NOT NULL,
    depends_on_card_id CHAR(36) NOT NULL,
    created_at VARCHAR(100) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_coord_project_card_deps_edge (card_id, depends_on_card_id),
    KEY idx_coord_project_card_deps_card (card_id),
    KEY idx_coord_project_card_deps_depends (depends_on_card_id),
    KEY idx_coord_project_card_deps_project (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
