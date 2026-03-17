<?php

declare(strict_types=1);

use App\Security\EncryptionKeyManager;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class EncryptionKeyManagerTest extends TestCase
{
    private string $tmpDir;
    private array $envBackup = [];
    private static array $envKeys = [
        'AUTH_ENCRYPTION_KEY',
        'AUTH_ENCRYPTION_KEYS',
        'AUTH_ENCRYPTION_ACTIVE_KID',
    ];

    protected function setUp(): void
    {
        if (!extension_loaded('sodium')) {
            $this->markTestSkipped('sodium extension is required');
        }

        $this->tmpDir = sys_get_temp_dir() . '/ekm-test-' . bin2hex(random_bytes(4));
        mkdir($this->tmpDir, 0755, true);

        foreach (self::$envKeys as $key) {
            $this->envBackup[$key] = $_ENV[$key] ?? null;
            $this->envBackup['_SERVER_' . $key] = array_key_exists($key, $_SERVER) ? $_SERVER[$key] : null;
            if (array_key_exists($key, $_ENV)) {
                unset($_ENV[$key]);
            }
            if (array_key_exists($key, $_SERVER)) {
                unset($_SERVER[$key]);
            }
            putenv($key);
        }
    }

    protected function tearDown(): void
    {
        if ($this->envBackup === []) {
            return;
        }

        foreach (self::$envKeys as $key) {
            if ($this->envBackup[$key] !== null) {
                $_ENV[$key] = $this->envBackup[$key];
                putenv($key . '=' . $this->envBackup[$key]);
            } else {
                if (array_key_exists($key, $_ENV)) {
                    unset($_ENV[$key]);
                }
                putenv($key);
            }
            if ($this->envBackup['_SERVER_' . $key] !== null) {
                $_SERVER[$key] = $this->envBackup['_SERVER_' . $key];
            } elseif (array_key_exists($key, $_SERVER)) {
                unset($_SERVER[$key]);
            }
        }

        $envPath = $this->tmpDir . '/.env';
        if (file_exists($envPath)) {
            unlink($envPath);
        }
        if (is_dir($this->tmpDir)) {
            rmdir($this->tmpDir);
        }
    }

    public function testLegacyKeyFromEnv(): void
    {
        $key = sodium_crypto_secretbox_keygen();
        $encoded = sodium_bin2base64($key, SODIUM_BASE64_VARIANT_ORIGINAL);
        $_ENV['AUTH_ENCRYPTION_KEY'] = $encoded;

        $manager = new EncryptionKeyManager($this->tmpDir);
        $keyring = $manager->getKeyring();

        $this->assertSame('legacy', $keyring['active_kid']);
        $this->assertSame($key, $keyring['active_key']);
        $this->assertArrayHasKey('legacy', $keyring['keys']);
    }

    public function testGetKeyReturnsBinaryKey(): void
    {
        $key = sodium_crypto_secretbox_keygen();
        $encoded = sodium_bin2base64($key, SODIUM_BASE64_VARIANT_ORIGINAL);
        $_ENV['AUTH_ENCRYPTION_KEY'] = $encoded;

        $manager = new EncryptionKeyManager($this->tmpDir);
        $result = $manager->getKey();

        $this->assertSame(SODIUM_CRYPTO_SECRETBOX_KEYBYTES, strlen($result));
        $this->assertSame($key, $result);
    }

    public function testMultiKeyKeyring(): void
    {
        $key1 = sodium_crypto_secretbox_keygen();
        $key2 = sodium_crypto_secretbox_keygen();
        $encoded1 = sodium_bin2base64($key1, SODIUM_BASE64_VARIANT_ORIGINAL);
        $encoded2 = sodium_bin2base64($key2, SODIUM_BASE64_VARIANT_ORIGINAL);

        $_ENV['AUTH_ENCRYPTION_KEYS'] = "k1:{$encoded1},k2:{$encoded2}";
        $_ENV['AUTH_ENCRYPTION_ACTIVE_KID'] = 'k2';

        $manager = new EncryptionKeyManager($this->tmpDir);
        $keyring = $manager->getKeyring();

        $this->assertSame('k2', $keyring['active_kid']);
        $this->assertSame($key2, $keyring['active_key']);
        $this->assertCount(2, $keyring['keys']);
        $this->assertSame($key1, $keyring['keys']['k1']);
        $this->assertSame($key2, $keyring['keys']['k2']);
    }

    public function testMultiKeyDefaultsToFirstKid(): void
    {
        $key1 = sodium_crypto_secretbox_keygen();
        $encoded1 = sodium_bin2base64($key1, SODIUM_BASE64_VARIANT_ORIGINAL);

        $_ENV['AUTH_ENCRYPTION_KEYS'] = "primary:{$encoded1}";

        $manager = new EncryptionKeyManager($this->tmpDir);
        $keyring = $manager->getKeyring();

        $this->assertSame('primary', $keyring['active_kid']);
    }

    public function testInvalidActiveKidThrows(): void
    {
        $key = sodium_crypto_secretbox_keygen();
        $encoded = sodium_bin2base64($key, SODIUM_BASE64_VARIANT_ORIGINAL);

        $_ENV['AUTH_ENCRYPTION_KEYS'] = "k1:{$encoded}";
        $_ENV['AUTH_ENCRYPTION_ACTIVE_KID'] = 'nonexistent';

        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('AUTH_ENCRYPTION_ACTIVE_KID must reference a key');

        $manager = new EncryptionKeyManager($this->tmpDir);
        $manager->getKeyring();
    }

    public function testDuplicateKidThrows(): void
    {
        $key = sodium_crypto_secretbox_keygen();
        $encoded = sodium_bin2base64($key, SODIUM_BASE64_VARIANT_ORIGINAL);

        $_ENV['AUTH_ENCRYPTION_KEYS'] = "k1:{$encoded},k1:{$encoded}";

        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('duplicate key id');

        $manager = new EncryptionKeyManager($this->tmpDir);
        $manager->getKeyring();
    }

    public function testInvalidBase64Throws(): void
    {
        $_ENV['AUTH_ENCRYPTION_KEY'] = 'not-valid-base64!!!';

        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('base64-encoded');

        $manager = new EncryptionKeyManager($this->tmpDir);
        $manager->getKeyring();
    }

    public function testWrongKeySizeThrows(): void
    {
        $short = sodium_bin2base64(random_bytes(16), SODIUM_BASE64_VARIANT_ORIGINAL);
        $_ENV['AUTH_ENCRYPTION_KEY'] = $short;

        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('32-byte');

        $manager = new EncryptionKeyManager($this->tmpDir);
        $manager->getKeyring();
    }

    public function testBadKeyListFormatThrows(): void
    {
        $_ENV['AUTH_ENCRYPTION_KEYS'] = 'no-colon-here';

        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('kid:base64 format');

        $manager = new EncryptionKeyManager($this->tmpDir);
        $manager->getKeyring();
    }

    public function testAutoGeneratesAndPersistsKey(): void
    {
        file_put_contents($this->tmpDir . '/.env', "OTHER=value\n");

        $manager = new EncryptionKeyManager($this->tmpDir);
        $keyring = $manager->getKeyring();

        $this->assertSame('legacy', $keyring['active_kid']);
        $this->assertSame(SODIUM_CRYPTO_SECRETBOX_KEYBYTES, strlen($keyring['active_key']));

        $envContents = file_get_contents($this->tmpDir . '/.env');
        $this->assertStringContainsString('AUTH_ENCRYPTION_KEY=', $envContents);
    }

    public function testAutoGeneratesNewEnvFile(): void
    {
        $manager = new EncryptionKeyManager($this->tmpDir);
        $keyring = $manager->getKeyring();

        $this->assertSame('legacy', $keyring['active_kid']);
        $this->assertTrue(file_exists($this->tmpDir . '/.env'));
    }
}
