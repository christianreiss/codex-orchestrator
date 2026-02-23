<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Security;

use RuntimeException;

class SecretBox
{
    private const PREFIX = 'sbox:v1:';
    private const KID_PREFIX = 'kid=';

    /** @var array<string,string> */
    private array $decryptionKeys = [];
    private string $activeKid;
    private string $activeKey;

    /**
     * @param array<string,string> $decryptionKeys
     */
    public function __construct(string $binaryKey, string $activeKid = 'legacy', array $decryptionKeys = [])
    {
        if (!extension_loaded('sodium')) {
            throw new RuntimeException('The sodium extension is required for secretbox encryption');
        }

        if (strlen($binaryKey) !== SODIUM_CRYPTO_SECRETBOX_KEYBYTES) {
            throw new RuntimeException('AUTH_ENCRYPTION_KEY must be a 32-byte secretbox key');
        }

        $normalizedKid = trim($activeKid);
        if ($normalizedKid === '') {
            $normalizedKid = 'legacy';
        }
        $this->activeKid = $normalizedKid;
        $this->activeKey = $binaryKey;
        $this->decryptionKeys[$this->activeKid] = $this->activeKey;

        foreach ($decryptionKeys as $kid => $key) {
            if (!is_string($kid) || !is_string($key)) {
                continue;
            }
            $candidateKid = trim($kid);
            if ($candidateKid === '') {
                continue;
            }
            if (strlen($key) !== SODIUM_CRYPTO_SECRETBOX_KEYBYTES) {
                throw new RuntimeException('AUTH_ENCRYPTION_KEYS must contain 32-byte key material');
            }
            $this->decryptionKeys[$candidateKid] = $key;
        }
    }

    public function encrypt(string $plaintext): string
    {
        $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        $cipher = sodium_crypto_secretbox($plaintext, $nonce, $this->activeKey);
        $encoded = sodium_bin2base64($nonce . $cipher, SODIUM_BASE64_VARIANT_ORIGINAL);

        if ($this->activeKid === 'legacy') {
            return self::PREFIX . $encoded;
        }

        return self::PREFIX . self::KID_PREFIX . rawurlencode($this->activeKid) . ':' . $encoded;
    }

    public function decrypt(?string $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $trimmed = trim($value);
        if ($trimmed === '') {
            return $trimmed;
        }

        if (!$this->isEncrypted($trimmed)) {
            return $trimmed;
        }

        $payload = substr($trimmed, strlen(self::PREFIX));
        $targetKid = null;
        if (str_starts_with($payload, self::KID_PREFIX)) {
            $separator = strpos($payload, ':');
            if ($separator === false || $separator <= strlen(self::KID_PREFIX)) {
                error_log('[encryption] invalid ciphertext key-id prefix');
                return null;
            }
            $targetKid = rawurldecode(substr($payload, strlen(self::KID_PREFIX), $separator - strlen(self::KID_PREFIX)));
            $payload = substr($payload, $separator + 1);
            if ($targetKid === '') {
                error_log('[encryption] empty ciphertext key-id');
                return null;
            }
        }

        $keysToTry = $this->resolveKeysToTry($targetKid);
        foreach ($keysToTry as $key) {
            $plaintext = $this->decryptPayloadWithKey($payload, $key);
            if ($plaintext !== null) {
                return $plaintext;
            }
        }

        if ($targetKid !== null && !array_key_exists($targetKid, $this->decryptionKeys)) {
            error_log('[encryption] unknown key-id "' . $targetKid . '" in ciphertext');
        } else {
            error_log('[encryption] decryption failed for provided ciphertext');
        }

        return null;
    }

    /**
     * @return list<string>
     */
    private function resolveKeysToTry(?string $targetKid): array
    {
        if ($targetKid !== null && isset($this->decryptionKeys[$targetKid])) {
            $keys = [$this->decryptionKeys[$targetKid]];
            foreach ($this->decryptionKeys as $kid => $key) {
                if ($kid === $targetKid) {
                    continue;
                }
                $keys[] = $key;
            }
            return $keys;
        }

        // Legacy payload or unknown kid: try active key first, then remaining keys.
        $keys = [$this->activeKey];
        foreach ($this->decryptionKeys as $kid => $key) {
            if ($kid === $this->activeKid) {
                continue;
            }
            $keys[] = $key;
        }

        return $keys;
    }

    private function decryptPayloadWithKey(string $payload, string $key): ?string
    {
        try {
            $decoded = sodium_base642bin($payload, SODIUM_BASE64_VARIANT_ORIGINAL);
        } catch (\Throwable $exception) {
            return null;
        }

        $nonceSize = SODIUM_CRYPTO_SECRETBOX_NONCEBYTES;
        if (strlen($decoded) <= $nonceSize) {
            return null;
        }

        $nonce = substr($decoded, 0, $nonceSize);
        $cipher = substr($decoded, $nonceSize);
        $plaintext = sodium_crypto_secretbox_open($cipher, $nonce, $key);

        return $plaintext === false ? null : $plaintext;
    }

    public function isEncrypted(?string $value): bool
    {
        if ($value === null) {
            return false;
        }

        return str_starts_with(trim($value), self::PREFIX);
    }

    public function prefix(): string
    {
        return self::PREFIX;
    }
}
