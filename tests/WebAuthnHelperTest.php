<?php

declare(strict_types=1);

use App\Support\WebAuthnHelper;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class WebAuthnHelperTest extends TestCase
{
    public function testBase64urlRoundTrip(): void
    {
        $data = random_bytes(32);
        $encoded = WebAuthnHelper::base64urlEncode($data);
        $decoded = WebAuthnHelper::base64urlDecode($encoded);
        self::assertSame($data, $decoded);
        // Must not contain + / =
        self::assertStringNotContainsString('+', $encoded);
        self::assertStringNotContainsString('/', $encoded);
        self::assertStringNotContainsString('=', $encoded);
    }

    public function testParseAuthDataMinimal(): void
    {
        // Build minimal auth data: 32-byte rpIdHash + 1 byte flags + 4 bytes signCount
        $rpIdHash = hash('sha256', 'example.com', true);
        $flags = 0x01; // UP only
        $signCount = pack('N', 42);
        $authData = $rpIdHash . chr($flags) . $signCount;

        $parsed = WebAuthnHelper::parseAuthData($authData);

        self::assertSame($rpIdHash, $parsed['rpIdHash']);
        self::assertSame($flags, $parsed['flags']);
        self::assertTrue($parsed['flagsDetail']['UP']);
        self::assertFalse($parsed['flagsDetail']['UV']);
        self::assertFalse($parsed['flagsDetail']['AT']);
        self::assertFalse($parsed['flagsDetail']['ED']);
        self::assertSame(42, $parsed['signCount']);
        self::assertNull($parsed['credentialId']);
        self::assertNull($parsed['credentialPublicKey']);
    }

    public function testParseAuthDataTooShort(): void
    {
        $this->expectException(\RuntimeException::class);
        WebAuthnHelper::parseAuthData(str_repeat("\x00", 36));
    }

    public function testCoseEc2KeyToPemProducesValidKey(): void
    {
        // Generate an EC P-256 key pair.
        $key = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
        self::assertNotFalse($key);
        $details = openssl_pkey_get_details($key);
        $x = $details['ec']['x'];
        $y = $details['ec']['y'];

        // Pad to 32 bytes each.
        $x = str_pad($x, 32, "\x00", STR_PAD_LEFT);
        $y = str_pad($y, 32, "\x00", STR_PAD_LEFT);

        $coseKey = [
            1 => 2,   // kty: EC2
            3 => -7,  // alg: ES256
            -1 => 1,  // crv: P-256
            -2 => $x,
            -3 => $y,
        ];

        $pem = WebAuthnHelper::coseKeyToPem($coseKey, WebAuthnHelper::COSE_ALG_ES256);
        self::assertStringContainsString('BEGIN PUBLIC KEY', $pem);

        // Verify we can load it back.
        $loaded = openssl_pkey_get_public($pem);
        self::assertNotFalse($loaded);
        $loadedDetails = openssl_pkey_get_details($loaded);
        self::assertSame(OPENSSL_KEYTYPE_EC, $loadedDetails['type']);
    }

    public function testCoseRsaKeyToPemProducesValidKey(): void
    {
        // Generate RSA key pair.
        $key = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        self::assertNotFalse($key);
        $details = openssl_pkey_get_details($key);
        $n = $details['rsa']['n'];
        $e = $details['rsa']['e'];

        $coseKey = [
            1 => 3,     // kty: RSA
            3 => -257,  // alg: RS256
            -1 => $n,
            -2 => $e,
        ];

        $pem = WebAuthnHelper::coseKeyToPem($coseKey, WebAuthnHelper::COSE_ALG_RS256);
        self::assertStringContainsString('BEGIN PUBLIC KEY', $pem);

        // Verify we can load it back.
        $loaded = openssl_pkey_get_public($pem);
        self::assertNotFalse($loaded);
        $loadedDetails = openssl_pkey_get_details($loaded);
        self::assertSame(OPENSSL_KEYTYPE_RSA, $loadedDetails['type']);
    }

    public function testVerifySignatureEs256(): void
    {
        // Generate EC P-256 key pair.
        $key = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
        $details = openssl_pkey_get_details($key);
        $x = str_pad($details['ec']['x'], 32, "\x00", STR_PAD_LEFT);
        $y = str_pad($details['ec']['y'], 32, "\x00", STR_PAD_LEFT);

        $coseKey = [1 => 2, 3 => -7, -1 => 1, -2 => $x, -3 => $y];
        $pem = WebAuthnHelper::coseKeyToPem($coseKey, WebAuthnHelper::COSE_ALG_ES256);

        // Build test data.
        $rpIdHash = hash('sha256', 'example.com', true);
        $authData = $rpIdHash . chr(0x01) . pack('N', 1);
        $clientDataJSON = '{"type":"webauthn.get","challenge":"test","origin":"https://example.com"}';

        // Sign with the private key (DER format).
        $signedData = $authData . hash('sha256', $clientDataJSON, true);
        $derSignature = '';
        openssl_sign($signedData, $derSignature, $key, OPENSSL_ALGO_SHA256);

        // Convert DER to IEEE P1363 (r||s) format.
        $p1363Signature = self::derToP1363($derSignature, 32);

        // Verify.
        $result = WebAuthnHelper::verifySignature($authData, $clientDataJSON, $p1363Signature, $pem, WebAuthnHelper::COSE_ALG_ES256);
        self::assertTrue($result);

        // Verify with tampered data fails.
        $result2 = WebAuthnHelper::verifySignature($authData, $clientDataJSON . 'x', $p1363Signature, $pem, WebAuthnHelper::COSE_ALG_ES256);
        self::assertFalse($result2);
    }

    public function testVerifySignatureEs256AcceptsDerSignature(): void
    {
        $key = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
        $details = openssl_pkey_get_details($key);

        $x = str_pad(substr($details['ec']['x'], -32), 32, "\x00", STR_PAD_LEFT);
        $y = str_pad(substr($details['ec']['y'], -32), 32, "\x00", STR_PAD_LEFT);

        $coseKey = [1 => 2, 3 => -7, -1 => 1, -2 => $x, -3 => $y];
        $pem = WebAuthnHelper::coseKeyToPem($coseKey, WebAuthnHelper::COSE_ALG_ES256);

        $rpIdHash = hash('sha256', 'example.com', true);
        $authData = $rpIdHash . chr(0x01) . pack('N', 1);
        $clientDataJSON = '{"type":"webauthn.get","challenge":"test","origin":"https://example.com"}';

        $signedData = $authData . hash('sha256', $clientDataJSON, true);
        $derSignature = '';
        openssl_sign($signedData, $derSignature, $key, OPENSSL_ALGO_SHA256);

        self::assertTrue(
            WebAuthnHelper::verifySignature($authData, $clientDataJSON, $derSignature, $pem, WebAuthnHelper::COSE_ALG_ES256)
        );
    }

    public function testVerifySignatureRs256(): void
    {
        // Generate RSA key pair.
        $key = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        $details = openssl_pkey_get_details($key);

        $coseKey = [1 => 3, 3 => -257, -1 => $details['rsa']['n'], -2 => $details['rsa']['e']];
        $pem = WebAuthnHelper::coseKeyToPem($coseKey, WebAuthnHelper::COSE_ALG_RS256);

        $rpIdHash = hash('sha256', 'example.com', true);
        $authData = $rpIdHash . chr(0x01) . pack('N', 1);
        $clientDataJSON = '{"type":"webauthn.get","challenge":"test","origin":"https://example.com"}';

        $signedData = $authData . hash('sha256', $clientDataJSON, true);
        $signature = '';
        openssl_sign($signedData, $signature, $key, OPENSSL_ALGO_SHA256);

        $result = WebAuthnHelper::verifySignature($authData, $clientDataJSON, $signature, $pem, WebAuthnHelper::COSE_ALG_RS256);
        self::assertTrue($result);
    }

    public function testParseAttestationObject(): void
    {
        // Build a minimal CBOR attestation object.
        $rpIdHash = hash('sha256', 'example.com', true);
        $flags = chr(0x41); // UP + AT
        $signCount = pack('N', 0);
        $aaguid = str_repeat("\x00", 16);
        $credId = random_bytes(32);
        $credIdLen = pack('n', strlen($credId));

        // Minimal COSE key (not a real key, just enough for parsing).
        $encoder = new \CBOR\MapObject();
        $encoder->add(
            \CBOR\UnsignedIntegerObject::create(1),
            \CBOR\UnsignedIntegerObject::create(2)
        );
        $coseKeyBytes = (string) $encoder;

        $authData = $rpIdHash . $flags . $signCount . $aaguid . $credIdLen . $credId . $coseKeyBytes;

        // Build CBOR attestation object.
        $attObj = new \CBOR\MapObject();
        $attObj->add(
            \CBOR\TextStringObject::create('fmt'),
            \CBOR\TextStringObject::create('none')
        );
        $attObj->add(
            \CBOR\TextStringObject::create('authData'),
            \CBOR\ByteStringObject::create($authData)
        );
        $attObj->add(
            \CBOR\TextStringObject::create('attStmt'),
            \CBOR\MapObject::create()
        );

        $cborBytes = (string) $attObj;
        $result = WebAuthnHelper::parseAttestationObject($cborBytes);

        self::assertSame('none', $result['fmt']);
        self::assertSame($authData, $result['authData']);
    }

    public function testUnsupportedAlgorithmThrows(): void
    {
        $this->expectException(\RuntimeException::class);
        WebAuthnHelper::coseKeyToPem([1 => 2], 999);
    }

    /**
     * Convert DER-encoded ECDSA signature to IEEE P1363 format (r||s).
     */
    private static function derToP1363(string $der, int $componentLength): string
    {
        $offset = 2; // Skip SEQUENCE tag + length
        // Read r
        if (ord($der[$offset]) !== 0x02) {
            throw new \RuntimeException('Invalid DER');
        }
        $offset++;
        $rLen = ord($der[$offset]);
        $offset++;
        $r = substr($der, $offset, $rLen);
        $offset += $rLen;

        // Read s
        if (ord($der[$offset]) !== 0x02) {
            throw new \RuntimeException('Invalid DER');
        }
        $offset++;
        $sLen = ord($der[$offset]);
        $offset++;
        $s = substr($der, $offset, $sLen);

        // Strip leading zeros and pad to componentLength.
        $r = ltrim($r, "\x00");
        $s = ltrim($s, "\x00");
        $r = str_pad($r, $componentLength, "\x00", STR_PAD_LEFT);
        $s = str_pad($s, $componentLength, "\x00", STR_PAD_LEFT);

        return $r . $s;
    }
}
