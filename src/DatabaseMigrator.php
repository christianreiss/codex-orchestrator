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
use App\Migrations\ProjectMigration;
use App\Migrations\UsageMigration;
use PDO;

class DatabaseMigrator
{
    public function __construct(private readonly PDO $pdo, private readonly string $databaseName)
    {
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
        ];

        foreach ($migrations as $migration) {
            $migration->up($this->pdo, $this->databaseName, $collation);
        }
    }
}
