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

class AgentsRepository
{
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

    public function upsert(string $body, ?int $sourceHostId = null, ?string $sha256 = null): array
    {
        $now = gmdate(DATE_ATOM);
        $sha = $sha256 ?? hash('sha256', $body);

        $statement = $this->database->connection()->prepare(
            'INSERT INTO agents_documents (id, sha256, body, source_host_id, created_at, updated_at)
             VALUES (1, :sha256, :body, :source_host_id, :created_at, :updated_at)
             ON DUPLICATE KEY UPDATE
                sha256 = VALUES(sha256),
                body = VALUES(body),
                source_host_id = VALUES(source_host_id),
                updated_at = VALUES(updated_at)'
        );

        $statement->execute([
            'sha256' => $sha,
            'body' => $body,
            'source_host_id' => $sourceHostId,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        return $this->latest() ?? [];
    }
}
