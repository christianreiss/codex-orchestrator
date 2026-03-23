<?php

namespace App\Migrations;

use PDO;

class ProjectMigration implements MigrationInterface
{
    public function up(PDO $pdo, string $databaseName, string $collation): void
    {
        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS coord_projects (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                slug VARCHAR(255) NOT NULL UNIQUE,
                about_json JSON NULL,
                roster_markdown LONGTEXT NULL,
                latest_event_seq BIGINT UNSIGNED NOT NULL DEFAULT 0,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                archived_at VARCHAR(100) NULL,
                INDEX idx_coord_projects_updated_at (updated_at),
                INDEX idx_coord_projects_archived_at (archived_at)
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS coord_project_notes (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                project_id BIGINT UNSIGNED NOT NULL,
                header VARCHAR(255) NOT NULL,
                body LONGTEXT NOT NULL,
                source_host_id BIGINT UNSIGNED NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                INDEX idx_coord_project_notes_project (project_id),
                INDEX idx_coord_project_notes_updated_at (updated_at),
                CONSTRAINT fk_coord_project_notes_project FOREIGN KEY (project_id) REFERENCES coord_projects(id) ON DELETE CASCADE,
                CONSTRAINT fk_coord_project_notes_host FOREIGN KEY (source_host_id) REFERENCES hosts(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS coord_project_todos (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                project_id BIGINT UNSIGNED NOT NULL,
                title VARCHAR(255) NOT NULL,
                detail LONGTEXT NOT NULL,
                done TINYINT(1) NOT NULL DEFAULT 0,
                done_at VARCHAR(100) NULL,
                source_host_id BIGINT UNSIGNED NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                INDEX idx_coord_project_todos_project (project_id),
                INDEX idx_coord_project_todos_updated_at (updated_at),
                INDEX idx_coord_project_todos_done (done),
                CONSTRAINT fk_coord_project_todos_project FOREIGN KEY (project_id) REFERENCES coord_projects(id) ON DELETE CASCADE,
                CONSTRAINT fk_coord_project_todos_host FOREIGN KEY (source_host_id) REFERENCES hosts(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS coord_project_files (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                project_id BIGINT UNSIGNED NOT NULL,
                stored_name VARCHAR(255) NOT NULL,
                description TEXT NULL,
                content LONGTEXT NOT NULL,
                content_sha256 CHAR(64) NOT NULL,
                mime_type VARCHAR(255) NULL,
                source_host_id BIGINT UNSIGNED NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                UNIQUE KEY uniq_coord_project_file_name (project_id, stored_name),
                INDEX idx_coord_project_files_project (project_id),
                INDEX idx_coord_project_files_updated_at (updated_at),
                CONSTRAINT fk_coord_project_files_project FOREIGN KEY (project_id) REFERENCES coord_projects(id) ON DELETE CASCADE,
                CONSTRAINT fk_coord_project_files_host FOREIGN KEY (source_host_id) REFERENCES hosts(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS coord_project_feedback (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                project_id BIGINT UNSIGNED NOT NULL,
                type VARCHAR(32) NOT NULL,
                title VARCHAR(255) NOT NULL,
                body LONGTEXT NOT NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'open',
                source_host_id BIGINT UNSIGNED NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                INDEX idx_coord_project_feedback_project (project_id),
                INDEX idx_coord_project_feedback_updated_at (updated_at),
                CONSTRAINT fk_coord_project_feedback_project FOREIGN KEY (project_id) REFERENCES coord_projects(id) ON DELETE CASCADE,
                CONSTRAINT fk_coord_project_feedback_host FOREIGN KEY (source_host_id) REFERENCES hosts(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS coord_project_events (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                project_id BIGINT UNSIGNED NOT NULL,
                seq BIGINT UNSIGNED NOT NULL,
                event_type VARCHAR(64) NOT NULL,
                action VARCHAR(64) NOT NULL,
                entity_type VARCHAR(64) NULL,
                entity_id VARCHAR(64) NULL,
                payload_json JSON NULL,
                source_host_id BIGINT UNSIGNED NULL,
                created_at VARCHAR(100) NOT NULL,
                UNIQUE KEY uniq_coord_project_event_seq (project_id, seq),
                INDEX idx_coord_project_events_project (project_id),
                INDEX idx_coord_project_events_created_at (created_at),
                CONSTRAINT fk_coord_project_events_project FOREIGN KEY (project_id) REFERENCES coord_projects(id) ON DELETE CASCADE,
                CONSTRAINT fk_coord_project_events_host FOREIGN KEY (source_host_id) REFERENCES hosts(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );
    }
}
