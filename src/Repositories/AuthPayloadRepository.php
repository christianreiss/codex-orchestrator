<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Repositories;

use App\Database;
use App\Security\SecretBox;
use App\Support\Engine;
use PDO;

class AuthPayloadRepository
{
    public function __construct(
        private readonly Database $database,
        private readonly AuthEntryRepository $entries,
        private readonly SecretBox $encrypter
    ) {
    }

    public const STATE_PENDING = 'pending';
    public const STATE_VERIFIED = 'verified';
    public const STATE_REJECTED = 'rejected';

    public function create(
        string $lastRefresh,
        string $sha256,
        ?int $sourceHostId,
        array $entries,
        ?string $extrasJson = null,
        string $engine = Engine::DEFAULT,
        string $verificationState = self::STATE_PENDING
    ): array
    {
        $statement = $this->database->connection()->prepare(
            'INSERT INTO auth_payloads (last_refresh, sha256, source_host_id, body, engine, verification_state, created_at)
             VALUES (:last_refresh, :sha256, :source_host_id, :body, :engine, :verification_state, :created_at)'
        );

        $statement->execute([
            'last_refresh' => $lastRefresh,
            'sha256' => $sha256,
            'source_host_id' => $sourceHostId,
            'body' => $extrasJson !== null ? $this->encrypter->encrypt($extrasJson) : null,
            'engine' => Engine::validate($engine),
            'verification_state' => self::normalizeState($verificationState),
            'created_at' => gmdate(DATE_ATOM),
        ]);

        $id = (int) $this->database->connection()->lastInsertId();
        $this->entries->replaceEntries($id, $entries);

        return $this->findByIdWithEntries($id);
    }

    public function markVerified(int $id, ?string $reason = null): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE auth_payloads
                SET verification_state = :state,
                    verification_checked_at = :checked_at,
                    verification_reason = :reason
              WHERE id = :id'
        );
        $statement->execute([
            'state' => self::STATE_VERIFIED,
            'checked_at' => gmdate(DATE_ATOM),
            'reason' => $reason,
            'id' => $id,
        ]);
    }

    public function markRejected(int $id, ?string $reason = null): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE auth_payloads
                SET verification_state = :state,
                    verification_checked_at = :checked_at,
                    verification_reason = :reason
              WHERE id = :id'
        );
        $statement->execute([
            'state' => self::STATE_REJECTED,
            'checked_at' => gmdate(DATE_ATOM),
            'reason' => $reason !== null ? substr($reason, 0, 500) : null,
            'id' => $id,
        ]);
    }

    public function latestPending(string $engine = Engine::DEFAULT): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, last_refresh, sha256, source_host_id, body, engine, verification_state, created_at
             FROM auth_payloads
             WHERE engine = :engine AND verification_state = :state
             ORDER BY created_at DESC, id DESC
             LIMIT 1'
        );
        $statement->execute([
            'engine' => Engine::validate($engine),
            'state' => self::STATE_PENDING,
        ]);
        $payload = $statement->fetch(PDO::FETCH_ASSOC);
        if (!$payload) {
            return null;
        }

        $payload['body'] = $this->decryptBody($payload['body'] ?? null);
        $payload['entries'] = $this->entries->listByPayload((int) $payload['id']);

        return $payload;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function allPending(string $engine = Engine::DEFAULT): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, last_refresh, sha256, source_host_id, body, engine, verification_state, created_at
             FROM auth_payloads
             WHERE engine = :engine AND verification_state = :state
             ORDER BY created_at ASC, id ASC'
        );
        $statement->execute([
            'engine' => Engine::validate($engine),
            'state' => self::STATE_PENDING,
        ]);
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC) ?: [];

        $out = [];
        foreach ($rows as $row) {
            $row['body'] = $this->decryptBody($row['body'] ?? null);
            $row['entries'] = $this->entries->listByPayload((int) $row['id']);
            $out[] = $row;
        }

        return $out;
    }

    public function latestVerified(string $engine = Engine::DEFAULT): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, last_refresh, sha256, source_host_id, body, engine, verification_state, created_at
             FROM auth_payloads
             WHERE engine = :engine AND verification_state = :state
             ORDER BY created_at DESC, id DESC
             LIMIT 1'
        );
        $statement->execute([
            'engine' => Engine::validate($engine),
            'state' => self::STATE_VERIFIED,
        ]);
        $payload = $statement->fetch(PDO::FETCH_ASSOC);
        if (!$payload) {
            return null;
        }

        $payload['body'] = $this->decryptBody($payload['body'] ?? null);
        $payload['entries'] = $this->entries->listByPayload((int) $payload['id']);

        return $payload;
    }

    public function deleteRejectedOlderThan(int $olderThanSeconds, string $engine = Engine::DEFAULT): int
    {
        $threshold = gmdate(DATE_ATOM, time() - max(0, $olderThanSeconds));
        $statement = $this->database->connection()->prepare(
            'DELETE FROM auth_payloads
              WHERE engine = :engine
                AND verification_state = :state
                AND created_at < :threshold'
        );
        $statement->execute([
            'engine' => Engine::validate($engine),
            'state' => self::STATE_REJECTED,
            'threshold' => $threshold,
        ]);

        return $statement->rowCount();
    }

    private static function normalizeState(string $state): string
    {
        $state = strtolower(trim($state));
        if (!in_array($state, [self::STATE_PENDING, self::STATE_VERIFIED, self::STATE_REJECTED], true)) {
            return self::STATE_PENDING;
        }

        return $state;
    }

    public function findByIdWithEntries(int $id, ?string $engine = null): ?array
    {
        $sql = 'SELECT id, last_refresh, sha256, source_host_id, body, engine, verification_state, created_at
                FROM auth_payloads
                WHERE id = :id';
        $params = ['id' => $id];
        if ($engine !== null) {
            $sql .= ' AND engine = :engine';
            $params['engine'] = Engine::validate($engine);
        }
        $sql .= ' LIMIT 1';

        $statement = $this->database->connection()->prepare($sql);
        $statement->execute($params);
        $payload = $statement->fetch(PDO::FETCH_ASSOC);

        if (!$payload) {
            return null;
        }

        $payload['body'] = $this->decryptBody($payload['body'] ?? null);
        $payload['entries'] = $this->entries->listByPayload((int) $payload['id']);

        return $payload;
    }

    public function findMetadataById(int $id, ?string $engine = null): ?array
    {
        $sql = 'SELECT id, last_refresh, sha256, source_host_id, engine, verification_state, created_at
                FROM auth_payloads
                WHERE id = :id';
        $params = ['id' => $id];
        if ($engine !== null) {
            $sql .= ' AND engine = :engine';
            $params['engine'] = Engine::validate($engine);
        }
        $sql .= ' LIMIT 1';

        $statement = $this->database->connection()->prepare($sql);
        $statement->execute($params);
        $payload = $statement->fetch(PDO::FETCH_ASSOC);

        return $payload ?: null;
    }

    public function latest(string $engine = Engine::DEFAULT): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, last_refresh, sha256, source_host_id, body, engine, verification_state, created_at
             FROM auth_payloads
             WHERE engine = :engine
             ORDER BY created_at DESC, id DESC
             LIMIT 1'
        );
        $statement->execute(['engine' => Engine::validate($engine)]);
        $payload = $statement->fetch(PDO::FETCH_ASSOC);
        if (!$payload) {
            return null;
        }

        $payload['body'] = $this->decryptBody($payload['body'] ?? null);
        $payload['entries'] = $this->entries->listByPayload((int) $payload['id']);

        return $payload;
    }

    public function latestMetadata(string $engine = Engine::DEFAULT): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, last_refresh, sha256, source_host_id, engine, verification_state, created_at
             FROM auth_payloads
             WHERE engine = :engine
             ORDER BY created_at DESC, id DESC
             LIMIT 1'
        );
        $statement->execute(['engine' => Engine::validate($engine)]);
        $payload = $statement->fetch(PDO::FETCH_ASSOC);

        return $payload ?: null;
    }

    private function decryptBody(?string $body): ?string
    {
        if ($body === null || $body === '') {
            return $body;
        }

        $decrypted = $this->encrypter->decrypt($body);

        return $decrypted ?? null;
    }
}
