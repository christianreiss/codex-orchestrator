<?php

declare(strict_types=1);

namespace App\Services\Wrapper\V2;

use RuntimeException;

/**
 * Ed25519 signer for per-host config blobs.
 *
 * Private key lives on disk at storage/wrapper/v2/keys/signing.ed25519 (chmod 600);
 * the public key sits next to it and is embedded into the Go binary at build time.
 * One ConfigSigner is constructed per request and re-uses the loaded key bytes.
 */
final class ConfigSigner
{
    private string $privateKey;

    /** @throws RuntimeException if the key is missing/unreadable. */
    public function __construct(string $privateKeyPath)
    {
        if (!is_file($privateKeyPath)) {
            throw new RuntimeException("Ed25519 private key not found: $privateKeyPath (run scripts/wrapper-v2-init-keys.sh)");
        }
        $raw = @file_get_contents($privateKeyPath);
        if (!is_string($raw)) {
            throw new RuntimeException("Unable to read $privateKeyPath");
        }

        $key = self::parsePem($raw);
        if ($key === null) {
            throw new RuntimeException("Private key in $privateKeyPath is not a recognised PEM-encoded Ed25519 key");
        }
        $this->privateKey = $key;
    }

    /** Sign $payload and return a base64-encoded detached signature. */
    public function sign(string $payload): string
    {
        if (!function_exists('sodium_crypto_sign_detached')) {
            throw new RuntimeException('libsodium not available — install ext-sodium');
        }
        $sig = sodium_crypto_sign_detached($payload, $this->privateKey);
        return base64_encode($sig);
    }

    /**
     * Parse a PKCS#8 PEM-encoded Ed25519 private key into the 64-byte
     * libsodium-compatible secret key bytes. Falls back to raw seed if the
     * file contains only the 32-byte seed (legacy openssl output).
     */
    private static function parsePem(string $pem): ?string
    {
        $pem = trim($pem);
        if (preg_match('/-----BEGIN (?:ED25519 )?PRIVATE KEY-----(.+?)-----END/sm', $pem, $m)) {
            $der = base64_decode(preg_replace('/\s+/', '', $m[1]) ?? '', true);
            if (!is_string($der)) {
                return null;
            }
            // PKCS#8 v1 unencrypted Ed25519 has the 32-byte seed in the last 32 octets
            // wrapped in an OCTET STRING. We don't need to fully ASN.1-parse — we
            // look for the inner OCTET STRING (0x04 0x20 <seed>) at the tail.
            $idx = strpos($der, "\x04\x20");
            if ($idx === false || $idx + 2 + 32 > strlen($der)) {
                return null;
            }
            $seed = substr($der, $idx + 2, 32);
            $pair = sodium_crypto_sign_seed_keypair($seed);
            return sodium_crypto_sign_secretkey($pair);
        }
        // Raw 64-byte secret key fallback (some operators store it bare).
        if (strlen($pem) === SODIUM_CRYPTO_SIGN_SECRETKEYBYTES) {
            return $pem;
        }
        return null;
    }
}
