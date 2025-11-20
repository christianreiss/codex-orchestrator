<?php

namespace App\Repositories;

use App\Database;
use PDO;

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

    public function recent(int $limit = 50, ?int $hostId = null): array
    {
        $limit = max(1, min($limit, 500));
        $connection = $this->database->connection();

        if ($hostId !== null) {
            $statement = $connection->prepare(
                'SELECT id, host_id, action, details, created_at FROM logs WHERE host_id = :host_id ORDER BY created_at DESC, id DESC LIMIT :limit'
            );
            $statement->bindValue('host_id', $hostId, PDO::PARAM_INT);
        } else {
            $statement = $connection->prepare(
                'SELECT id, host_id, action, details, created_at FROM logs ORDER BY created_at DESC, id DESC LIMIT :limit'
            );
        }

        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        return is_array($rows) ? $rows : [];
    }

    public function latestCreatedAt(): ?string
    {
        $statement = $this->database->connection()->query(
            'SELECT created_at FROM logs ORDER BY created_at DESC, id DESC LIMIT 1'
        );

        $value = $statement->fetchColumn();

        return is_string($value) ? $value : null;
    }
}
