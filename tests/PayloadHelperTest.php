<?php

declare(strict_types=1);

use App\Http\PayloadHelper;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class PayloadHelperTest extends TestCase
{
    // -------------------------------------------------------------------------
    // extractSyncAuthFingerprint
    // -------------------------------------------------------------------------

    public function testExtractSyncAuthFingerprintReturnsDefaultsForNull(): void
    {
        $defaultDigest = hash('sha256', '{"last_refresh":"2000-01-01T00:00:00Z","auths":{}}');
        $result = PayloadHelper::extractSyncAuthFingerprint(null);

        $this->assertSame('retrieve', $result['command']);
        $this->assertSame('2000-01-01T00:00:00Z', $result['last_refresh']);
        $this->assertSame($defaultDigest, $result['digest']);
        $this->assertArrayNotHasKey('installation_id', $result);
    }

    public function testExtractSyncAuthFingerprintReturnsDefaultsForEmptyArray(): void
    {
        $result = PayloadHelper::extractSyncAuthFingerprint([]);

        $this->assertSame('retrieve', $result['command']);
        $this->assertSame('2000-01-01T00:00:00Z', $result['last_refresh']);
        $this->assertArrayNotHasKey('installation_id', $result);
    }

    public function testExtractSyncAuthFingerprintReturnsDefaultsForNonArray(): void
    {
        $defaultDigest = hash('sha256', '{"last_refresh":"2000-01-01T00:00:00Z","auths":{}}');

        $result = PayloadHelper::extractSyncAuthFingerprint('not-an-array');
        $this->assertSame($defaultDigest, $result['digest']);

        $result = PayloadHelper::extractSyncAuthFingerprint(42);
        $this->assertSame($defaultDigest, $result['digest']);
    }

    public function testExtractSyncAuthFingerprintExtractsLastRefreshFromFlatArray(): void
    {
        $result = PayloadHelper::extractSyncAuthFingerprint(['last_refresh' => '2024-01-15T12:30:00Z']);

        $this->assertSame('2024-01-15T12:30:00Z', $result['last_refresh']);
    }

    public function testExtractSyncAuthFingerprintExtractsFromAuthSubkey(): void
    {
        $payload = [
            'auth' => [
                'last_refresh' => '2024-05-01T00:00:00Z',
                'digest' => str_repeat('a', 64),
            ],
        ];
        $result = PayloadHelper::extractSyncAuthFingerprint($payload);

        $this->assertSame('2024-05-01T00:00:00Z', $result['last_refresh']);
        $this->assertSame(str_repeat('a', 64), $result['digest']);
    }

    public function testExtractSyncAuthFingerprintIgnoresFlatKeysWhenAuthSubkeyPresent(): void
    {
        $payload = [
            'auth' => ['last_refresh' => '2024-05-01T00:00:00Z'],
            'last_refresh' => '1999-01-01T00:00:00Z',
        ];
        $result = PayloadHelper::extractSyncAuthFingerprint($payload);

        // auth subkey takes precedence
        $this->assertSame('2024-05-01T00:00:00Z', $result['last_refresh']);
    }

    public function testExtractSyncAuthFingerprintAcceptsValidHexDigest(): void
    {
        $digest = str_repeat('b', 64);
        $result = PayloadHelper::extractSyncAuthFingerprint(['digest' => $digest]);

        $this->assertSame($digest, $result['digest']);
    }

    public function testExtractSyncAuthFingerprintNormalizesDigestToLowercase(): void
    {
        $upper = strtoupper(str_repeat('1a', 32));
        $result = PayloadHelper::extractSyncAuthFingerprint(['digest' => $upper]);

        $this->assertSame(strtolower($upper), $result['digest']);
    }

    public function testExtractSyncAuthFingerprintRejectsDigestTooShort(): void
    {
        $defaultDigest = hash('sha256', '{"last_refresh":"2000-01-01T00:00:00Z","auths":{}}');
        $result = PayloadHelper::extractSyncAuthFingerprint(['digest' => str_repeat('a', 63)]);

        $this->assertSame($defaultDigest, $result['digest']);
    }

    public function testExtractSyncAuthFingerprintRejectsDigestWithNonHexChars(): void
    {
        $defaultDigest = hash('sha256', '{"last_refresh":"2000-01-01T00:00:00Z","auths":{}}');
        $result = PayloadHelper::extractSyncAuthFingerprint(['digest' => str_repeat('z', 64)]);

        $this->assertSame($defaultDigest, $result['digest']);
    }

    public function testExtractSyncAuthFingerprintRejectsTooLongDigest(): void
    {
        $defaultDigest = hash('sha256', '{"last_refresh":"2000-01-01T00:00:00Z","auths":{}}');
        // 65 hex chars — one too many; preg_match requires exactly 64
        $result = PayloadHelper::extractSyncAuthFingerprint(['digest' => str_repeat('a', 65)]);

        $this->assertSame($defaultDigest, $result['digest']);
    }

    public function testExtractSyncAuthFingerprintUsesDefaultForEmptyLastRefresh(): void
    {
        $result = PayloadHelper::extractSyncAuthFingerprint(['last_refresh' => '   ']);

        $this->assertSame('2000-01-01T00:00:00Z', $result['last_refresh']);
    }

    public function testExtractSyncAuthFingerprintIncludesInstallationId(): void
    {
        $result = PayloadHelper::extractSyncAuthFingerprint(['installation_id' => 'inst-abc-123']);

        $this->assertSame('inst-abc-123', $result['installation_id']);
    }

    public function testExtractSyncAuthFingerprintTrimsInstallationId(): void
    {
        $result = PayloadHelper::extractSyncAuthFingerprint(['installation_id' => '  inst-abc  ']);

        $this->assertSame('inst-abc', $result['installation_id']);
    }

    public function testExtractSyncAuthFingerprintExcludesEmptyInstallationId(): void
    {
        $result = PayloadHelper::extractSyncAuthFingerprint(['installation_id' => '']);

        $this->assertArrayNotHasKey('installation_id', $result);
    }

    public function testExtractSyncAuthFingerprintExcludesWhitespaceOnlyInstallationId(): void
    {
        $result = PayloadHelper::extractSyncAuthFingerprint(['installation_id' => '   ']);

        $this->assertArrayNotHasKey('installation_id', $result);
    }

    public function testExtractSyncAuthFingerprintExcludesNonStringInstallationId(): void
    {
        $result = PayloadHelper::extractSyncAuthFingerprint(['installation_id' => 123]);

        $this->assertArrayNotHasKey('installation_id', $result);
    }

    public function testExtractSyncAuthFingerprintCommandIsAlwaysRetrieve(): void
    {
        // The 'command' key in payload must never override the fixed 'retrieve' value
        $result = PayloadHelper::extractSyncAuthFingerprint(['command' => 'store']);

        $this->assertSame('retrieve', $result['command']);
    }

    public function testExtractSyncAuthFingerprintHandlesAuthSubkeyWithNonArrayValue(): void
    {
        // 'auth' key present but not an array — should fall back to flat extraction
        $payload = ['auth' => 'not-an-array', 'last_refresh' => '2024-06-01T00:00:00Z'];
        $result = PayloadHelper::extractSyncAuthFingerprint($payload);

        $this->assertSame('2024-06-01T00:00:00Z', $result['last_refresh']);
    }

    // -------------------------------------------------------------------------
    // extractSyncAuthCandidate
    // -------------------------------------------------------------------------

    public function testExtractSyncAuthCandidateReturnsNullForNull(): void
    {
        $this->assertNull(PayloadHelper::extractSyncAuthCandidate(null));
    }

    public function testExtractSyncAuthCandidateReturnsNullForString(): void
    {
        $this->assertNull(PayloadHelper::extractSyncAuthCandidate('not-an-array'));
    }

    public function testExtractSyncAuthCandidateReturnsNullForInt(): void
    {
        $this->assertNull(PayloadHelper::extractSyncAuthCandidate(42));
    }

    public function testExtractSyncAuthCandidateReturnsNullForEmptyArray(): void
    {
        $this->assertNull(PayloadHelper::extractSyncAuthCandidate([]));
    }

    public function testExtractSyncAuthCandidateReturnsNullWhenKeyMissing(): void
    {
        $this->assertNull(PayloadHelper::extractSyncAuthCandidate(['other_key' => ['data']]));
    }

    public function testExtractSyncAuthCandidateReturnsCandidateArray(): void
    {
        $candidate = ['last_refresh' => '2024-01-01T00:00:00Z', 'auths' => []];
        $result = PayloadHelper::extractSyncAuthCandidate(['auth_candidate' => $candidate]);

        $this->assertSame($candidate, $result);
    }

    public function testExtractSyncAuthCandidateReturnsNullWhenCandidateIsString(): void
    {
        $this->assertNull(PayloadHelper::extractSyncAuthCandidate(['auth_candidate' => 'string']));
    }

    public function testExtractSyncAuthCandidateReturnsNullWhenCandidateIsNull(): void
    {
        $this->assertNull(PayloadHelper::extractSyncAuthCandidate(['auth_candidate' => null]));
    }

    public function testExtractSyncAuthCandidateReturnsNullWhenCandidateIsInt(): void
    {
        $this->assertNull(PayloadHelper::extractSyncAuthCandidate(['auth_candidate' => 0]));
    }

    public function testExtractSyncAuthCandidateReturnsEmptyArrayCandidate(): void
    {
        // An empty array is still a valid (non-null) candidate
        $result = PayloadHelper::extractSyncAuthCandidate(['auth_candidate' => []]);

        $this->assertSame([], $result);
    }

    // -------------------------------------------------------------------------
    // extractSyncHostUserInput
    // -------------------------------------------------------------------------

    public function testExtractSyncHostUserInputReturnsNullsForNull(): void
    {
        $result = PayloadHelper::extractSyncHostUserInput(null);

        $this->assertNull($result['username']);
        $this->assertNull($result['hostname']);
    }

    public function testExtractSyncHostUserInputReturnsNullsForNonArray(): void
    {
        $result = PayloadHelper::extractSyncHostUserInput('string');

        $this->assertNull($result['username']);
        $this->assertNull($result['hostname']);
    }

    public function testExtractSyncHostUserInputReturnsNullsForEmptyArray(): void
    {
        $result = PayloadHelper::extractSyncHostUserInput([]);

        $this->assertNull($result['username']);
        $this->assertNull($result['hostname']);
    }

    public function testExtractSyncHostUserInputExtractsFromFlatArray(): void
    {
        $result = PayloadHelper::extractSyncHostUserInput([
            'username' => 'alice',
            'hostname' => 'myhost.local',
        ]);

        $this->assertSame('alice', $result['username']);
        $this->assertSame('myhost.local', $result['hostname']);
    }

    public function testExtractSyncHostUserInputExtractsFromHostUserSubkey(): void
    {
        $result = PayloadHelper::extractSyncHostUserInput([
            'host_user' => [
                'username' => 'bob',
                'hostname' => 'server.test',
            ],
        ]);

        $this->assertSame('bob', $result['username']);
        $this->assertSame('server.test', $result['hostname']);
    }

    public function testExtractSyncHostUserInputPreferesHostUserSubkeyOverFlatKeys(): void
    {
        $result = PayloadHelper::extractSyncHostUserInput([
            'host_user' => ['username' => 'alice', 'hostname' => 'host-a'],
            'username'  => 'bob',
            'hostname'  => 'host-b',
        ]);

        $this->assertSame('alice', $result['username']);
        $this->assertSame('host-a', $result['hostname']);
    }

    public function testExtractSyncHostUserInputReturnsNullForEmptyUsername(): void
    {
        $result = PayloadHelper::extractSyncHostUserInput(['username' => '', 'hostname' => 'host.test']);

        $this->assertNull($result['username']);
        $this->assertSame('host.test', $result['hostname']);
    }

    public function testExtractSyncHostUserInputReturnsNullForWhitespaceOnlyValues(): void
    {
        $result = PayloadHelper::extractSyncHostUserInput([
            'username' => '   ',
            'hostname' => "\t",
        ]);

        $this->assertNull($result['username']);
        $this->assertNull($result['hostname']);
    }

    public function testExtractSyncHostUserInputTrimsWhitespace(): void
    {
        $result = PayloadHelper::extractSyncHostUserInput([
            'username' => '  alice  ',
            'hostname' => '  host.test  ',
        ]);

        $this->assertSame('alice', $result['username']);
        $this->assertSame('host.test', $result['hostname']);
    }

    public function testExtractSyncHostUserInputPreservesPartialUsername(): void
    {
        $result = PayloadHelper::extractSyncHostUserInput(['username' => 'alice']);

        $this->assertSame('alice', $result['username']);
        $this->assertNull($result['hostname']);
    }

    public function testExtractSyncHostUserInputPreservesPartialHostname(): void
    {
        $result = PayloadHelper::extractSyncHostUserInput(['hostname' => 'myserver']);

        $this->assertNull($result['username']);
        $this->assertSame('myserver', $result['hostname']);
    }

    public function testExtractSyncHostUserInputHandlesHostUserSubkeyWithNonArrayValue(): void
    {
        // host_user key present but not an array — should fall back to flat extraction
        $result = PayloadHelper::extractSyncHostUserInput([
            'host_user' => 'not-an-array',
            'username' => 'charlie',
            'hostname' => 'host.fallback',
        ]);

        $this->assertSame('charlie', $result['username']);
        $this->assertSame('host.fallback', $result['hostname']);
    }
}
