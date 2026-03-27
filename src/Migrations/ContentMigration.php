<?php

namespace App\Migrations;

use PDO;

class ContentMigration implements MigrationInterface
{
    use MigrationHelper;

    public function up(PDO $pdo, string $databaseName, string $collation): void
    {
        $pdo->exec(
            <<<SQL
            DROP TABLE IF EXISTS slash_commands;
            SQL
        );

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS skills (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                slug VARCHAR(255) NOT NULL UNIQUE,
                sha256 CHAR(64) NOT NULL,
                display_name VARCHAR(255) NULL,
                description TEXT NULL,
                manifest LONGTEXT NOT NULL,
                source_host_id BIGINT UNSIGNED NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                deleted_at VARCHAR(100) NULL,
                INDEX idx_skills_updated_at (updated_at),
                CONSTRAINT fk_skills_host FOREIGN KEY (source_host_id) REFERENCES hosts(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS agents_documents (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                sha256 CHAR(64) NOT NULL,
                body LONGTEXT NOT NULL,
                source_host_id BIGINT UNSIGNED NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                INDEX idx_agents_documents_updated_at (updated_at),
                CONSTRAINT fk_agents_documents_host FOREIGN KEY (source_host_id) REFERENCES hosts(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS agents_document_state (
                id TINYINT UNSIGNED PRIMARY KEY,
                mode VARCHAR(16) NOT NULL,
                active_document_id BIGINT UNSIGNED NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                INDEX idx_agents_document_state_updated_at (updated_at),
                CONSTRAINT fk_agents_document_state_active FOREIGN KEY (active_document_id) REFERENCES agents_documents(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS client_config_documents (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                sha256 CHAR(64) NOT NULL,
                body LONGTEXT NOT NULL,
                settings JSON NULL,
                source_host_id BIGINT UNSIGNED NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                INDEX idx_client_config_documents_updated_at (updated_at),
                CONSTRAINT fk_client_config_documents_host FOREIGN KEY (source_host_id) REFERENCES hosts(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS mcp_memories (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                host_id BIGINT UNSIGNED NOT NULL,
                memory_key VARCHAR(128) NOT NULL,
                content LONGTEXT NOT NULL,
                metadata JSON NULL,
                tags JSON NULL,
                tags_text TEXT NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                deleted_at VARCHAR(100) NULL,
                UNIQUE KEY uniq_memories_host_key (host_id, memory_key),
                INDEX idx_memories_host (host_id),
                FULLTEXT INDEX idx_memories_search (content, tags_text),
                CONSTRAINT fk_memories_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        // Backfill columns.
        $this->ensureColumnExists($pdo, $databaseName, 'skills', 'deleted_at', 'VARCHAR(100) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'agents_documents', 'source_host_id', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'client_config_documents', 'settings', 'JSON NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'client_config_documents', 'source_host_id', 'BIGINT UNSIGNED NULL');
    }
}
