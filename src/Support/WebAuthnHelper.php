<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Support;

use CBOR\Decoder;
use CBOR\MapObject;
use CBOR\Normalizable;
use CBOR\StringStream;
use ParagonIE\ConstantTime\Base64UrlSafe;

class WebAuthnHelper
{
    public const COSE_ALG_ES256 = -7;
    public const COSE_ALG_RS256 = -257;

    private const COSE_KTY_EC2 = 2;
    private const COSE_KTY_RSA = 3;
    private const COSE_CRV_P256 = 1;

    public static function base64urlDecode(string $data): string
    {
        return Base64UrlSafe::decode($data, false);
    }

    public static function base64urlEncode(string $data): string
    {
        return Base64UrlSafe::encodeUnpadded($data);
    }

    /**
     * Parse raw authenticator data per WebAuthn spec section 6.1.
     *
     * @return array{rpIdHash: string, flags: int, flagsDetail: array, signCount: int, aaguid: ?string, credentialId: ?string, credentialPublicKey: ?array}
     */
    public static function parseAuthData(string $authData): array
    {
        if (strlen($authData) < 37) {
            throw new \RuntimeException('Authenticator data too short');
        }

        $rpIdHash = substr($authData, 0, 32);
        $flags = ord($authData[32]);
        $signCount = unpack('N', substr($authData, 33, 4))[1];

        $result = [
            'rpIdHash' => $rpIdHash,
            'flags' => $flags,
            'flagsDetail' => [
                'UP' => (bool) ($flags & 0x01),
                'UV' => (bool) ($flags & 0x04),
                'AT' => (bool) ($flags & 0x40),
                'ED' => (bool) ($flags & 0x80),
            ],
            'signCount' => $signCount,
            'aaguid' => null,
            'credentialId' => null,
            'credentialPublicKey' => null,
        ];

        if (!($flags & 0x40)) {
            return $result;
        }

        // Attested credential data present.
        if (strlen($authData) < 55) {
            throw new \RuntimeException('Authenticator data too short for attested credential data');
        }

        $aaguid = substr($authData, 37, 16);
        $credIdLen = unpack('n', substr($authData, 53, 2))[1];

        if (strlen($authData) < 55 + $credIdLen) {
            throw new \RuntimeException('Authenticator data too short for credential ID');
        }

        $credentialId = substr($authData, 55, $credIdLen);
        $coseKeyBytes = substr($authData, 55 + $credIdLen);

        $decoder = Decoder::create();
        $coseKeyObj = $decoder->decode(new StringStream($coseKeyBytes));

        $coseKey = null;
        if ($coseKeyObj instanceof MapObject) {
            $coseKey = $coseKeyObj->normalize();
        }

        // Format AAGUID as UUID.
        $aaguidHex = bin2hex($aaguid);
        $aaguidFormatted = sprintf(
            '%s-%s-%s-%s-%s',
            substr($aaguidHex, 0, 8),
            substr($aaguidHex, 8, 4),
            substr($aaguidHex, 12, 4),
            substr($aaguidHex, 16, 4),
            substr($aaguidHex, 20, 12)
        );

        $result['aaguid'] = $aaguidFormatted;
        $result['credentialId'] = $credentialId;
        $result['credentialPublicKey'] = $coseKey;

        return $result;
    }

    /**
     * Convert a normalized COSE key map to PEM public key.
     */
    public static function coseKeyToPem(array $coseKey, int $alg): string
    {
        $kty = $coseKey[1] ?? null;

        if ($alg === self::COSE_ALG_ES256) {
            return self::ec2KeyToPem($coseKey);
        }

        if ($alg === self::COSE_ALG_RS256) {
            return self::rsaKeyToPem($coseKey);
        }

        throw new \RuntimeException('Unsupported COSE algorithm: ' . $alg);
    }

    /**
     * Verify a WebAuthn assertion signature.
     */
    public static function verifySignature(
        string $authData,
        string $clientDataJSON,
        string $signature,
        string $publicKeyPem,
        int $coseAlg
    ): bool {
        $clientDataHash = hash('sha256', $clientDataJSON, true);
        $signedData = $authData . $clientDataHash;

        if ($coseAlg === self::COSE_ALG_ES256) {
            $derSignature = self::looksLikeDerSignature($signature)
                ? $signature
                : self::ecSignatureToDer($signature);
            $result = openssl_verify($signedData, $derSignature, $publicKeyPem, OPENSSL_ALGO_SHA256);
        } elseif ($coseAlg === self::COSE_ALG_RS256) {
            $result = openssl_verify($signedData, $signature, $publicKeyPem, OPENSSL_ALGO_SHA256);
        } else {
            throw new \RuntimeException('Unsupported COSE algorithm for verification: ' . $coseAlg);
        }

        return $result === 1;
    }

    /**
     * Decode a CBOR attestation object and return its components.
     *
     * @return array{fmt: string, attStmt: mixed, authData: string}
     */
    public static function parseAttestationObject(string $cborBytes): array
    {
        $decoder = Decoder::create();
        $obj = $decoder->decode(new StringStream($cborBytes));

        if (!$obj instanceof MapObject) {
            throw new \RuntimeException('Attestation object is not a CBOR map');
        }

        $normalized = $obj->normalize();

        $fmt = $normalized['fmt'] ?? null;
        $authData = $normalized['authData'] ?? null;
        $attStmt = $normalized['attStmt'] ?? [];

        if (!is_string($fmt)) {
            throw new \RuntimeException('Missing or invalid attestation format');
        }
        if (!is_string($authData)) {
            throw new \RuntimeException('Missing or invalid authData in attestation object');
        }

        return [
            'fmt' => $fmt,
            'attStmt' => $attStmt,
            'authData' => $authData,
        ];
    }

    private static function ec2KeyToPem(array $coseKey): string
    {
        $kty = self::normalizeCoseInt($coseKey[1] ?? null);
        $crv = self::normalizeCoseInt($coseKey[-1] ?? null);
        $x = $coseKey[-2] ?? null;
        $y = $coseKey[-3] ?? null;

        if ($kty !== self::COSE_KTY_EC2) {
            throw new \RuntimeException('Expected EC2 key type, got: ' . $kty);
        }
        if ($crv !== self::COSE_CRV_P256) {
            throw new \RuntimeException('Only P-256 curve is supported, got: ' . $crv);
        }
        if (!is_string($x) || strlen($x) !== 32) {
            throw new \RuntimeException('Invalid EC2 x coordinate');
        }
        if (!is_string($y) || strlen($y) !== 32) {
            throw new \RuntimeException('Invalid EC2 y coordinate');
        }

        // Uncompressed EC point: 0x04 || x || y
        $uncompressed = "\x04" . $x . $y;

        // SubjectPublicKeyInfo DER header for P-256
        // SEQUENCE { SEQUENCE { OID ecPublicKey, OID prime256v1 }, BIT STRING { uncompressed point } }
        $der = "\x30\x59"                         // SEQUENCE (89 bytes)
             . "\x30\x13"                         //   SEQUENCE (19 bytes)
             . "\x06\x07\x2a\x86\x48\xce\x3d\x02\x01" //     OID 1.2.840.10045.2.1 (ecPublicKey)
             . "\x06\x08\x2a\x86\x48\xce\x3d\x03\x01\x07" //     OID 1.2.840.10045.3.1.7 (prime256v1)
             . "\x03\x42\x00"                     //   BIT STRING (66 bytes, 0 unused bits)
             . $uncompressed;

        return "-----BEGIN PUBLIC KEY-----\n"
             . chunk_split(base64_encode($der), 64, "\n")
             . "-----END PUBLIC KEY-----\n";
    }

    private static function rsaKeyToPem(array $coseKey): string
    {
        $kty = self::normalizeCoseInt($coseKey[1] ?? null);
        $n = $coseKey[-1] ?? null;
        $e = $coseKey[-2] ?? null;

        if ($kty !== self::COSE_KTY_RSA) {
            throw new \RuntimeException('Expected RSA key type, got: ' . $kty);
        }
        if (!is_string($n) || $n === '') {
            throw new \RuntimeException('Invalid RSA modulus');
        }
        if (!is_string($e) || $e === '') {
            throw new \RuntimeException('Invalid RSA exponent');
        }

        // Build RSAPublicKey: SEQUENCE { INTEGER(n), INTEGER(e) }
        $rsaPubKey = self::derSequence(
            self::derInteger($n) . self::derInteger($e)
        );

        // Wrap in SubjectPublicKeyInfo: SEQUENCE { SEQUENCE { OID rsaEncryption, NULL }, BIT STRING { RSAPublicKey } }
        $algoSeq = self::derSequence(
            "\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01" // OID 1.2.840.113549.1.1.1 (rsaEncryption)
            . "\x05\x00" // NULL
        );

        $bitString = "\x00" . $rsaPubKey; // 0 unused bits
        $spki = self::derSequence(
            $algoSeq . "\x03" . self::derLength(strlen($bitString)) . $bitString
        );

        return "-----BEGIN PUBLIC KEY-----\n"
             . chunk_split(base64_encode($spki), 64, "\n")
             . "-----END PUBLIC KEY-----\n";
    }

    /**
     * Convert IEEE P1363 ECDSA signature (r||s) to DER format for OpenSSL.
     */
    private static function ecSignatureToDer(string $raw): string
    {
        $len = strlen($raw);
        if ($len < 2 || $len % 2 !== 0) {
            throw new \RuntimeException('Invalid EC signature length: ' . $len);
        }

        $half = $len / 2;
        $r = substr($raw, 0, $half);
        $s = substr($raw, $half);

        // Strip leading zero bytes but keep at least one byte.
        $r = ltrim($r, "\x00") ?: "\x00";
        $s = ltrim($s, "\x00") ?: "\x00";

        // Ensure positive: prepend 0x00 if high bit set.
        if (ord($r[0]) & 0x80) {
            $r = "\x00" . $r;
        }
        if (ord($s[0]) & 0x80) {
            $s = "\x00" . $s;
        }

        $rDer = "\x02" . chr(strlen($r)) . $r;
        $sDer = "\x02" . chr(strlen($s)) . $s;
        $inner = $rDer . $sDer;

        return "\x30" . self::derLength(strlen($inner)) . $inner;
    }

    private static function looksLikeDerSignature(string $signature): bool
    {
        if (strlen($signature) < 8 || $signature[0] !== "\x30") {
            return false;
        }

        $lengthByte = ord($signature[1]);
        if ($lengthByte < 0x80) {
            return strlen($signature) === $lengthByte + 2;
        }

        if ($lengthByte === 0x81 && isset($signature[2])) {
            return strlen($signature) === ord($signature[2]) + 3;
        }

        if ($lengthByte === 0x82 && isset($signature[2], $signature[3])) {
            $bodyLength = (ord($signature[2]) << 8) | ord($signature[3]);
            return strlen($signature) === $bodyLength + 4;
        }

        return false;
    }

    private static function derInteger(string $bytes): string
    {
        // Strip leading zeroes but keep at least one byte.
        $bytes = ltrim($bytes, "\x00") ?: "\x00";

        // Ensure positive: prepend 0x00 if high bit set.
        if (ord($bytes[0]) & 0x80) {
            $bytes = "\x00" . $bytes;
        }

        return "\x02" . self::derLength(strlen($bytes)) . $bytes;
    }

    private static function derSequence(string $contents): string
    {
        return "\x30" . self::derLength(strlen($contents)) . $contents;
    }

    private static function derLength(int $len): string
    {
        if ($len < 0x80) {
            return chr($len);
        }
        if ($len < 0x100) {
            return "\x81" . chr($len);
        }

        return "\x82" . pack('n', $len);
    }

    private static function normalizeCoseInt(mixed $value): ?int
    {
        if (is_int($value)) {
            return $value;
        }
        if (is_string($value) && preg_match('/^-?\d+$/', $value) === 1) {
            return (int) $value;
        }

        return null;
    }
}
