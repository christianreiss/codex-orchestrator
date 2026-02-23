<?php

declare(strict_types=1);

use App\Security\SecretBox;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class SecretBoxKeyRotationTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        if (!extension_loaded('sodium')) {
            $this->markTestSkipped('sodium extension is required for SecretBox tests');
        }
    }

    public function testLegacyCiphertextRemainsDecryptableWithKeyring(): void
    {
        $legacyKey = str_repeat('a', SODIUM_CRYPTO_SECRETBOX_KEYBYTES);
        $newKey = str_repeat('b', SODIUM_CRYPTO_SECRETBOX_KEYBYTES);
        $plaintext = 'secret-value';

        $legacy = new SecretBox($legacyKey);
        $ciphertext = $legacy->encrypt($plaintext);
        $this->assertStringStartsWith('sbox:v1:', $ciphertext);

        $rotated = new SecretBox($newKey, 'current', [
            'legacy' => $legacyKey,
            'current' => $newKey,
        ]);
        $this->assertSame($plaintext, $rotated->decrypt($ciphertext));
    }

    public function testEncryptsWithKeyIdWhenActiveKidIsConfigured(): void
    {
        $keyA = str_repeat('c', SODIUM_CRYPTO_SECRETBOX_KEYBYTES);
        $keyB = str_repeat('d', SODIUM_CRYPTO_SECRETBOX_KEYBYTES);
        $plaintext = 'rotated-secret';

        $encrypter = new SecretBox($keyA, 'kid-a', [
            'kid-a' => $keyA,
            'kid-b' => $keyB,
        ]);
        $ciphertext = $encrypter->encrypt($plaintext);
        $this->assertStringContainsString('sbox:v1:kid=kid-a:', $ciphertext);

        $decrypter = new SecretBox($keyB, 'kid-b', [
            'kid-a' => $keyA,
            'kid-b' => $keyB,
        ]);
        $this->assertSame($plaintext, $decrypter->decrypt($ciphertext));
    }
}

