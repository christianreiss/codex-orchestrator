<?php

namespace App\Repositories;

use App\Database;

class LogRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function log(?int $hostId, string $action, array $details = []): void
    {
        $statement = $this->database->connection()->prepare(
            'INSERT INTO logs (host_id, action, details, created_at) VALUES (:host_id, :action, :details, :created_at)'
        );

        $statement->execute([
            'host_id' => $hostId,
            'action' => $action,
            'details' => $details ? json_encode($details, JSON_UNESCAPED_SLASHES) : null,
            'created_at' => gmdate(DATE_ATOM),
        ]);
    }
}
