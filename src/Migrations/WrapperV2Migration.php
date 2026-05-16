<?php

declare(strict_types=1);

namespace App\Migrations;

use PDO;

/**
 * Wrapper bakery v2 schema additions:
 *  - hosts.config_version  — bumped any time the baked config for a host changes
 *  - hosts.config_baked_at — last bake timestamp (informational)
 *  - hosts.wrapper_track   — legacy|v2; canary toggle per host
 *  - wrapper_signing_keys  — Ed25519 keypair index (active flag for rotation)
 *  - wrapper_v2_binaries   — published binary inventory per engine/os/arch/version
 *
 * Default wrapper_track stays 'legacy' until the cutover commit; existing live
 * hosts continue running against the v1 bakery.
 */
class WrapperV2Migration implements MigrationInterface
{
    use MigrationHelper;

    public function up(PDO $pdo, string $databaseName, string $collation): void
    {
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'config_version', "BIGINT UNSIGNED NOT NULL DEFAULT 0");
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'config_baked_at', "VARCHAR(40) NULL");
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'wrapper_track', "VARCHAR(16) NOT NULL DEFAULT 'legacy'");
        $this->ensureIndexExists($pdo, $databaseName, 'hosts', 'idx_hosts_wrapper_track', 'INDEX idx_hosts_wrapper_track (wrapper_track)');

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS wrapper_signing_keys (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                algo VARCHAR(32) NOT NULL DEFAULT 'ed25519',
                public_key TEXT NOT NULL,
                private_key_enc LONGTEXT NULL,
                active TINYINT(1) NOT NULL DEFAULT 1,
                created_at VARCHAR(40) NOT NULL,
                rotated_at VARCHAR(40) NULL,
                INDEX idx_wrapper_signing_keys_active (active)
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS wrapper_v2_binaries (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                engine VARCHAR(16) NOT NULL,
                os VARCHAR(32) NOT NULL,
                arch VARCHAR(32) NOT NULL,
                version VARCHAR(64) NOT NULL,
                sha256 CHAR(64) NOT NULL,
                size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
                signature TEXT NULL,
                published_at VARCHAR(40) NOT NULL,
                uploaded_by VARCHAR(255) NULL,
                UNIQUE KEY uniq_v2_bin_target (engine, os, arch, version),
                INDEX idx_v2_bin_engine_version (engine, version)
            ) ENGINE=InnoDB {$collation};
            SQL
        );
    }
}
