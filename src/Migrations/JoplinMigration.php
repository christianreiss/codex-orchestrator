<?php

declare(strict_types=1);

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Migrations;

use PDO;

class JoplinMigration implements MigrationInterface
{
    use MigrationHelper;

    public function up(PDO $pdo, string $databaseName, string $collation): void
    {
        $pdo->exec(<<<SQL
            CREATE TABLE IF NOT EXISTS joplin_notes_cache (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                joplin_id VARCHAR(32) NOT NULL,
                title VARCHAR(1000) NOT NULL DEFAULT '',
                body LONGTEXT NOT NULL DEFAULT '',
                notebook_id VARCHAR(32) NOT NULL DEFAULT '',
                tags_json JSON NULL,
                parent_id VARCHAR(32) NOT NULL DEFAULT '',
                synced_at VARCHAR(100) NOT NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                UNIQUE KEY uniq_joplin_notes_joplin_id (joplin_id),
                INDEX idx_joplin_notes_notebook (notebook_id),
                INDEX idx_joplin_notes_synced (synced_at),
                FULLTEXT INDEX idx_joplin_notes_search (title, body)
            ) ENGINE=InnoDB {$collation};
        SQL);
    }
}
