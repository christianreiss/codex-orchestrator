<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Database;
use App\Security\SecretBox;
use PDO;

class AuthEncryptionMigrator
{
    private const BATCH_SIZE = 200;

    public function __construct(
        private readonly Database $database,
        private readonly SecretBox $encrypter
    ) {
    }

    public function migrate(): void
    {
        $payloads = $this->encryptPayloadBodies();
        $entries = $this->encryptEntryTokens();

        if ($payloads > 0 || $entries > 0) {
            error_log(sprintf(
                '[encryption] migrated auth storage to secretbox (payload_bodies=%d, entry_tokens=%d)',
                $payloads,
                $entries
            ));
        }
    }

    private function encryptPayloadBodies(): int
    {
        $connection = $this->database->connection();
        $updated = 0;

        while (true) {
            $select = $connection->prepare(
                'SELECT id, body FROM auth_payloads WHERE body IS NOT NULL AND body != "" AND body NOT LIKE :prefix LIMIT :limit'
            );
            $select->bindValue(':prefix', $this->encrypter->prefix() . '%');
            $select->bindValue(':limit', self::BATCH_SIZE, PDO::PARAM_INT);
            $select->execute();
            $rows = $select->fetchAll(PDO::FETCH_ASSOC) ?: [];
            if (!$rows) {
                break;
            }

            $update = $connection->prepare('UPDATE auth_payloads SET body = :body WHERE id = :id');
            foreach ($rows as $row) {
                if ($this->encrypter->isEncrypted($row['body'])) {
                    continue;
                }
                $ciphertext = $this->encrypter->encrypt((string) $row['body']);
                $update->execute([
                    'body' => $ciphertext,
                    'id' => (int) $row['id'],
                ]);
                $updated++;
            }
        }

        return $updated;
    }

    private function encryptEntryTokens(): int
    {
        $connection = $this->database->connection();
        $updated = 0;

        while (true) {
            $select = $connection->prepare(
                'SELECT id, token FROM auth_entries WHERE token NOT LIKE :prefix LIMIT :limit'
            );
            $select->bindValue(':prefix', $this->encrypter->prefix() . '%');
            $select->bindValue(':limit', self::BATCH_SIZE, PDO::PARAM_INT);
            $select->execute();
            $rows = $select->fetchAll(PDO::FETCH_ASSOC) ?: [];
            if (!$rows) {
                break;
            }

            $update = $connection->prepare('UPDATE auth_entries SET token = :token WHERE id = :id');
            foreach ($rows as $row) {
                if ($this->encrypter->isEncrypted($row['token'])) {
                    continue;
                }
                $ciphertext = $this->encrypter->encrypt((string) $row['token']);
                $update->execute([
                    'token' => $ciphertext,
                    'id' => (int) $row['id'],
                ]);
                $updated++;
            }
        }

        return $updated;
    }
}
