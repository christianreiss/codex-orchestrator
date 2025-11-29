<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 */

namespace App\Security;

use RuntimeException;

class SecretBox
{
    private const PREFIX = 'sbox:v1:';

    public function __construct(private readonly string $binaryKey)
    {
        if (!extension_loaded('sodium')) {
            throw new RuntimeException('The sodium extension is required for secretbox encryption');
        }

        if (strlen($binaryKey) !== SODIUM_CRYPTO_SECRETBOX_KEYBYTES) {
            throw new RuntimeException('AUTH_ENCRYPTION_KEY must be a 32-byte secretbox key');
        }
    }

    public function encrypt(string $plaintext): string
    {
        $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        $cipher = sodium_crypto_secretbox($plaintext, $nonce, $this->binaryKey);
        $encoded = sodium_bin2base64($nonce . $cipher, SODIUM_BASE64_VARIANT_ORIGINAL);

        return self::PREFIX . $encoded;
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
        try {
            $decoded = sodium_base642bin($payload, SODIUM_BASE64_VARIANT_ORIGINAL);
        } catch (\Throwable $exception) {
            error_log('[encryption] failed to base64 decode ciphertext: ' . $exception->getMessage());
            return null;
        }

        $nonceSize = SODIUM_CRYPTO_SECRETBOX_NONCEBYTES;
        if (strlen($decoded) <= $nonceSize) {
            error_log('[encryption] ciphertext too short to contain nonce');
            return null;
        }

        $nonce = substr($decoded, 0, $nonceSize);
        $cipher = substr($decoded, $nonceSize);

        $plaintext = sodium_crypto_secretbox_open($cipher, $nonce, $this->binaryKey);
        if ($plaintext === false) {
            error_log('[encryption] decryption failed for provided ciphertext');
            return null;
        }

        return $plaintext;
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
