<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Repositories;

use App\Database;
use PDO;

class LogRepository
{
    public function __construct(
        private readonly Database $database,
        private readonly ?AdminEventRepository $events = null
    )
    {
    }

    public function log(?int $hostId, string $action, array $details = []): void
    {
        $createdAt = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'INSERT INTO logs (host_id, action, details, created_at) VALUES (:host_id, :action, :details, :created_at)'
        );

        $statement->execute([
            'host_id' => $hostId,
            'action' => $action,
            'details' => $details ? json_encode($details, JSON_UNESCAPED_SLASHES) : null,
            'created_at' => $createdAt,
        ]);

        if ($this->events === null) {
            return;
        }

        try {
            $logId = (int) $this->database->connection()->lastInsertId();
            $this->events->append('log.created', [
                'id' => $logId,
                'host_id' => $hostId,
                'action' => $action,
                'details' => $details,
                'created_at' => $createdAt,
            ], $hostId);
        } catch (\Throwable) {
            // Best-effort only; log writes should never fail because of websocket events.
        }

        if ($action !== 'auth.retrieve') {
            return;
        }

        try {
            $fqdn = $details['fqdn'] ?? null;
            $label = is_string($fqdn) && trim($fqdn) !== ''
                ? trim($fqdn)
                : ($hostId !== null ? 'host #' . $hostId : 'host');
            $status = $details['status'] ?? null;
            $statusLabel = is_string($status) && trim($status) !== '' ? ' (' . trim($status) . ')' : '';

            $this->events->append('toast', [
                'title' => 'CDX authorized',
                'message' => $label . $statusLabel,
                'level' => 'success',
                'timeout_ms' => 4500,
            ], $hostId);
        } catch (\Throwable) {
            // Best-effort only; toast failures should not block logging.
        }
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

    public function recentByActions(array $actions, int $limit = 20): array
    {
        $actions = array_values(array_filter($actions, static fn ($a) => is_string($a) && $a !== ''));
        if (!$actions) {
            return [];
        }

        $limit = max(1, min($limit, 200));
        $placeholders = [];
        $params = [];
        foreach ($actions as $idx => $action) {
            $key = 'action' . $idx;
            $placeholders[] = ':' . $key;
            $params[$key] = $action;
        }

        $statement = $this->database->connection()->prepare(
            'SELECT id, host_id, action, details, created_at
             FROM logs
             WHERE action IN (' . implode(',', $placeholders) . ')
             ORDER BY created_at DESC, id DESC
             LIMIT :limit'
        );

        foreach ($params as $key => $value) {
            $statement->bindValue($key, $value);
        }
        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        return is_array($rows) ? $rows : [];
    }

    public function countActionsSince(array $actions, string $since): int
    {
        $actions = array_values(array_filter($actions, static fn ($a) => is_string($a) && $a !== ''));
        if (!$actions || trim($since) === '') {
            return 0;
        }

        $placeholders = [];
        $params = [];
        foreach ($actions as $idx => $action) {
            $key = 'action' . $idx;
            $placeholders[] = ':' . $key;
            $params[$key] = $action;
        }
        $statement = $this->database->connection()->prepare(
            'SELECT COUNT(*) FROM logs WHERE action IN (' . implode(',', $placeholders) . ') AND created_at >= :since'
        );
        foreach ($params as $key => $value) {
            $statement->bindValue($key, $value);
        }
        $statement->bindValue('since', $since);
        $statement->execute();

        $count = $statement->fetchColumn();

        return is_numeric($count) ? (int) $count : 0;
    }
}
