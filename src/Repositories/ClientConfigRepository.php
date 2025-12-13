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
        // Canonical row is id=1; prefer it when present so stray rows (legacy/manual)
        // don't override the fleet config.
        $canonical = $this->fetchById(1);
        if (is_array($canonical)) {
            return $canonical;
        }

        // Back-compat: older deployments may have inserted an auto-increment row
        // before we standardized on id=1.
        $statement = $this->database->connection()->query(
            'SELECT id, sha256, body, settings, source_host_id, created_at, updated_at
             FROM client_config_documents
             ORDER BY id DESC
             LIMIT 1'
        );

        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return is_array($row) ? $this->decodeSettings($row) : null;
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

    private function fetchById(int $id): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, sha256, body, settings, source_host_id, created_at, updated_at
             FROM client_config_documents
             WHERE id = :id
             LIMIT 1'
        );
        $statement->execute(['id' => $id]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return is_array($row) ? $this->decodeSettings($row) : null;
    }

    private function decodeSettings(array $row): array
    {
        $settings = $row['settings'] ?? null;
        if (!is_string($settings) || trim($settings) === '') {
            return $row;
        }

        $decoded = json_decode($settings, true);
        if (json_last_error() === JSON_ERROR_NONE) {
            if (is_array($decoded)) {
                $row['settings'] = $decoded;
                return $row;
            }

            // Handle double-encoded legacy values (JSON string that itself contains JSON).
            if (is_string($decoded)) {
                $decoded2 = json_decode($decoded, true);
                if (json_last_error() === JSON_ERROR_NONE && is_array($decoded2)) {
                    $row['settings'] = $decoded2;
                }
            }
        }

        return $row;
    }
}
