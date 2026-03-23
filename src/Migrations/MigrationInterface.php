<?php

namespace App\Migrations;

use PDO;

interface MigrationInterface
{
    public function up(PDO $pdo, string $databaseName, string $collation): void;
}
