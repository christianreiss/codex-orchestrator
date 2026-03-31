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
use Throwable;

class AgentsRepository
{
    public const STATE_ID = 1;
    public const MODE_LATEST = 'latest';
    public const MODE_LOCKED = 'locked';

    public function __construct(private readonly Database $database)
    {
    }

    public function latest(): ?array
    {
        $statement = $this->database->connection()->query(
            'SELECT id, sha256, body, source_host_id, created_at, updated_at
             FROM agents_documents
             ORDER BY id DESC
             LIMIT 1'
        );

        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    public function findById(int $id): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, sha256, body, source_host_id, created_at, updated_at
             FROM agents_documents
             WHERE id = :id
             LIMIT 1'
        );
        $statement->execute(['id' => $id]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    public function listVersions(int $limit = 50): array
    {
        $limit = max(1, min($limit, 200));
        $statement = $this->database->connection()->prepare(
            'SELECT id, sha256, body, source_host_id, created_at, updated_at
             FROM agents_documents
             ORDER BY id DESC
             LIMIT :limit'
        );
        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        return is_array($rows) ? $rows : [];
    }

    public function createVersion(string $body, ?int $sourceHostId = null, ?string $sha256 = null): array
    {
        $now = gmdate(DATE_ATOM);
        $sha = $sha256 ?? hash('sha256', $body);

        $statement = $this->database->connection()->prepare(
            'INSERT INTO agents_documents (sha256, body, source_host_id, created_at, updated_at)
             VALUES (:sha256, :body, :source_host_id, :created_at, :updated_at)'
        );

        $statement->execute([
            'sha256' => $sha,
            'body' => $body,
            'source_host_id' => $sourceHostId,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        $id = (int) $this->database->connection()->lastInsertId();
        return $this->findById($id) ?? [];
    }

    public function createVersionWithRetention(string $body, ?int $sourceHostId = null, ?string $sha256 = null, ?int $backupLimit = null): array
    {
        $pdo = $this->database->connection();
        $now = gmdate(DATE_ATOM);
        $sha = $sha256 ?? hash('sha256', $body);

        $pdo->beginTransaction();

        try {
            $this->lockRetentionState($pdo, $now);

            $statement = $pdo->prepare(
                'INSERT INTO agents_documents (sha256, body, source_host_id, created_at, updated_at)
                 VALUES (:sha256, :body, :source_host_id, :created_at, :updated_at)'
            );
            $statement->execute([
                'sha256' => $sha,
                'body' => $body,
                'source_host_id' => $sourceHostId,
                'created_at' => $now,
                'updated_at' => $now,
            ]);

            $id = (int) $pdo->lastInsertId();
            $prunedIds = $this->pruneHistoricalVersionsLocked($pdo, $backupLimit);
            $pdo->commit();

            return [
                'row' => $this->findById($id) ?? [],
                'pruned_ids' => $prunedIds,
            ];
        } catch (Throwable $throwable) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }

            throw $throwable;
        }
    }

    public function storeVersionIfChanged(string $body, ?int $sourceHostId = null, ?string $sha256 = null): array
    {
        $pdo = $this->database->connection();
        $sha = $sha256 ?? hash('sha256', $body);
        $now = gmdate(DATE_ATOM);

        $pdo->beginTransaction();

        try {
            $this->lockRetentionState($pdo, $now);

            $latestStatement = $pdo->query(
                'SELECT id, sha256, body, source_host_id, created_at, updated_at
                 FROM agents_documents
                 ORDER BY id DESC
                 LIMIT 1
                 FOR UPDATE'
            );
            $latest = $latestStatement->fetch(PDO::FETCH_ASSOC);

            if (is_array($latest) && hash_equals((string) ($latest['sha256'] ?? ''), $sha)) {
                $pdo->commit();

                return [
                    'status' => 'unchanged',
                    'row' => $latest,
                    'pruned_ids' => [],
                ];
            }

            $statement = $pdo->prepare(
                'INSERT INTO agents_documents (sha256, body, source_host_id, created_at, updated_at)
                 VALUES (:sha256, :body, :source_host_id, :created_at, :updated_at)'
            );
            $statement->execute([
                'sha256' => $sha,
                'body' => $body,
                'source_host_id' => $sourceHostId,
                'created_at' => $now,
                'updated_at' => $now,
            ]);

            $id = (int) $pdo->lastInsertId();
            $prunedIds = $this->pruneHistoricalVersionsLocked($pdo, null);
            $pdo->commit();

            return [
                'status' => is_array($latest) ? 'updated' : 'created',
                'row' => $this->findById($id) ?? [],
                'pruned_ids' => $prunedIds,
            ];
        } catch (Throwable $throwable) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }

            throw $throwable;
        }
    }

    public function deleteVersion(int $id): bool
    {
        $statement = $this->database->connection()->prepare(
            'DELETE FROM agents_documents WHERE id = :id'
        );
        $statement->execute(['id' => $id]);

        return $statement->rowCount() > 0;
    }

    public function state(): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, mode, active_document_id, created_at, updated_at
             FROM agents_document_state
             WHERE id = :id
             LIMIT 1'
        );
        $statement->execute(['id' => self::STATE_ID]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);

        if (is_array($row)) {
            return $row;
        }

        $now = gmdate(DATE_ATOM);
        $insert = $this->database->connection()->prepare(
            'INSERT INTO agents_document_state (id, mode, active_document_id, created_at, updated_at)
             VALUES (:id, :mode, :active_document_id, :created_at, :updated_at)'
        );
        $insert->execute([
            'id' => self::STATE_ID,
            'mode' => self::MODE_LATEST,
            'active_document_id' => null,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        return [
            'id' => self::STATE_ID,
            'mode' => self::MODE_LATEST,
            'active_document_id' => null,
            'created_at' => $now,
            'updated_at' => $now,
        ];
    }

    public function updateState(string $mode, ?int $activeId): array
    {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'UPDATE agents_document_state
             SET mode = :mode, active_document_id = :active_document_id, updated_at = :updated_at
             WHERE id = :id'
        );
        $statement->execute([
            'mode' => $mode,
            'active_document_id' => $activeId,
            'updated_at' => $now,
            'id' => self::STATE_ID,
        ]);

        return $this->state();
    }

    public function storeVersionIfChangedWithRetention(string $body, ?int $sourceHostId = null, ?string $sha256 = null, ?int $backupLimit = null): array
    {
        $pdo = $this->database->connection();
        $sha = $sha256 ?? hash('sha256', $body);
        $now = gmdate(DATE_ATOM);

        $pdo->beginTransaction();

        try {
            $this->lockRetentionState($pdo, $now);

            $latestStatement = $pdo->query(
                'SELECT id, sha256, body, source_host_id, created_at, updated_at
                 FROM agents_documents
                 ORDER BY id DESC
                 LIMIT 1
                 FOR UPDATE'
            );
            $latest = $latestStatement->fetch(PDO::FETCH_ASSOC);

            if (is_array($latest) && hash_equals((string) ($latest['sha256'] ?? ''), $sha)) {
                $pdo->commit();

                return [
                    'status' => 'unchanged',
                    'row' => $latest,
                    'pruned_ids' => [],
                ];
            }

            $statement = $pdo->prepare(
                'INSERT INTO agents_documents (sha256, body, source_host_id, created_at, updated_at)
                 VALUES (:sha256, :body, :source_host_id, :created_at, :updated_at)'
            );
            $statement->execute([
                'sha256' => $sha,
                'body' => $body,
                'source_host_id' => $sourceHostId,
                'created_at' => $now,
                'updated_at' => $now,
            ]);

            $id = (int) $pdo->lastInsertId();
            $prunedIds = $this->pruneHistoricalVersionsLocked($pdo, $backupLimit);
            $pdo->commit();

            return [
                'status' => is_array($latest) ? 'updated' : 'created',
                'row' => $this->findById($id) ?? [],
                'pruned_ids' => $prunedIds,
            ];
        } catch (Throwable $throwable) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }

            throw $throwable;
        }
    }

    public function pruneHistoricalVersions(int $backupLimit): array
    {
        if ($backupLimit <= 0) {
            return [];
        }

        $pdo = $this->database->connection();
        $now = gmdate(DATE_ATOM);
        $pdo->beginTransaction();

        try {
            $this->lockRetentionState($pdo, $now);
            $prunedIds = $this->pruneHistoricalVersionsLocked($pdo, $backupLimit);
            $pdo->commit();

            return $prunedIds;
        } catch (Throwable $throwable) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }

            throw $throwable;
        }
    }

    private function lockRetentionState(PDO $pdo, string $now): void
    {
        $bootstrapState = $pdo->prepare(
            'INSERT INTO agents_document_state (id, mode, active_document_id, created_at, updated_at)
             VALUES (:id, :mode, :active_document_id, :created_at, :updated_at)
             ON DUPLICATE KEY UPDATE id = id'
        );
        $bootstrapState->execute([
            'id' => self::STATE_ID,
            'mode' => self::MODE_LATEST,
            'active_document_id' => null,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        $stateLock = $pdo->prepare(
            'SELECT id
             FROM agents_document_state
             WHERE id = :id
             LIMIT 1
             FOR UPDATE'
        );
        $stateLock->execute(['id' => self::STATE_ID]);
    }

    private function pruneHistoricalVersionsLocked(PDO $pdo, ?int $backupLimit): array
    {
        if ($backupLimit === null || $backupLimit <= 0) {
            return [];
        }

        $pdo->query('SELECT id FROM hosts FOR UPDATE')->fetchAll(PDO::FETCH_ASSOC);

        $versions = $pdo->query(
            'SELECT id
             FROM agents_documents
             ORDER BY id DESC
             FOR UPDATE'
        )->fetchAll(PDO::FETCH_ASSOC);

        if (!is_array($versions) || $versions === []) {
            return [];
        }

        $latestId = isset($versions[0]['id']) ? (int) $versions[0]['id'] : 0;
        if ($latestId <= 0) {
            return [];
        }

        $protected = [$latestId => true];
        $state = $pdo->prepare(
            'SELECT active_document_id
             FROM agents_document_state
             WHERE id = :id
             LIMIT 1
             FOR UPDATE'
        );
        $state->execute(['id' => self::STATE_ID]);
        $stateRow = $state->fetch(PDO::FETCH_ASSOC);
        $activeId = isset($stateRow['active_document_id']) && is_numeric($stateRow['active_document_id'])
            ? (int) $stateRow['active_document_id']
            : 0;
        if ($activeId > 0) {
            $protected[$activeId] = true;
        }

        $hostOverrides = $pdo->query(
            'SELECT DISTINCT agents_document_id_override
             FROM hosts
             WHERE agents_document_id_override IS NOT NULL'
        )->fetchAll(PDO::FETCH_COLUMN);
        if (is_array($hostOverrides)) {
            foreach ($hostOverrides as $overrideId) {
                if (is_numeric($overrideId) && (int) $overrideId > 0) {
                    $protected[(int) $overrideId] = true;
                }
            }
        }

        $deleteIds = [];
        $keptBackups = 0;
        foreach ($versions as $row) {
            $id = isset($row['id']) ? (int) $row['id'] : 0;
            if ($id <= 0 || isset($protected[$id])) {
                continue;
            }

            if ($keptBackups < $backupLimit) {
                $keptBackups++;
                continue;
            }

            $deleteIds[] = $id;
        }

        if ($deleteIds === []) {
            return [];
        }

        $placeholders = [];
        $params = [];
        foreach (array_values($deleteIds) as $index => $id) {
            $key = ':id' . $index;
            $placeholders[] = $key;
            $params[$key] = $id;
        }

        $statement = $pdo->prepare(
            'DELETE FROM agents_documents
             WHERE id IN (' . implode(', ', $placeholders) . ')'
        );
        foreach ($params as $key => $value) {
            $statement->bindValue($key, $value, PDO::PARAM_INT);
        }
        $statement->execute();

        return $deleteIds;
    }
}
