<?php

declare(strict_types=1);

namespace App\Services;

use App\Database;
use App\Repositories\VersionRepository;
use App\Repositories\LogRepository;
use App\Support\Engine;
use PDO;

/**
 * Tracks Anthropic/Claude API usage and quota.
 *
 * Claude's quota model differs from ChatGPT's:
 * - API usage is tracked via token counts per model
 * - Rate limits are per-minute (RPM) and per-day (RPD)
 * - Spend limits are monetary (monthly spend cap)
 *
 * This service stores quota snapshots in the versions table
 * and provides summaries for the admin dashboard.
 */
class ClaudeUsageService
{
    public function __construct(
        private readonly VersionRepository $versions,
        private readonly LogRepository $logs,
        private readonly ?Database $database = null
    ) {
    }

    /**
     * Get the latest Claude usage summary for dashboard display.
     */
    public function latestUsageSummary(): ?array
    {
        $raw = $this->versions->get('claude_usage_snapshot');
        if ($raw === null || $raw === '') {
            return null;
        }

        $snapshot = json_decode($raw, true);
        if (!is_array($snapshot)) {
            return null;
        }

        return [
            'engine' => Engine::CLAUDE,
            'status' => $snapshot['status'] ?? 'unknown',
            'spend_limit' => $snapshot['spend_limit'] ?? null,
            'spend_used' => $snapshot['spend_used'] ?? null,
            'spend_remaining' => $snapshot['spend_remaining'] ?? null,
            'spend_currency' => $snapshot['spend_currency'] ?? 'USD',
            'rate_limit_rpm' => $snapshot['rate_limit_rpm'] ?? null,
            'rate_limit_rpd' => $snapshot['rate_limit_rpd'] ?? null,
            'models' => $snapshot['models'] ?? [],
            'fetched_at' => $snapshot['fetched_at'] ?? null,
        ];
    }

    /**
     * Store a Claude usage snapshot from external monitoring.
     */
    public function recordSnapshot(array $data): void
    {
        $data['fetched_at'] = gmdate(DATE_ATOM);
        $encoded = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($encoded !== false) {
            $this->versions->set('claude_usage_snapshot', $encoded);
        }
    }

    /**
     * Get Claude model pricing for cost calculation.
     *
     * @return array<string, array{input: float, output: float, cached: float}>
     */
    public static function modelPricing(): array
    {
        return [
            'claude-opus-4-6' => [
                'input' => (float) ($_ENV['CLAUDE_OPUS_INPUT_PER_1K'] ?? 0.015),
                'output' => (float) ($_ENV['CLAUDE_OPUS_OUTPUT_PER_1K'] ?? 0.075),
                'cached' => (float) ($_ENV['CLAUDE_OPUS_CACHED_PER_1K'] ?? 0.0075),
            ],
            'claude-sonnet-4-6' => [
                'input' => (float) ($_ENV['CLAUDE_SONNET_INPUT_PER_1K'] ?? 0.003),
                'output' => (float) ($_ENV['CLAUDE_SONNET_OUTPUT_PER_1K'] ?? 0.015),
                'cached' => (float) ($_ENV['CLAUDE_SONNET_CACHED_PER_1K'] ?? 0.0015),
            ],
            'claude-haiku-4-5' => [
                'input' => (float) ($_ENV['CLAUDE_HAIKU_INPUT_PER_1K'] ?? 0.0008),
                'output' => (float) ($_ENV['CLAUDE_HAIKU_OUTPUT_PER_1K'] ?? 0.004),
                'cached' => (float) ($_ENV['CLAUDE_HAIKU_CACHED_PER_1K'] ?? 0.0004),
            ],
        ];
    }

    /**
     * Calculate cost for a Claude API call.
     */
    public static function calculateCost(string $model, int $inputTokens, int $outputTokens, int $cachedTokens = 0): float
    {
        $pricing = self::modelPricing();
        $modelPricing = $pricing[$model] ?? $pricing['claude-sonnet-4-6'];

        return ($inputTokens / 1000.0 * $modelPricing['input'])
            + ($outputTokens / 1000.0 * $modelPricing['output'])
            + ($cachedTokens / 1000.0 * $modelPricing['cached']);
    }

    /**
     * Aggregate recent Claude token usage from the database.
     *
     * @param string $period One of '24h', '7d', '30d'
     * @return array<int, array{model: string, input_tokens: int, output_tokens: int, cached_tokens: int, total_tokens: int, cost: float}>
     */
    public function aggregateRecentUsage(string $period = '24h'): array
    {
        if ($this->database === null) {
            return [];
        }

        $seconds = match ($period) {
            '7d' => 7 * 86400,
            '30d' => 30 * 86400,
            default => 86400,
        };
        $since = gmdate(DATE_ATOM, time() - $seconds);

        $sql = "SELECT COALESCE(model, 'unknown') AS model,
                       COALESCE(SUM(input_tokens), 0) AS input_tokens,
                       COALESCE(SUM(output_tokens), 0) AS output_tokens,
                       COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
                       COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cached_tokens, 0)), 0) AS total_tokens
                FROM token_usages
                WHERE engine = :engine AND created_at >= :since
                GROUP BY model
                ORDER BY total_tokens DESC";

        $stmt = $this->database->connection()->prepare($sql);
        $stmt->execute(['engine' => Engine::CLAUDE, 'since' => $since]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

        $results = [];
        foreach ($rows as $row) {
            $model = (string) ($row['model'] ?? 'unknown');
            $inputTokens = (int) ($row['input_tokens'] ?? 0);
            $outputTokens = (int) ($row['output_tokens'] ?? 0);
            $cachedTokens = (int) ($row['cached_tokens'] ?? 0);
            $totalTokens = (int) ($row['total_tokens'] ?? 0);
            $cost = self::calculateCost($model, $inputTokens, $outputTokens, $cachedTokens);

            $results[] = [
                'model' => $model,
                'input_tokens' => $inputTokens,
                'output_tokens' => $outputTokens,
                'cached_tokens' => $cachedTokens,
                'total_tokens' => $totalTokens,
                'cost' => round($cost, 6),
            ];
        }

        return $results;
    }

    /**
     * Build a dashboard summary with usage across multiple time windows.
     */
    public function dashboardSummary(): array
    {
        $usage24h = $this->aggregateRecentUsage('24h');
        $usage7d = $this->aggregateRecentUsage('7d');
        $usage30d = $this->aggregateRecentUsage('30d');

        $sumCost = static function (array $rows): float {
            $total = 0.0;
            foreach ($rows as $row) {
                $total += (float) ($row['cost'] ?? 0.0);
            }
            return round($total, 6);
        };

        $totalCost24h = $sumCost($usage24h);
        $totalCost7d = $sumCost($usage7d);
        $totalCost30d = $sumCost($usage30d);

        $snapshot = $this->latestUsageSummary();
        $spendLimit = $snapshot['spend_limit'] ?? null;
        $spendUsed = $snapshot['spend_used'] ?? $totalCost30d;
        $spendPercent = ($spendLimit !== null && $spendLimit > 0)
            ? round(($spendUsed / $spendLimit) * 100, 2)
            : null;

        return [
            'current_spend' => [
                'used' => (float) $spendUsed,
                'limit' => $spendLimit !== null ? (float) $spendLimit : null,
                'percent' => $spendPercent,
            ],
            'usage_24h' => $usage24h,
            'usage_7d' => $usage7d,
            'usage_30d' => $usage30d,
            'total_cost_24h' => $totalCost24h,
            'total_cost_7d' => $totalCost7d,
            'total_cost_30d' => $totalCost30d,
        ];
    }

    /**
     * Aggregate from the database and persist a fresh snapshot.
     */
    public function refreshSnapshot(): array
    {
        $summary = $this->dashboardSummary();

        $snapshotData = [
            'status' => 'ok',
            'spend_used' => $summary['current_spend']['used'],
            'spend_limit' => $summary['current_spend']['limit'],
            'total_cost_24h' => $summary['total_cost_24h'],
            'total_cost_7d' => $summary['total_cost_7d'],
            'total_cost_30d' => $summary['total_cost_30d'],
            'models' => $summary['usage_30d'],
        ];

        $this->recordSnapshot($snapshotData);

        return $summary;
    }
}
