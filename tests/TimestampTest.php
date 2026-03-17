<?php

declare(strict_types=1);

use App\Support\Timestamp;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class TimestampTest extends TestCase
{
    public function testBothNullReturnsZero(): void
    {
        $this->assertSame(0, Timestamp::compare(null, null));
    }

    public function testFirstNullReturnsNegative(): void
    {
        $this->assertSame(-1, Timestamp::compare(null, '2026-01-01T00:00:00Z'));
    }

    public function testSecondNullReturnsPositive(): void
    {
        $this->assertSame(1, Timestamp::compare('2026-01-01T00:00:00Z', null));
    }

    public function testEqualTimestampsReturnZero(): void
    {
        $this->assertSame(0, Timestamp::compare('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'));
    }

    public function testFirstIsEarlier(): void
    {
        $this->assertSame(-1, Timestamp::compare('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'));
    }

    public function testFirstIsLater(): void
    {
        $this->assertSame(1, Timestamp::compare('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'));
    }

    public function testMicrosecondPrecision(): void
    {
        $this->assertSame(-1, Timestamp::compare('2026-01-01T00:00:00.000001Z', '2026-01-01T00:00:00.000002Z'));
        $this->assertSame(0, Timestamp::compare('2026-01-01T00:00:00.123Z', '2026-01-01T00:00:00.123000Z'));
    }

    public function testShortFractionalSeconds(): void
    {
        $this->assertSame(0, Timestamp::compare('2026-01-01T00:00:00.1Z', '2026-01-01T00:00:00.100000Z'));
    }

    public function testUnparseableFallsBackToLexical(): void
    {
        $result = Timestamp::compare('aaa', 'bbb');
        $this->assertSame(-1, $result);
    }

    public function testEmptyStringTreatedAsUnparseable(): void
    {
        // Empty strings should parse to null in fromString, triggering lexical fallback
        $result = Timestamp::compare('', '');
        $this->assertSame(0, $result);
    }
}
