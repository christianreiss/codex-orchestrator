<?php

declare(strict_types=1);

use App\Services\Wrapper\V2\ConfigSigner;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

/**
 * Round-trip check: ConfigSigner consumes the PEM-encoded private key from
 * scripts/wrapper-v2-init-keys.sh and produces a base64 signature that the Go
 * binary's signing package can verify with the matching pubkey.
 *
 * We exercise the parser by emitting a key with openssl genpkey at test setup,
 * signing a payload, and verifying it with libsodium's public-key API.
 */
final class WrapperV2ConfigSignerTest extends TestCase
{
    private string $privPath;
    private string $pubPath;

    protected function setUp(): void
    {
        if (!function_exists('sodium_crypto_sign_verify_detached')) {
            $this->markTestSkipped('libsodium unavailable');
        }
        $dir = sys_get_temp_dir() . '/wrapper-v2-signer-' . uniqid('', true);
        mkdir($dir);
        $this->privPath = $dir . '/signing.ed25519';
        $this->pubPath = $dir . '/signing.ed25519.pub';
        exec('openssl genpkey -algorithm Ed25519 -outform PEM -out ' . escapeshellarg($this->privPath) . ' 2>/dev/null', $_, $rc);
        if ($rc !== 0 || !is_file($this->privPath)) {
            $this->markTestSkipped('openssl Ed25519 generation unavailable');
        }
        exec('openssl pkey -in ' . escapeshellarg($this->privPath) . ' -pubout -outform PEM -out ' . escapeshellarg($this->pubPath) . ' 2>/dev/null');
    }

    protected function tearDown(): void
    {
        @unlink($this->privPath);
        @unlink($this->pubPath);
        @rmdir(dirname($this->privPath));
    }

    public function testSignerProducesVerifiableSignature(): void
    {
        $signer = new ConfigSigner($this->privPath);
        $payload = '{"engine":"codex","host":{"id":42}}';
        $sigB64 = $signer->sign($payload);
        $sig = base64_decode($sigB64, true);
        $this->assertIsString($sig);
        $this->assertSame(SODIUM_CRYPTO_SIGN_BYTES, strlen($sig));

        // Pull the raw 32-byte public key out of the PEM so libsodium can verify.
        $pubPem = (string) file_get_contents($this->pubPath);
        $der = base64_decode(preg_replace('/-----[^-]+-----|\s+/', '', $pubPem) ?? '', true);
        $this->assertIsString($der);
        $rawPub = substr($der, -32);
        $this->assertTrue(sodium_crypto_sign_verify_detached($sig, $payload, $rawPub));
    }
}
