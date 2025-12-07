<?php

namespace App\Repositories;

use App\Database;
use PDO;

class McpAccessLogRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function log(
        ?int $hostId,
        ?string $clientIp,
        string $method,
        ?string $name,
        bool $success,
        ?int $errorCode,
        ?string $errorMessage
    ): void {
        $stmt = $this->database->connection()->prepare(
            'INSERT INTO mcp_access_logs (host_id, client_ip, method, name, success, error_code, error_message, created_at)
             VALUES (:host_id, :client_ip, :method, :name, :success, :error_code, :error_message, :created_at)'
        );

        $stmt->execute([
            'host_id' => $hostId,
            'client_ip' => $clientIp,
            'method' => $method,
            'name' => $name,
            'success' => $success ? 1 : 0,
            'error_code' => $errorCode,
            'error_message' => $errorMessage,
            'created_at' => gmdate(DATE_ATOM),
        ]);
    }

    public function recent(int $limit = 200): array
    {
        $limit = max(1, min(500, $limit));
        $stmt = $this->database->connection()->prepare(
            'SELECT id, host_id, client_ip, method, name, success, error_code, error_message, created_at
             FROM mcp_access_logs
             ORDER BY id DESC
             LIMIT :limit'
        );
        $stmt->bindValue('limit', $limit, PDO::PARAM_INT);
        $stmt->execute();

        return $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    }
}
