<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 */

namespace App\Repositories;

use App\Database;
use App\Security\SecretBox;
use PDO;

class AuthEntryRepository
{
    public function __construct(
        private readonly Database $database,
        private readonly SecretBox $encrypter
    ) {
    }

    public function replaceEntries(int $payloadId, array $entries): void
    {
        $connection = $this->database->connection();

        $deleteStmt = $connection->prepare('DELETE FROM auth_entries WHERE payload_id = :payload_id');
        $deleteStmt->execute(['payload_id' => $payloadId]);

        if (!$entries) {
            return;
        }

        $insert = $connection->prepare(
            'INSERT INTO auth_entries (payload_id, target, token, token_type, organization, project, api_base, meta, created_at)
             VALUES (:payload_id, :target, :token, :token_type, :organization, :project, :api_base, :meta, :created_at)'
        );

        $now = gmdate(DATE_ATOM);
        foreach ($entries as $entry) {
            $insert->execute([
                'payload_id' => $payloadId,
                'target' => $entry['target'],
                'token' => $this->encrypter->encrypt($entry['token']),
                'token_type' => $entry['token_type'] ?? 'bearer',
                'organization' => $entry['organization'] ?? null,
                'project' => $entry['project'] ?? null,
                'api_base' => $entry['api_base'] ?? null,
                'meta' => isset($entry['meta']) && $entry['meta'] ? json_encode($entry['meta'], JSON_UNESCAPED_SLASHES) : null,
                'created_at' => $now,
            ]);
        }
    }

    public function listByPayload(int $payloadId): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, payload_id, target, token, token_type, organization, project, api_base, meta, created_at
             FROM auth_entries WHERE payload_id = :payload_id ORDER BY target ASC'
        );
        $statement->execute(['payload_id' => $payloadId]);
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC) ?: [];

        foreach ($rows as &$row) {
            if (isset($row['meta']) && is_string($row['meta'])) {
                $decoded = json_decode($row['meta'], true);
                $row['meta'] = is_array($decoded) ? $decoded : null;
            }

            $decrypted = $this->encrypter->decrypt($row['token']);
            $row['token'] = $decrypted ?? '';
        }

        return $rows;
    }
}
