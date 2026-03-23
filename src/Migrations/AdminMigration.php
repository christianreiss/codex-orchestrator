<?php

namespace App\Migrations;

use PDO;

class AdminMigration implements MigrationInterface
{
    public function up(PDO $pdo, string $databaseName, string $collation): void
    {
        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS admin_users (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                username VARCHAR(64) NOT NULL UNIQUE,
                email VARCHAR(255) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                access_level VARCHAR(32) NOT NULL,
                active TINYINT(1) NOT NULL DEFAULT 1,
                last_login_at VARCHAR(100) NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                INDEX idx_admin_users_access (access_level),
                INDEX idx_admin_users_active (active)
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS admin_sessions (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                user_id BIGINT UNSIGNED NOT NULL,
                token_hash CHAR(64) NOT NULL UNIQUE,
                ip VARCHAR(64) NULL,
                user_agent VARCHAR(255) NULL,
                created_at VARCHAR(100) NOT NULL,
                last_seen_at VARCHAR(100) NOT NULL,
                expires_at VARCHAR(100) NOT NULL,
                INDEX idx_admin_sessions_user (user_id),
                INDEX idx_admin_sessions_expires (expires_at),
                CONSTRAINT fk_admin_sessions_user FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS admin_password_resets (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                user_id BIGINT UNSIGNED NOT NULL,
                token_hash CHAR(64) NOT NULL UNIQUE,
                expires_at VARCHAR(100) NOT NULL,
                used_at VARCHAR(100) NULL,
                created_at VARCHAR(100) NOT NULL,
                INDEX idx_admin_password_resets_user (user_id),
                INDEX idx_admin_password_resets_expires (expires_at),
                CONSTRAINT fk_admin_password_resets_user FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS admin_passkeys (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                user_id BIGINT UNSIGNED NOT NULL,
                credential_id VARBINARY(1024) NOT NULL,
                credential_id_hash CHAR(64) NOT NULL UNIQUE,
                public_key_pem TEXT NOT NULL,
                cose_alg INT NOT NULL,
                sign_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
                name VARCHAR(255) NOT NULL DEFAULT '',
                transports VARCHAR(255) NULL,
                aaguid CHAR(36) NULL,
                created_at VARCHAR(100) NOT NULL,
                last_used_at VARCHAR(100) NULL,
                INDEX idx_admin_passkeys_user (user_id),
                CONSTRAINT fk_admin_passkeys_user FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS admin_webauthn_challenges (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                challenge CHAR(64) NOT NULL UNIQUE,
                user_id BIGINT UNSIGNED NULL,
                type VARCHAR(16) NOT NULL,
                expires_at VARCHAR(100) NOT NULL,
                created_at VARCHAR(100) NOT NULL,
                INDEX idx_admin_webauthn_challenges_expires (expires_at)
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS admin_events (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                type VARCHAR(64) NOT NULL,
                host_id BIGINT UNSIGNED NULL,
                payload JSON NULL,
                created_at VARCHAR(100) NOT NULL,
                INDEX idx_admin_events_host (host_id),
                INDEX idx_admin_events_type (type),
                INDEX idx_admin_events_created_at (created_at),
                CONSTRAINT fk_admin_events_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );
    }
}
