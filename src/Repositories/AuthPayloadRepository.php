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

    public function create(
        string $lastRefresh,
        string $sha256,
        ?int $sourceHostId,
        array $entries,
        ?string $extrasJson = null,
        string $engine = Engine::DEFAULT
    ): array
    {
        $statement = $this->database->connection()->prepare(
            'INSERT INTO auth_payloads (last_refresh, sha256, source_host_id, body, engine, created_at)
             VALUES (:last_refresh, :sha256, :source_host_id, :body, :engine, :created_at)'
        );

        $statement->execute([
            'last_refresh' => $lastRefresh,
            'sha256' => $sha256,
            'source_host_id' => $sourceHostId,
            'body' => $extrasJson !== null ? $this->encrypter->encrypt($extrasJson) : null,
            'engine' => Engine::validate($engine),
            'created_at' => gmdate(DATE_ATOM),
        ]);

        $id = (int) $this->database->connection()->lastInsertId();
        $this->entries->replaceEntries($id, $entries);

        return $this->findByIdWithEntries($id);
    }

    public function findByIdWithEntries(int $id, ?string $engine = null): ?array
    {
        $sql = 'SELECT id, last_refresh, sha256, source_host_id, body, engine, created_at
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
        $sql = 'SELECT id, last_refresh, sha256, source_host_id, engine, created_at
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
            'SELECT id, last_refresh, sha256, source_host_id, body, engine, created_at
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
            'SELECT id, last_refresh, sha256, source_host_id, engine, created_at
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
