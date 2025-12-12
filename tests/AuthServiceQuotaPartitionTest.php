<?php

declare(strict_types=1);

use App\Services\AuthService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AuthServiceQuotaPartitionTest extends TestCase
{
    public function testNormalizeWeekPartitionAcceptsAllowedValues(): void
    {
        $this->assertSame(AuthService::QUOTA_WEEK_PARTITION_SEVEN_DAY, AuthService::normalizeQuotaWeekPartition(7));
        $this->assertSame(AuthService::QUOTA_WEEK_PARTITION_FIVE_DAY, AuthService::normalizeQuotaWeekPartition('5'));
        $this->assertSame(AuthService::QUOTA_WEEK_PARTITION_OFF, AuthService::normalizeQuotaWeekPartition('off'));
    }

    public function testNormalizeWeekPartitionRejectsInvalid(): void
    {
        $this->assertNull(AuthService::normalizeQuotaWeekPartition('nope'));
        $this->assertNull(AuthService::normalizeQuotaWeekPartition(3));
        $this->assertNull(AuthService::normalizeQuotaWeekPartition(null));
    }

    public function testDailyAllowanceRoundsLikeBash(): void
    {
        $this->assertSame(14, AuthService::dailyAllowanceForPartition(100, 7)); // (100+3)/7 = 14
        $this->assertSame(14, AuthService::dailyAllowanceForPartition(95, 7));  // (95+3)/7 = 14
        $this->assertSame(13, AuthService::dailyAllowanceForPartition(90, 7));  // (90+3)/7 = 13
        $this->assertSame(20, AuthService::dailyAllowanceForPartition(100, 5)); // (100+2)/5 = 20
        $this->assertSame(19, AuthService::dailyAllowanceForPartition(95, 5));  // (95+2)/5 = 19
        $this->assertSame(18, AuthService::dailyAllowanceForPartition(90, 5));  // (90+2)/5 = 18
    }
}
