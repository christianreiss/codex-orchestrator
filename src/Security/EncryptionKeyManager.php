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
    private const LEGACY_KEY_ENV = 'AUTH_ENCRYPTION_KEY';
    private const KEYS_ENV = 'AUTH_ENCRYPTION_KEYS';
    private const ACTIVE_KID_ENV = 'AUTH_ENCRYPTION_ACTIVE_KID';

    public function __construct(private readonly string $rootPath)
    {
    }

    public function getKey(): string
    {
        $keyring = $this->getKeyring();
        return $keyring['active_key'];
    }

    /**
     * @return array{active_kid:string,active_key:string,keys:array<string,string>}
     */
    public function getKeyring(): array
    {
        if (!extension_loaded('sodium')) {
            throw new RuntimeException('The sodium extension is required for auth encryption');
        }

        $keysRaw = Config::get(self::KEYS_ENV);
        if (is_string($keysRaw) && trim($keysRaw) !== '') {
            $keys = $this->parseKeyList($keysRaw);
            if ($keys === []) {
                throw new RuntimeException('AUTH_ENCRYPTION_KEYS must contain at least one key');
            }

            $activeKidRaw = Config::get(self::ACTIVE_KID_ENV, '');
            $activeKid = is_string($activeKidRaw) ? trim($activeKidRaw) : '';
            if ($activeKid === '') {
                $activeKid = (string) array_key_first($keys);
            }
            if (!array_key_exists($activeKid, $keys)) {
                throw new RuntimeException('AUTH_ENCRYPTION_ACTIVE_KID must reference a key from AUTH_ENCRYPTION_KEYS');
            }

            return [
                'active_kid' => $activeKid,
                'active_key' => $keys[$activeKid],
                'keys' => $keys,
            ];
        }

        $existing = Config::get(self::LEGACY_KEY_ENV);
        if (is_string($existing) && trim($existing) !== '') {
            $decoded = $this->decodeKey($existing, self::LEGACY_KEY_ENV);
            return [
                'active_kid' => 'legacy',
                'active_key' => $decoded,
                'keys' => ['legacy' => $decoded],
            ];
        }

        $generated = sodium_crypto_secretbox_keygen();
        $encoded = sodium_bin2base64($generated, SODIUM_BASE64_VARIANT_ORIGINAL);

        $this->persistEnvKey($encoded);
        $this->injectProcessEnv($encoded);

        return [
            'active_kid' => 'legacy',
            'active_key' => $generated,
            'keys' => ['legacy' => $generated],
        ];
    }

    /**
     * @return array<string,string>
     */
    private function parseKeyList(string $raw): array
    {
        $keys = [];
        foreach (explode(',', $raw) as $piece) {
            $entry = trim($piece);
            if ($entry === '') {
                continue;
            }
            $parts = explode(':', $entry, 2);
            if (count($parts) !== 2) {
                throw new RuntimeException('AUTH_ENCRYPTION_KEYS entries must use kid:base64 format');
            }
            $kid = trim($parts[0]);
            $encoded = trim($parts[1]);
            if ($kid === '' || $encoded === '') {
                throw new RuntimeException('AUTH_ENCRYPTION_KEYS entries must include non-empty kid and key');
            }
            if (array_key_exists($kid, $keys)) {
                throw new RuntimeException('AUTH_ENCRYPTION_KEYS contains duplicate key id "' . $kid . '"');
            }
            $keys[$kid] = $this->decodeKey($encoded, self::KEYS_ENV);
        }

        return $keys;
    }

    private function decodeKey(string $encoded, string $sourceEnv): string
    {
        try {
            $binary = sodium_base642bin(trim($encoded), SODIUM_BASE64_VARIANT_ORIGINAL);
        } catch (\Throwable $exception) {
            throw new RuntimeException($sourceEnv . ' must be base64-encoded secretbox key material');
        }

        if (strlen($binary) !== SODIUM_CRYPTO_SECRETBOX_KEYBYTES) {
            throw new RuntimeException($sourceEnv . ' must decode to a 32-byte secretbox key');
        }

        return $binary;
    }

    private function persistEnvKey(string $encoded): void
    {
        $path = rtrim($this->rootPath, '/');
        $envPath = $path . '/.env';

        $line = self::LEGACY_KEY_ENV . '=' . $encoded . PHP_EOL;

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

        if (str_contains($contents, self::LEGACY_KEY_ENV . '=')) {
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
        $_ENV[self::LEGACY_KEY_ENV] = $encoded;
        $_SERVER[self::LEGACY_KEY_ENV] = $encoded;
        putenv(self::LEGACY_KEY_ENV . '=' . $encoded);
    }
}
