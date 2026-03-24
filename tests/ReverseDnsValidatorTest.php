<?php

declare(strict_types=1);

use App\Repositories\VersionRepository;
use App\Services\ReverseDnsValidator;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

/**
 * Unit tests for ReverseDnsValidator.
 *
 * The public surface under test:
 *   - normalizeHostname()       pure helper, no I/O
 *   - reverseDnsName()          pure helper, uses inet_pton/inet_ntop
 *   - isReverseDnsRequired()    reads host array + VersionRepository (mocked)
 *
 * Methods that call dns_get_record() / gethostbyaddr() (resolveForwardIps,
 * resolvePtrHosts, assertReverseDnsMatch) are network-bound and are not
 * covered here; they are exercised indirectly in AuthServiceReverseDnsTest.
 */
final class ReverseDnsValidatorTest extends TestCase
{
    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private function makeValidator(?VersionRepository $versions = null): ReverseDnsValidator
    {
        return new ReverseDnsValidator(
            $versions ?? $this->createMock(VersionRepository::class)
        );
    }

    // -------------------------------------------------------------------------
    // normalizeHostname
    // -------------------------------------------------------------------------

    public function testNormalizeHostnameLowercasesInput(): void
    {
        $v = $this->makeValidator();
        self::assertSame('example.com', $v->normalizeHostname('EXAMPLE.COM'));
    }

    public function testNormalizeHostnameTrimsWhitespace(): void
    {
        $v = $this->makeValidator();
        self::assertSame('example.com', $v->normalizeHostname('  example.com  '));
    }

    public function testNormalizeHostnameStripsTrailingDot(): void
    {
        $v = $this->makeValidator();
        self::assertSame('example.com', $v->normalizeHostname('example.com.'));
    }

    public function testNormalizeHostnameStripsMultipleTrailingDots(): void
    {
        $v = $this->makeValidator();
        // rtrim strips all trailing dots
        self::assertSame('example.com', $v->normalizeHostname('example.com...'));
    }

    public function testNormalizeHostnameCombinesTransformations(): void
    {
        $v = $this->makeValidator();
        self::assertSame('host.example.com', $v->normalizeHostname('  HOST.Example.COM.  '));
    }

    public function testNormalizeHostnameReturnsNullForNull(): void
    {
        $v = $this->makeValidator();
        self::assertNull($v->normalizeHostname(null));
    }

    public function testNormalizeHostnameReturnsNullForEmptyString(): void
    {
        $v = $this->makeValidator();
        self::assertNull($v->normalizeHostname(''));
    }

    public function testNormalizeHostnameReturnsNullForWhitespaceOnly(): void
    {
        $v = $this->makeValidator();
        self::assertNull($v->normalizeHostname('   '));
    }

    public function testNormalizeHostnameReturnsNullForDotsOnly(): void
    {
        $v = $this->makeValidator();
        // after trim + rtrim('.') → empty → null
        self::assertNull($v->normalizeHostname('...'));
    }

    public function testNormalizeHostnamePreservesSubdomains(): void
    {
        $v = $this->makeValidator();
        self::assertSame('a.b.c.example.com', $v->normalizeHostname('A.B.C.EXAMPLE.COM'));
    }

    // -------------------------------------------------------------------------
    // reverseDnsName – IPv4
    // -------------------------------------------------------------------------

    public function testReverseDnsNameForLoopback(): void
    {
        $v = $this->makeValidator();
        self::assertSame('1.0.0.127.in-addr.arpa', $v->reverseDnsName('127.0.0.1'));
    }

    public function testReverseDnsNameForTypicalIpv4(): void
    {
        $v = $this->makeValidator();
        self::assertSame('1.2.168.192.in-addr.arpa', $v->reverseDnsName('192.168.2.1'));
    }

    public function testReverseDnsNameForAllZerosIpv4(): void
    {
        $v = $this->makeValidator();
        self::assertSame('0.0.0.0.in-addr.arpa', $v->reverseDnsName('0.0.0.0'));
    }

    public function testReverseDnsNameForBroadcastIpv4(): void
    {
        $v = $this->makeValidator();
        self::assertSame('255.255.255.255.in-addr.arpa', $v->reverseDnsName('255.255.255.255'));
    }

    // -------------------------------------------------------------------------
    // reverseDnsName – IPv6
    // -------------------------------------------------------------------------

    public function testReverseDnsNameForFullIpv6(): void
    {
        $v = $this->makeValidator();
        // 2001:0db8:0000:0000:0000:0000:0000:0001
        $result = $v->reverseDnsName('2001:db8::1');
        self::assertStringEndsWith('.ip6.arpa', $result ?? '');
        // Verify it contains nibble-reversed hex of the address
        self::assertNotNull($result);
        // 32 nibbles + 31 dots between them + ".ip6.arpa" (9 chars) = 72 chars total
        self::assertSame(72, strlen($result));
    }

    public function testReverseDnsNameForIpv6Loopback(): void
    {
        $v = $this->makeValidator();
        $result = $v->reverseDnsName('::1');
        self::assertNotNull($result);
        self::assertStringEndsWith('.ip6.arpa', $result);
        // ::1 reversed nibble-by-nibble is 1.0.0.0...0.ip6.arpa
        self::assertStringStartsWith('1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0', $result);
    }

    public function testReverseDnsNameForIpv4MappedIpv6(): void
    {
        // ::ffff:192.168.2.1 should be unwrapped to the IPv4 address
        $v = $this->makeValidator();
        $result = $v->reverseDnsName('::ffff:192.168.2.1');
        self::assertSame('1.2.168.192.in-addr.arpa', $result);
    }

    // -------------------------------------------------------------------------
    // reverseDnsName – invalid inputs
    // -------------------------------------------------------------------------

    public function testReverseDnsNameReturnsNullForEmptyString(): void
    {
        $v = $this->makeValidator();
        self::assertNull($v->reverseDnsName(''));
    }

    public function testReverseDnsNameReturnsNullForNonIpString(): void
    {
        $v = $this->makeValidator();
        self::assertNull($v->reverseDnsName('not-an-ip'));
    }

    public function testReverseDnsNameReturnsNullForHostname(): void
    {
        $v = $this->makeValidator();
        self::assertNull($v->reverseDnsName('example.com'));
    }

    public function testReverseDnsNameReturnsNullForPartialIp(): void
    {
        $v = $this->makeValidator();
        self::assertNull($v->reverseDnsName('192.168'));
    }

    // -------------------------------------------------------------------------
    // isReverseDnsRequired – host-level override
    // -------------------------------------------------------------------------

    public function testIsReverseDnsRequiredReturnsTrueWhenHostFlagIsTrue(): void
    {
        $v = $this->makeValidator();
        self::assertTrue($v->isReverseDnsRequired(['reverse_dns_mode' => true]));
    }

    public function testIsReverseDnsRequiredReturnsFalseWhenHostFlagIsFalse(): void
    {
        $v = $this->makeValidator();
        self::assertFalse($v->isReverseDnsRequired(['reverse_dns_mode' => false]));
    }

    public function testIsReverseDnsRequiredReturnsTrueForStringOne(): void
    {
        $v = $this->makeValidator();
        self::assertTrue($v->isReverseDnsRequired(['reverse_dns_mode' => '1']));
    }

    public function testIsReverseDnsRequiredReturnsFalseForStringZero(): void
    {
        $v = $this->makeValidator();
        self::assertFalse($v->isReverseDnsRequired(['reverse_dns_mode' => '0']));
    }

    public function testIsReverseDnsRequiredReturnsTrueForStringEnabled(): void
    {
        $v = $this->makeValidator();
        self::assertTrue($v->isReverseDnsRequired(['reverse_dns_mode' => 'enabled']));
    }

    public function testIsReverseDnsRequiredReturnsFalseForStringDisabled(): void
    {
        $v = $this->makeValidator();
        self::assertFalse($v->isReverseDnsRequired(['reverse_dns_mode' => 'disabled']));
    }

    public function testIsReverseDnsRequiredReturnsTrueForStringYes(): void
    {
        $v = $this->makeValidator();
        self::assertTrue($v->isReverseDnsRequired(['reverse_dns_mode' => 'yes']));
    }

    public function testIsReverseDnsRequiredReturnsFalseForStringNo(): void
    {
        $v = $this->makeValidator();
        self::assertFalse($v->isReverseDnsRequired(['reverse_dns_mode' => 'no']));
    }

    public function testIsReverseDnsRequiredReturnsTrueForIntOne(): void
    {
        $v = $this->makeValidator();
        self::assertTrue($v->isReverseDnsRequired(['reverse_dns_mode' => 1]));
    }

    public function testIsReverseDnsRequiredReturnsFalseForIntZero(): void
    {
        $v = $this->makeValidator();
        self::assertFalse($v->isReverseDnsRequired(['reverse_dns_mode' => 0]));
    }

    // -------------------------------------------------------------------------
    // isReverseDnsRequired – falls back to global flag
    // -------------------------------------------------------------------------

    public function testIsReverseDnsRequiredFallsBackToGlobalFlagWhenModeIsNull(): void
    {
        $versions = $this->createMock(VersionRepository::class);
        $versions->method('getFlag')
            ->with('reverse_dns_enabled', false)
            ->willReturn(true);

        $v = new ReverseDnsValidator($versions);
        self::assertTrue($v->isReverseDnsRequired(['reverse_dns_mode' => null]));
    }

    public function testIsReverseDnsRequiredFallsBackToGlobalFlagWhenModeIsMissing(): void
    {
        $versions = $this->createMock(VersionRepository::class);
        $versions->method('getFlag')
            ->with('reverse_dns_enabled', false)
            ->willReturn(false);

        $v = new ReverseDnsValidator($versions);
        self::assertFalse($v->isReverseDnsRequired([]));
    }

    public function testIsReverseDnsRequiredFallsBackToGlobalFlagForStringGlobal(): void
    {
        $versions = $this->createMock(VersionRepository::class);
        $versions->method('getFlag')
            ->with('reverse_dns_enabled', false)
            ->willReturn(true);

        $v = new ReverseDnsValidator($versions);
        self::assertTrue($v->isReverseDnsRequired(['reverse_dns_mode' => 'global']));
    }

    public function testIsReverseDnsRequiredFallsBackToGlobalFlagForStringDefault(): void
    {
        $versions = $this->createMock(VersionRepository::class);
        $versions->method('getFlag')
            ->with('reverse_dns_enabled', false)
            ->willReturn(false);

        $v = new ReverseDnsValidator($versions);
        self::assertFalse($v->isReverseDnsRequired(['reverse_dns_mode' => 'default']));
    }

    public function testIsReverseDnsRequiredFallsBackToGlobalFlagForUnrecognizedString(): void
    {
        $versions = $this->createMock(VersionRepository::class);
        $versions->method('getFlag')
            ->with('reverse_dns_enabled', false)
            ->willReturn(true);

        $v = new ReverseDnsValidator($versions);
        // 'maybe' is not a recognized value → falls back to global
        self::assertTrue($v->isReverseDnsRequired(['reverse_dns_mode' => 'maybe']));
    }

    public function testIsReverseDnsRequiredDefaultsToFalseWhenGlobalFlagIsOff(): void
    {
        $versions = $this->createMock(VersionRepository::class);
        $versions->method('getFlag')
            ->with('reverse_dns_enabled', false)
            ->willReturn(false);

        $v = new ReverseDnsValidator($versions);
        self::assertFalse($v->isReverseDnsRequired([]));
    }
}
