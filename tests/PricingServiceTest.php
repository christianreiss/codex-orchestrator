<?php

declare(strict_types=1);

use App\Repositories\LogRepository;
use App\Repositories\PricingSnapshotRepository;
use App\Services\PricingService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class InMemoryPricingSnapshotRepository extends PricingSnapshotRepository
{
    private ?array $latest = null;

    public function __construct()
    {
    }

    public function record(array $data): array
    {
        $this->latest = $data + ['id' => 1];
        return $this->latest;
    }

    public function latestForModel(string $model): ?array
    {
        if (($this->latest['model'] ?? null) !== $model) {
            return null;
        }

        return $this->latest;
    }
}

final class NullPricingLogRepository extends LogRepository
{
    public function __construct()
    {
    }

    public function log(?int $hostId, string $action, array $details = []): void
    {
    }
}

final class PricingServiceTest extends TestCase
{
    private array $envBackup = [];
    private array $serverBackup = [];

    protected function setUp(): void
    {
        $keys = [
            'GPT54_INPUT_PER_1K',
            'GPT54_OUTPUT_PER_1K',
            'GPT54_CACHED_PER_1K',
            'GPT51_INPUT_PER_1K',
            'GPT51_OUTPUT_PER_1K',
            'GPT51_CACHED_PER_1K',
            'PRICING_CURRENCY',
        ];

        foreach ($keys as $key) {
            $this->envBackup[$key] = $_ENV[$key] ?? null;
            $this->serverBackup[$key] = $_SERVER[$key] ?? null;
            unset($_ENV[$key], $_SERVER[$key]);
            putenv($key);
        }
    }

    protected function tearDown(): void
    {
        foreach (array_keys($this->envBackup) as $key) {
            $envValue = $this->envBackup[$key];
            $serverValue = $this->serverBackup[$key];

            if ($envValue === null) {
                unset($_ENV[$key]);
            } else {
                $_ENV[$key] = $envValue;
            }

            if ($serverValue === null) {
                unset($_SERVER[$key]);
            } else {
                $_SERVER[$key] = $serverValue;
            }

            $restore = $envValue ?? $serverValue;
            if ($restore === null) {
                putenv($key);
            } else {
                putenv($key . '=' . $restore);
            }
        }
    }

    public function testFallbackPricingPrefersGpt54EnvironmentValues(): void
    {
        $_ENV['GPT54_INPUT_PER_1K'] = '0.123';
        $_ENV['GPT54_OUTPUT_PER_1K'] = '0.456';
        $_ENV['GPT54_CACHED_PER_1K'] = '0.078';
        $_ENV['PRICING_CURRENCY'] = 'EUR';
        $_ENV['GPT51_INPUT_PER_1K'] = '9.999';
        $_ENV['GPT51_OUTPUT_PER_1K'] = '9.999';
        $_ENV['GPT51_CACHED_PER_1K'] = '9.999';

        $service = new PricingService(new InMemoryPricingSnapshotRepository(), new NullPricingLogRepository());
        $pricing = $service->latestPricing('gpt-5.4', false);

        $this->assertSame('gpt-5.4', $service->defaultModel());
        $this->assertSame('EUR', $pricing['currency']);
        $this->assertSame(0.123, (float) $pricing['input_price_per_1k']);
        $this->assertSame(0.456, (float) $pricing['output_price_per_1k']);
        $this->assertSame(0.078, (float) $pricing['cached_price_per_1k']);
    }

    public function testFallbackPricingKeepsLegacyGpt51EnvironmentCompatibility(): void
    {
        $_ENV['GPT51_INPUT_PER_1K'] = '0.111';
        $_ENV['GPT51_OUTPUT_PER_1K'] = '0.222';
        $_ENV['GPT51_CACHED_PER_1K'] = '0.333';
        $_ENV['PRICING_CURRENCY'] = 'USD';

        $service = new PricingService(new InMemoryPricingSnapshotRepository(), new NullPricingLogRepository());
        $pricing = $service->latestPricing('gpt-5.4', false);

        $this->assertSame(0.111, (float) $pricing['input_price_per_1k']);
        $this->assertSame(0.222, (float) $pricing['output_price_per_1k']);
        $this->assertSame(0.333, (float) $pricing['cached_price_per_1k']);
    }
}
