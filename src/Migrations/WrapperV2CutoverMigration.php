<?php

declare(strict_types=1);

namespace App\Migrations;

use PDO;

/**
 * The atomic-swap migration: makes wrapper v2 the default for every host.
 *
 *   - Backfill: every existing host with wrapper_track='legacy' becomes 'v2'.
 *   - Change the column default to 'v2' so new hosts boot on the new path.
 *
 * Idempotent: running twice is a no-op once all rows are already v2.
 */
class WrapperV2CutoverMigration implements MigrationInterface
{
    use MigrationHelper;

    public function up(PDO $pdo, string $databaseName, string $collation): void
    {
        if (!$this->columnExists($pdo, $databaseName, 'hosts', 'wrapper_track')) {
            // Foundation migration didn't run yet — bail out so we don't backfill
            // a column that doesn't exist.
            return;
        }

        $pdo->exec("UPDATE hosts SET wrapper_track = 'v2' WHERE wrapper_track IS NULL OR wrapper_track = '' OR wrapper_track = 'legacy'");
        // MariaDB / MySQL both accept this; ignore failure (e.g. SQLite in tests).
        try {
            $pdo->exec("ALTER TABLE hosts MODIFY COLUMN wrapper_track VARCHAR(16) NOT NULL DEFAULT 'v2'");
        } catch (\Throwable) {
            // best-effort: SQLite-based tests don't support MODIFY COLUMN
        }
    }
}
