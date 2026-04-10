<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Database;
use App\Security\SecretBox;
use App\Support\Engine;
use PDO;

class OpenaiApiKeyRepository
{
    public function __construct(
        private readonly Database $database,
        private readonly SecretBox $encrypter
    ) {
    }

    public function create(string $key, string $name, ?int $adminUserId, int $rateLimitRpm = 60, ?string $expiresAt = null, string $engine = Engine::CODEX): array
    {
        $now = gmdate(DATE_ATOM);
        $keyHash = hash('sha256', $key);
        $keyEnc = $this->encrypter->encrypt($key);
        $prefix = substr($key, 0, 16) . '...';

        $statement = $this->database->connection()->prepare(
            'INSERT INTO openai_api_keys (name, key_prefix, key_hash, key_enc, admin_user_id, rate_limit_rpm, is_active, use_count, expires_at, engine, created_at, updated_at)
             VALUES (:name, :key_prefix, :key_hash, :key_enc, :admin_user_id, :rate_limit_rpm, 1, 0, :expires_at, :engine, :created_at, :updated_at)'
        );

        $statement->execute([
            'name' => $name,
            'key_prefix' => $prefix,
            'key_hash' => $keyHash,
            'key_enc' => $keyEnc,
            'admin_user_id' => $adminUserId,
            'rate_limit_rpm' => $rateLimitRpm,
            'expires_at' => $expiresAt,
            'engine' => $engine,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        return $this->findById((int) $this->database->connection()->lastInsertId()) ?? [
            'name' => $name,
            'key_prefix' => $prefix,
        ];
    }

    public function findByKey(string $key): ?array
    {
        $keyHash = hash('sha256', $key);

        $statement = $this->database->connection()->prepare(
            'SELECT * FROM openai_api_keys WHERE key_hash = :key_hash LIMIT 1'
        );
        $statement->execute(['key_hash' => $keyHash]);

        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }

        return $row;
    }

    public function findById(int $id): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT * FROM openai_api_keys WHERE id = :id LIMIT 1'
        );
        $statement->execute(['id' => $id]);

        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }

        return $row;
    }

    public function listAll(): array
    {
        $statement = $this->database->connection()->query(
            'SELECT id, name, key_prefix, admin_user_id, rate_limit_rpm, is_active, use_count, last_used_at, expires_at, engine, created_at, updated_at FROM openai_api_keys ORDER BY created_at DESC'
        );

        return $statement->fetchAll(PDO::FETCH_ASSOC);
    }

    public function listByEngine(string $engine): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, name, key_prefix, admin_user_id, rate_limit_rpm, is_active, use_count, last_used_at, expires_at, engine, created_at, updated_at
             FROM openai_api_keys WHERE engine = :engine ORDER BY created_at DESC'
        );
        $statement->execute(['engine' => $engine]);

        return $statement->fetchAll(PDO::FETCH_ASSOC);
    }

    public function listActive(): array
    {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'SELECT id, name, key_prefix, admin_user_id, rate_limit_rpm, use_count, last_used_at, expires_at, created_at, updated_at
             FROM openai_api_keys
             WHERE is_active = 1 AND (expires_at IS NULL OR expires_at > :now)
             ORDER BY created_at DESC'
        );
        $statement->execute(['now' => $now]);

        return $statement->fetchAll(PDO::FETCH_ASSOC);
    }

    public function touch(int $id): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE openai_api_keys SET use_count = use_count + 1, last_used_at = :last_used_at, updated_at = :updated_at WHERE id = :id'
        );
        $statement->execute([
            'last_used_at' => gmdate(DATE_ATOM),
            'updated_at' => gmdate(DATE_ATOM),
            'id' => $id,
        ]);
    }

    public function setActive(int $id, bool $active): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE openai_api_keys SET is_active = :is_active, updated_at = :updated_at WHERE id = :id'
        );
        $statement->execute([
            'is_active' => $active ? 1 : 0,
            'updated_at' => gmdate(DATE_ATOM),
            'id' => $id,
        ]);
    }

    public function delete(int $id): void
    {
        $statement = $this->database->connection()->prepare(
            'DELETE FROM openai_api_keys WHERE id = :id'
        );
        $statement->execute(['id' => $id]);
    }

    public function deleteExpired(string $cutoff): void
    {
        $statement = $this->database->connection()->prepare(
            'DELETE FROM openai_api_keys WHERE expires_at IS NOT NULL AND expires_at < :cutoff'
        );
        $statement->execute(['cutoff' => $cutoff]);
    }
}
