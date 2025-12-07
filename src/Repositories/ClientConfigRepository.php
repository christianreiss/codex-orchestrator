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

class ClientConfigRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function latest(): ?array
    {
        $statement = $this->database->connection()->query(
            'SELECT id, sha256, body, settings, source_host_id, created_at, updated_at
             FROM client_config_documents
             ORDER BY id DESC
             LIMIT 1'
        );

        $row = $statement->fetch(PDO::FETCH_ASSOC);

        if (!is_array($row)) {
            return null;
        }

        $settings = $row['settings'] ?? null;
        if (is_string($settings)) {
            $decoded = json_decode($settings, true);
            if (json_last_error() === JSON_ERROR_NONE && is_array($decoded)) {
                $row['settings'] = $decoded;
            }
        }

        return $row;
    }

    public function upsert(string $body, ?array $settings = null, ?int $sourceHostId = null, ?string $sha256 = null): array
    {
        $now = gmdate(DATE_ATOM);
        $sha = $sha256 ?? hash('sha256', $body);
        $settingsJson = $settings === null ? null : json_encode($settings, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        $statement = $this->database->connection()->prepare(
            'INSERT INTO client_config_documents (id, sha256, body, settings, source_host_id, created_at, updated_at)
             VALUES (1, :sha256, :body, :settings, :source_host_id, :created_at, :updated_at)
             ON DUPLICATE KEY UPDATE
                sha256 = VALUES(sha256),
                body = VALUES(body),
                settings = VALUES(settings),
                source_host_id = VALUES(source_host_id),
                updated_at = VALUES(updated_at)'
        );

        $statement->execute([
            'sha256' => $sha,
            'body' => $body,
            'settings' => $settingsJson,
            'source_host_id' => $sourceHostId,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        return $this->latest() ?? [];
    }
}
