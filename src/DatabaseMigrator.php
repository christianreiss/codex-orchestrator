<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App;

use App\Migrations\AdminMigration;
use App\Migrations\AuthMigration;
use App\Migrations\ContentMigration;
use App\Migrations\HostMigration;
use App\Migrations\InfrastructureMigration;
use App\Migrations\InsecureMigration;
use App\Migrations\MigrationInterface;
use App\Migrations\OpenaiApiMigration;
use App\Migrations\ProjectMigration;
use App\Migrations\UsageMigration;
use PDO;

class DatabaseMigrator
{
    public function __construct(private readonly PDO $pdo, private readonly string $databaseName)
    {
    }

    public static function schemaFingerprint(string $root): string
    {
        $paths = [
            $root . '/src/Database.php',
            $root . '/src/DatabaseMigrator.php',
        ];

        foreach (glob($root . '/src/Migrations/*.php') ?: [] as $path) {
            if (is_string($path)) {
                $paths[] = $path;
            }
        }

        $hash = hash_init('sha256');
        foreach ($paths as $path) {
            if (!is_file($path)) {
                continue;
            }

            $data = @file_get_contents($path);
            if (!is_string($data)) {
                continue;
            }

            hash_update($hash, $path);
            hash_update($hash, "\n");
            hash_update($hash, $data);
            hash_update($hash, "\n");
        }

        return hash_final($hash);
    }

    public function migrate(): void
    {
        $collation = 'DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

        /** @var MigrationInterface[] $migrations */
        $migrations = [
            new HostMigration(),
            new AuthMigration(),
            new ContentMigration(),
            new ProjectMigration(),
            new AdminMigration(),
            new InsecureMigration(),
            new UsageMigration(),
            new InfrastructureMigration(),
            new OpenaiApiMigration(),
        ];

        foreach ($migrations as $migration) {
            $migration->up($this->pdo, $this->databaseName, $collation);
        }
    }
}
