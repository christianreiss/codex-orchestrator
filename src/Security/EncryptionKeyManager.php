<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Security;

use App\Config;
use RuntimeException;

class EncryptionKeyManager
{
    private const KEY_ENV = 'AUTH_ENCRYPTION_KEY';

    public function __construct(private readonly string $rootPath)
    {
    }

    public function getKey(): string
    {
        if (!extension_loaded('sodium')) {
            throw new RuntimeException('The sodium extension is required for auth encryption');
        }

        $existing = Config::get(self::KEY_ENV);
        if (is_string($existing) && trim($existing) !== '') {
            return $this->decodeKey($existing);
        }

        $generated = sodium_crypto_secretbox_keygen();
        $encoded = sodium_bin2base64($generated, SODIUM_BASE64_VARIANT_ORIGINAL);

        $this->persistEnvKey($encoded);
        $this->injectProcessEnv($encoded);

        return $generated;
    }

    private function decodeKey(string $encoded): string
    {
        try {
            $binary = sodium_base642bin(trim($encoded), SODIUM_BASE64_VARIANT_ORIGINAL);
        } catch (\Throwable $exception) {
            throw new RuntimeException('AUTH_ENCRYPTION_KEY must be base64-encoded secretbox key material');
        }

        if (strlen($binary) !== SODIUM_CRYPTO_SECRETBOX_KEYBYTES) {
            throw new RuntimeException('AUTH_ENCRYPTION_KEY must decode to a 32-byte secretbox key');
        }

        return $binary;
    }

    private function persistEnvKey(string $encoded): void
    {
        $path = rtrim($this->rootPath, '/');
        $envPath = $path . '/.env';

        $line = self::KEY_ENV . '=' . $encoded . PHP_EOL;

        if (!file_exists($envPath)) {
            $written = file_put_contents($envPath, $line, LOCK_EX);
            if ($written === false) {
                throw new RuntimeException('Failed to create .env for encryption key bootstrap');
            }
            return;
        }

        $contents = file_get_contents($envPath);
        if ($contents === false) {
            throw new RuntimeException('Unable to read .env for writing the encryption key');
        }

        if (str_contains($contents, self::KEY_ENV . '=')) {
            return;
        }

        $newContents = rtrim($contents, "\r\n") . PHP_EOL . $line;
        $written = file_put_contents($envPath, $newContents, LOCK_EX);
        if ($written === false) {
            throw new RuntimeException('Failed to write AUTH_ENCRYPTION_KEY to .env');
        }
    }

    private function injectProcessEnv(string $encoded): void
    {
        $_ENV[self::KEY_ENV] = $encoded;
        $_SERVER[self::KEY_ENV] = $encoded;
        putenv(self::KEY_ENV . '=' . $encoded);
    }
}
