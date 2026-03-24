<?php

declare(strict_types=1);

use App\Exceptions\HttpException;
use App\Repositories\HostRepository;
use App\Repositories\InsecureAuthRequestRepository;
use App\Repositories\InsecureDomainAllowRepository;
use App\Repositories\LogRepository;
use App\Repositories\VersionRepository;
use App\Services\InsecureHostWindowService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

/**
 * Unit tests for InsecureHostWindowService.
 *
 * The public surface under test:
 *   - isTimestampActive()       pure helper, no I/O
 *   - parseSessionStartedAt()   pure helper, no I/O
 *   - resolveInsecureGraceUntil() reads Config (via $_ENV), no DB
 *   - enforceInsecureWindow()   delegates to assertInsecureHostWindow; needs mocked repos
 */
final class InsecureHostWindowServiceTest extends TestCase
{
    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private function makeService(
        ?HostRepository $hosts = null,
        ?InsecureAuthRequestRepository $authRequests = null,
        ?InsecureDomainAllowRepository $domainAllows = null,
        ?LogRepository $logs = null,
        ?VersionRepository $versions = null
    ): InsecureHostWindowService {
        return new InsecureHostWindowService(
            $hosts    ?? $this->createMock(HostRepository::class),
            $authRequests,
            $domainAllows,
            $logs     ?? $this->createMock(LogRepository::class),
            $versions ?? $this->createMock(VersionRepository::class)
        );
    }

    // -------------------------------------------------------------------------
    // isTimestampActive
    // -------------------------------------------------------------------------

    public function testIsTimestampActiveReturnsTrueForFutureTimestamp(): void
    {
        $svc = $this->makeService();
        $now = new DateTimeImmutable('2026-01-01 12:00:00');
        $future = '2026-01-01T13:00:00+00:00';

        self::assertTrue($svc->isTimestampActive($future, $now));
    }

    public function testIsTimestampActiveReturnsTrueForExactlyNow(): void
    {
        $svc = $this->makeService();
        $now = new DateTimeImmutable('2026-01-01T12:00:00+00:00');

        self::assertTrue($svc->isTimestampActive('2026-01-01T12:00:00+00:00', $now));
    }

    public function testIsTimestampActiveReturnsFalseForPastTimestamp(): void
    {
        $svc = $this->makeService();
        $now = new DateTimeImmutable('2026-01-01 12:00:00');
        $past = '2026-01-01T11:59:59+00:00';

        self::assertFalse($svc->isTimestampActive($past, $now));
    }

    public function testIsTimestampActiveReturnsFalseForNull(): void
    {
        $svc = $this->makeService();
        $now = new DateTimeImmutable('2026-01-01 12:00:00');

        self::assertFalse($svc->isTimestampActive(null, $now));
    }

    public function testIsTimestampActiveReturnsFalseForEmptyString(): void
    {
        $svc = $this->makeService();
        $now = new DateTimeImmutable('2026-01-01 12:00:00');

        self::assertFalse($svc->isTimestampActive('', $now));
    }

    public function testIsTimestampActiveReturnsFalseForWhitespaceOnlyString(): void
    {
        $svc = $this->makeService();
        $now = new DateTimeImmutable('2026-01-01 12:00:00');

        self::assertFalse($svc->isTimestampActive('   ', $now));
    }

    public function testIsTimestampActiveReturnsFalseForInvalidDateString(): void
    {
        $svc = $this->makeService();
        $now = new DateTimeImmutable('2026-01-01 12:00:00');

        self::assertFalse($svc->isTimestampActive('not-a-date', $now));
    }

    public function testIsTimestampActiveReturnsFalseForIntegerInput(): void
    {
        $svc = $this->makeService();
        $now = new DateTimeImmutable('2026-01-01 12:00:00');

        self::assertFalse($svc->isTimestampActive(9999999999, $now));
    }

    public function testIsTimestampActiveReturnsFalseForArrayInput(): void
    {
        $svc = $this->makeService();
        $now = new DateTimeImmutable('2026-01-01 12:00:00');

        self::assertFalse($svc->isTimestampActive([], $now));
    }

    // -------------------------------------------------------------------------
    // parseSessionStartedAt
    // -------------------------------------------------------------------------

    public function testParseSessionStartedAtReturnsDateTimeForValidIsoString(): void
    {
        $svc = $this->makeService();
        $result = $svc->parseSessionStartedAt('2026-03-01T10:00:00+00:00');

        self::assertInstanceOf(DateTimeImmutable::class, $result);
        self::assertSame(strtotime('2026-03-01T10:00:00+00:00'), $result->getTimestamp());
    }

    public function testParseSessionStartedAtReturnsNullForNull(): void
    {
        $svc = $this->makeService();

        self::assertNull($svc->parseSessionStartedAt(null));
    }

    public function testParseSessionStartedAtReturnsNullForEmptyString(): void
    {
        $svc = $this->makeService();

        self::assertNull($svc->parseSessionStartedAt(''));
    }

    public function testParseSessionStartedAtReturnsNullForWhitespace(): void
    {
        $svc = $this->makeService();

        self::assertNull($svc->parseSessionStartedAt('   '));
    }

    public function testParseSessionStartedAtReturnsNullForNonString(): void
    {
        $svc = $this->makeService();

        self::assertNull($svc->parseSessionStartedAt(1234567890));
    }

    public function testParseSessionStartedAtReturnsNullForInvalidDate(): void
    {
        $svc = $this->makeService();

        self::assertNull($svc->parseSessionStartedAt('not-a-date'));
    }

    public function testParseSessionStartedAtAcceptsRfc3339Format(): void
    {
        $svc = $this->makeService();
        $ts = '2025-12-31T23:59:59Z';
        $result = $svc->parseSessionStartedAt($ts);

        self::assertInstanceOf(DateTimeImmutable::class, $result);
    }

    // -------------------------------------------------------------------------
    // resolveInsecureGraceUntil
    // -------------------------------------------------------------------------

    public function testResolveInsecureGraceUntilReturnsNullForNullEnabledUntil(): void
    {
        $svc = $this->makeService();

        self::assertNull($svc->resolveInsecureGraceUntil(null));
    }

    public function testResolveInsecureGraceUntilReturnsNullForEmptyString(): void
    {
        $svc = $this->makeService();

        self::assertNull($svc->resolveInsecureGraceUntil(''));
    }

    public function testResolveInsecureGraceUntilReturnsNullForInvalidDate(): void
    {
        $svc = $this->makeService();

        self::assertNull($svc->resolveInsecureGraceUntil('not-a-date'));
    }

    public function testResolveInsecureGraceUntilReturnsNullWhenWindowMinutesIsZero(): void
    {
        $svc = $this->makeService();

        // windowMinutes=0 → computeInsecureGraceUntil returns null immediately
        $result = $svc->resolveInsecureGraceUntil('2026-01-01T12:00:00+00:00', 0);

        self::assertNull($result);
    }

    public function testResolveInsecureGraceUntilReturnsNullWhenWindowMinutesIsNegative(): void
    {
        $svc = $this->makeService();

        $result = $svc->resolveInsecureGraceUntil('2026-01-01T12:00:00+00:00', -5);

        self::assertNull($result);
    }

    public function testResolveInsecureGraceUntilAddsDefaultGraceMinutes(): void
    {
        // Default grace is 60 minutes; ensure no override in env
        unset($_ENV['INSECURE_GRACE_MINUTES']);

        $svc = $this->makeService();
        $base = '2026-06-01T10:00:00+00:00';
        $result = $svc->resolveInsecureGraceUntil($base);

        self::assertIsString($result);
        $expected = (new DateTimeImmutable($base))->modify('+60 minutes')->getTimestamp();
        $actual   = (new DateTimeImmutable($result))->getTimestamp();
        self::assertSame($expected, $actual);
    }

    public function testResolveInsecureGraceUntilHonorsEnvOverride(): void
    {
        $_ENV['INSECURE_GRACE_MINUTES'] = '30';

        $svc = $this->makeService();
        $base = '2026-06-01T10:00:00+00:00';
        $result = $svc->resolveInsecureGraceUntil($base);

        unset($_ENV['INSECURE_GRACE_MINUTES']);

        self::assertIsString($result);
        $expected = (new DateTimeImmutable($base))->modify('+30 minutes')->getTimestamp();
        $actual   = (new DateTimeImmutable($result))->getTimestamp();
        self::assertSame($expected, $actual);
    }

    public function testResolveInsecureGraceUntilClampsGraceMinutesToMax(): void
    {
        // Max is 480; set higher and expect 480 minutes of grace
        $_ENV['INSECURE_GRACE_MINUTES'] = '999';

        $svc = $this->makeService();
        $base = '2026-06-01T10:00:00+00:00';
        $result = $svc->resolveInsecureGraceUntil($base);

        unset($_ENV['INSECURE_GRACE_MINUTES']);

        self::assertIsString($result);
        $expected = (new DateTimeImmutable($base))->modify('+480 minutes')->getTimestamp();
        $actual   = (new DateTimeImmutable($result))->getTimestamp();
        self::assertSame($expected, $actual);
    }

    public function testResolveInsecureGraceUntilReturnsNullWhenGraceMinutesIsZero(): void
    {
        $_ENV['INSECURE_GRACE_MINUTES'] = '0';

        $svc = $this->makeService();
        $result = $svc->resolveInsecureGraceUntil('2026-06-01T10:00:00+00:00');

        unset($_ENV['INSECURE_GRACE_MINUTES']);

        self::assertNull($result);
    }

    // -------------------------------------------------------------------------
    // enforceInsecureWindow — secure host
    // -------------------------------------------------------------------------

    public function testEnforceInsecureWindowPassesThroughForSecureHost(): void
    {
        $svc = $this->makeService();
        $host = ['id' => 1, 'fqdn' => 'secure.host', 'secure' => 1];

        $result = $svc->enforceInsecureWindow($host);

        self::assertSame($host, $result);
    }

    public function testEnforceInsecureWindowPassesThroughWhenSecureNotSet(): void
    {
        $svc = $this->makeService();
        $host = ['id' => 1, 'fqdn' => 'unknown.host'];

        $result = $svc->enforceInsecureWindow($host);

        self::assertSame($host, $result);
    }

    // -------------------------------------------------------------------------
    // enforceInsecureWindow — insecure host, active window
    // -------------------------------------------------------------------------

    public function testEnforceInsecureWindowAllowsInsecureHostWithActiveWindow(): void
    {
        $hosts = $this->createMock(HostRepository::class);
        $hosts->expects(self::once())->method('updateInsecureWindows');

        $logs = $this->createMock(LogRepository::class);
        $versions = $this->createMock(VersionRepository::class);

        $svc = $this->makeService($hosts, null, null, $logs, $versions);

        $host = [
            'id' => 7,
            'fqdn' => 'insecure.host',
            'secure' => 0,
            'insecure_enabled_until' => gmdate(DATE_ATOM, time() + 600),
            'insecure_grace_until'   => null,
        ];

        $result = $svc->enforceInsecureWindow($host);

        // Window extended — at minimum the enabled_until key should exist in result
        self::assertArrayHasKey('insecure_enabled_until', $result);
    }

    public function testEnforceInsecureWindowDoesNotCallUpdateForIdZeroHost(): void
    {
        $hosts = $this->createMock(HostRepository::class);
        $hosts->expects(self::never())->method('updateInsecureWindows');

        $svc = $this->makeService($hosts);

        $host = [
            'id' => 0,
            'fqdn' => 'insecure.host',
            'secure' => 0,
            'insecure_enabled_until' => gmdate(DATE_ATOM, time() + 600),
            'insecure_grace_until'   => null,
        ];

        // Should not throw; window is active
        $result = $svc->enforceInsecureWindow($host);
        self::assertSame(0, (int) ($result['id'] ?? 0));
    }

    // -------------------------------------------------------------------------
    // enforceInsecureWindow — insecure host, grace window
    // -------------------------------------------------------------------------

    public function testEnforceInsecureWindowAllowsStoreCommandDuringGrace(): void
    {
        $versions = $this->createMock(VersionRepository::class);
        $versions->method('getFlag')->willReturn(false);

        $svc = $this->makeService(null, null, null, null, $versions);

        $host = [
            'id' => 3,
            'fqdn' => 'insecure.grace',
            'secure' => 0,
            'insecure_enabled_until' => gmdate(DATE_ATOM, time() - 60),   // expired
            'insecure_grace_until'   => gmdate(DATE_ATOM, time() + 3600), // still open
        ];

        // store during grace → should pass without exception
        $result = $svc->enforceInsecureWindow($host, 'store');
        self::assertSame($host['insecure_enabled_until'], $result['insecure_enabled_until'] ?? null);
    }

    public function testEnforceInsecureWindowDeniesRetrieveDuringGrace(): void
    {
        $versions = $this->createMock(VersionRepository::class);
        $versions->method('getFlag')->willReturn(false);
        $versions->method('getWithMetadata')->willReturn(null);

        $logs = $this->createMock(LogRepository::class);

        $svc = $this->makeService(null, null, null, $logs, $versions);

        $host = [
            'id' => 3,
            'fqdn' => 'insecure.grace',
            'secure' => 0,
            'insecure_enabled_until' => gmdate(DATE_ATOM, time() - 60),   // expired
            'insecure_grace_until'   => gmdate(DATE_ATOM, time() + 3600), // still open
        ];

        $this->expectException(HttpException::class);
        $svc->enforceInsecureWindow($host, 'retrieve');
    }

    // -------------------------------------------------------------------------
    // enforceInsecureWindow — insecure host, fully expired window
    // -------------------------------------------------------------------------

    public function testEnforceInsecureWindowThrowsWhenWindowFullyExpiredAndApprovalDisabled(): void
    {
        $versions = $this->createMock(VersionRepository::class);
        $versions->method('getFlag')->willReturn(false);
        $versions->method('getWithMetadata')->willReturn(null);

        $logs = $this->createMock(LogRepository::class);

        $svc = $this->makeService(null, null, null, $logs, $versions);

        $host = [
            'id' => 4,
            'fqdn' => 'insecure.closed',
            'secure' => 0,
            'insecure_enabled_until' => gmdate(DATE_ATOM, time() - 3600),
            'insecure_grace_until'   => gmdate(DATE_ATOM, time() - 60),
        ];

        $this->expectException(HttpException::class);
        $this->expectExceptionMessage('Insecure host API access disabled');

        $svc->enforceInsecureWindow($host, 'retrieve');
    }

    public function testEnforceInsecureWindowThrowsWhenWindowNeverOpened(): void
    {
        $versions = $this->createMock(VersionRepository::class);
        $versions->method('getFlag')->willReturn(false);
        $versions->method('getWithMetadata')->willReturn(null);

        $logs = $this->createMock(LogRepository::class);

        $svc = $this->makeService(null, null, null, $logs, $versions);

        $host = [
            'id' => 5,
            'fqdn' => 'insecure.never',
            'secure' => 0,
            'insecure_enabled_until' => null,
            'insecure_grace_until'   => null,
        ];

        $this->expectException(HttpException::class);
        $svc->enforceInsecureWindow($host, 'retrieve');
    }

    public function testEnforceInsecureWindowExceptionCarriesCodePayload(): void
    {
        $versions = $this->createMock(VersionRepository::class);
        $versions->method('getFlag')->willReturn(false);
        $versions->method('getWithMetadata')->willReturn(null);

        $logs = $this->createMock(LogRepository::class);

        $svc = $this->makeService(null, null, null, $logs, $versions);

        $host = [
            'id' => 6,
            'fqdn' => 'insecure.closed2',
            'secure' => 0,
            'insecure_enabled_until' => gmdate(DATE_ATOM, time() - 60),
            'insecure_grace_until'   => null,
        ];

        try {
            $svc->enforceInsecureWindow($host, 'retrieve');
            self::fail('Expected HttpException was not thrown');
        } catch (HttpException $e) {
            self::assertSame(403, $e->getStatusCode());
            $ctx = $e->context();
            self::assertArrayHasKey('code', $ctx);
            self::assertSame('insecure_api_disabled', $ctx['code']);
        }
    }
}
