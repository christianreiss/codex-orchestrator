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
}
