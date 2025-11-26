<?php

namespace App\Repositories;

use App\Database;
use PDO;

class SlashCommandRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function all(bool $includeDeleted = false): array
    {
        $sql = 'SELECT id, filename, sha256, description, argument_hint, updated_at, deleted_at FROM slash_commands';
        if (!$includeDeleted) {
            $sql .= ' WHERE deleted_at IS NULL';
        }
        $sql .= ' ORDER BY filename ASC';

        $statement = $this->database->connection()->query($sql);

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
            'INSERT INTO slash_commands (filename, sha256, description, argument_hint, prompt, source_host_id, created_at, updated_at, deleted_at)
             VALUES (:filename, :sha256, :description, :argument_hint, :prompt, :source_host_id, :created_at, :updated_at, NULL)
             ON DUPLICATE KEY UPDATE
                sha256 = VALUES(sha256),
                description = VALUES(description),
                argument_hint = VALUES(argument_hint),
                prompt = VALUES(prompt),
                source_host_id = VALUES(source_host_id),
                deleted_at = NULL,
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

    public function delete(string $filename): bool
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE slash_commands SET deleted_at = :deleted_at WHERE filename = :filename'
        );

        $statement->execute([
            'deleted_at' => gmdate(DATE_ATOM),
            'filename' => $filename,
        ]);

        return $statement->rowCount() > 0;
    }
}
