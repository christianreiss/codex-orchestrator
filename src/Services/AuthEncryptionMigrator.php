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
        $installers = $this->encryptInstallerTokens();

        if ($payloads > 0 || $entries > 0 || $installers > 0) {
            error_log(sprintf(
                '[encryption] migrated auth storage to secretbox (payload_bodies=%d, entry_tokens=%d, installer_tokens=%d)',
                $payloads,
                $entries,
                $installers
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

    private function encryptInstallerTokens(): int
    {
        $connection = $this->database->connection();
        $updated = 0;

        while (true) {
            $select = $connection->prepare(
                'SELECT id, token, token_enc, api_key, api_key_enc
                 FROM install_tokens
                 WHERE token_enc IS NULL OR api_key_enc IS NULL OR CHAR_LENGTH(token) < 64
                 LIMIT :limit'
            );
            $select->bindValue(':limit', self::BATCH_SIZE, PDO::PARAM_INT);
            $select->execute();
            $rows = $select->fetchAll(PDO::FETCH_ASSOC) ?: [];
            if (!$rows) {
                break;
            }

            $update = $connection->prepare(
                'UPDATE install_tokens
                 SET token = :token_hash, token_enc = :token_enc, api_key = :api_key_hash, api_key_enc = :api_key_enc
                 WHERE id = :id'
            );

            foreach ($rows as $row) {
                $plainToken = $this->recoverValue($row['token_enc'] ?? null, $row['token'] ?? null);
                if ($plainToken === null || $plainToken === '') {
                    continue;
                }

                $plainApiKey = $this->recoverValue($row['api_key_enc'] ?? null, $row['api_key'] ?? null);
                if ($plainApiKey === null || $plainApiKey === '') {
                    continue;
                }

                $update->execute([
                    'token_hash' => hash('sha256', $plainToken),
                    'token_enc' => $this->encrypter->encrypt($plainToken),
                    'api_key_hash' => hash('sha256', $plainApiKey),
                    'api_key_enc' => $this->encrypter->encrypt($plainApiKey),
                    'id' => (int) $row['id'],
                ]);
                $updated++;
            }
        }

        return $updated;
    }

    private function recoverValue(?string $encrypted, ?string $fallback): ?string
    {
        if ($encrypted !== null && $encrypted !== '') {
            if ($this->encrypter->isEncrypted($encrypted)) {
                $decrypted = $this->encrypter->decrypt($encrypted);
                if ($decrypted !== null && $decrypted !== '') {
                    return $decrypted;
                }
            } else {
                return $encrypted;
            }
        }

        return $fallback !== '' ? $fallback : null;
    }
}
