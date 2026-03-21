<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Repositories;

use App\Database;

class AdminPasswordResetRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function expireForUser(int $userId, string $usedAt): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE admin_password_resets SET used_at = :used_at WHERE user_id = :user_id AND used_at IS NULL'
        );
        $statement->execute([
            'used_at' => $usedAt,
            'user_id' => $userId,
        ]);
    }

    public function wipeAll(): void
    {
        $this->database->connection()->exec('DELETE FROM admin_password_resets');
    }
}
