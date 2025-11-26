<?php

namespace App\Repositories;

use App\Database;
use PDO;

class SlashCommandRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function all(): array
    {
        $statement = $this->database->connection()->query(
            'SELECT id, filename, sha256, description, argument_hint, updated_at FROM slash_commands ORDER BY filename ASC'
        );

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        return is_array($rows) ? $rows : [];
    }

    public function findByFilename(string $filename): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, filename, sha256, description, argument_hint, prompt, source_host_id, created_at, updated_at
             FROM slash_commands
             WHERE filename = :filename
             LIMIT 1'
        );

        $statement->execute(['filename' => $filename]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    public function upsert(
        string $filename,
        string $sha256,
        ?string $description,
        ?string $argumentHint,
        string $prompt,
        ?int $sourceHostId
    ): array {
        $now = gmdate(DATE_ATOM);

        $statement = $this->database->connection()->prepare(
            'INSERT INTO slash_commands (filename, sha256, description, argument_hint, prompt, source_host_id, created_at, updated_at)
             VALUES (:filename, :sha256, :description, :argument_hint, :prompt, :source_host_id, :created_at, :updated_at)
             ON DUPLICATE KEY UPDATE
                sha256 = VALUES(sha256),
                description = VALUES(description),
                argument_hint = VALUES(argument_hint),
                prompt = VALUES(prompt),
                source_host_id = VALUES(source_host_id),
                updated_at = VALUES(updated_at)'
        );

        $statement->execute([
            'filename' => $filename,
            'sha256' => $sha256,
            'description' => $description,
            'argument_hint' => $argumentHint,
            'prompt' => $prompt,
            'source_host_id' => $sourceHostId,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        return $this->findByFilename($filename) ?? [];
    }
}
