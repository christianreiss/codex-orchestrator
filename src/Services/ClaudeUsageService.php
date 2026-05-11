<?php

declare(strict_types=1);

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

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
 *
 * This service stores quota snapshots in the versions table
 * and provides summaries for the admin dashboard.
 */
class ClaudeUsageService
{
    private const MIN_REFRESH_SECONDS = 300;

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
     * Aggregate recent Claude token usage from the database.
     *
     * @param string $period One of '24h', '7d', '30d'
     * @return array<int, array{model: string, input_tokens: int, output_tokens: int, cached_tokens: int, total_tokens: int}>
     */
    public function aggregateRecentUsage(string $period = '24h'): array
    {
        if ($this->database === null) {
            return [];
        }

        $since = gmdate(DATE_ATOM, time() - self::periodToSeconds($period));

        $sql = "SELECT COALESCE(model, 'unknown') AS model,
                       COALESCE(SUM(input_tokens), 0) AS input_tokens,
                       COALESCE(SUM(output_tokens), 0) AS output_tokens,
                       COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
                       COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cached_tokens, 0)), 0) AS total_tokens
                FROM token_usages
                WHERE created_at >= :since AND engine = 'claude'
                GROUP BY model
                ORDER BY total_tokens DESC";

        $stmt = $this->database->connection()->prepare($sql);
        $stmt->execute(['since' => $since]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

        $results = [];
        foreach ($rows as $row) {
            $model = (string) ($row['model'] ?? 'unknown');
            $inputTokens = (int) ($row['input_tokens'] ?? 0);
            $outputTokens = (int) ($row['output_tokens'] ?? 0);
            $cachedTokens = (int) ($row['cached_tokens'] ?? 0);
            $totalTokens = (int) ($row['total_tokens'] ?? 0);

            $results[] = [
                'model' => $model,
                'input_tokens' => $inputTokens,
                'output_tokens' => $outputTokens,
                'cached_tokens' => $cachedTokens,
                'total_tokens' => $totalTokens,
            ];
        }

        return $results;
    }

    /**
     * Build a dashboard summary with usage across multiple time windows.
     * Uses a single query for all three windows instead of three separate queries.
     */
    public function dashboardSummary(): array
    {
        $buckets = $this->aggregateAllWindows();

        return [
            'usage_24h' => $buckets['24h'],
            'usage_7d' => $buckets['7d'],
            'usage_30d' => $buckets['30d'],
        ];
    }

    /**
     * Single-query aggregate for all three time windows.
     *
     * @return array<string, list<array{model: string, input_tokens: int, output_tokens: int, cached_tokens: int, total_tokens: int}>>
     */
    private function aggregateAllWindows(): array
    {
        if ($this->database === null) {
            return ['24h' => [], '7d' => [], '30d' => []];
        }

        $now = time();
        $since30d = gmdate(DATE_ATOM, $now - 30 * 86400);
        $threshold7d = gmdate(DATE_ATOM, $now - 7 * 86400);
        $threshold24h = gmdate(DATE_ATOM, $now - 86400);

        $sql = "SELECT COALESCE(model, 'unknown') AS model,
                       created_at,
                       COALESCE(input_tokens, 0) AS input_tokens,
                       COALESCE(output_tokens, 0) AS output_tokens,
                       COALESCE(cached_tokens, 0) AS cached_tokens
                FROM token_usages
                WHERE created_at >= :since AND engine = 'claude'";

        $stmt = $this->database->connection()->prepare($sql);
        $stmt->execute(['since' => $since30d]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

        $accum = [
            '24h' => [],
            '7d' => [],
            '30d' => [],
        ];

        foreach ($rows as $row) {
            $model = (string) $row['model'];
            $createdAt = (string) $row['created_at'];
            $input = (int) $row['input_tokens'];
            $output = (int) $row['output_tokens'];
            $cached = (int) $row['cached_tokens'];

            $windows = ['30d'];
            if ($createdAt >= $threshold7d) {
                $windows[] = '7d';
            }
            if ($createdAt >= $threshold24h) {
                $windows[] = '24h';
            }

            foreach ($windows as $w) {
                if (!isset($accum[$w][$model])) {
                    $accum[$w][$model] = ['input' => 0, 'output' => 0, 'cached' => 0];
                }
                $accum[$w][$model]['input'] += $input;
                $accum[$w][$model]['output'] += $output;
                $accum[$w][$model]['cached'] += $cached;
            }
        }

        $result = ['24h' => [], '7d' => [], '30d' => []];
        foreach ($accum as $window => $models) {
            foreach ($models as $model => $tokens) {
                $total = $tokens['input'] + $tokens['output'] + $tokens['cached'];
                $result[$window][] = [
                    'model' => $model,
                    'input_tokens' => $tokens['input'],
                    'output_tokens' => $tokens['output'],
                    'cached_tokens' => $tokens['cached'],
                    'total_tokens' => $total,
                ];
            }
            usort($result[$window], fn($a, $b) => $b['total_tokens'] <=> $a['total_tokens']);
        }

        return $result;
    }

    /**
     * Get Claude usage history bucketed by time period.
     *
     * @param string $bucket One of 'hourly', 'daily'
     * @param string $period How far back: '24h', '7d', '30d'
     * @param string|null $model Filter by model
     * @return array<int, array{bucket: string, model: string, input_tokens: int, output_tokens: int, cached_tokens: int, total_tokens: int}>
     */
    public function history(string $bucket = 'daily', string $period = '7d', ?string $model = null): array
    {
        if ($this->database === null) {
            return [];
        }

        $since = gmdate(DATE_ATOM, time() - self::periodToSeconds($period));

        $format = $bucket === 'hourly' ? '%Y-%m-%d %H:00' : '%Y-%m-%d';

        $modelFilter = '';
        $params = ['since' => $since];
        if ($model !== null && $model !== '') {
            $modelFilter = ' AND model = :model';
            $params['model'] = $model;
        }

        $sql = "SELECT DATE_FORMAT(created_at, :fmt) AS time_bucket,
                       COALESCE(model, 'unknown') AS model,
                       COALESCE(SUM(input_tokens), 0) AS input_tokens,
                       COALESCE(SUM(output_tokens), 0) AS output_tokens,
                       COALESCE(SUM(cached_tokens), 0) AS cached_tokens
                FROM token_usages
                WHERE created_at >= :since AND engine = 'claude'{$modelFilter}
                GROUP BY time_bucket, model
                ORDER BY time_bucket ASC, model ASC";

        $params['fmt'] = $format;

        $stmt = $this->database->connection()->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

        $results = [];
        foreach ($rows as $row) {
            $rowModel = (string) ($row['model'] ?? 'unknown');
            $inputTokens = (int) ($row['input_tokens'] ?? 0);
            $outputTokens = (int) ($row['output_tokens'] ?? 0);
            $cachedTokens = (int) ($row['cached_tokens'] ?? 0);

            $results[] = [
                'bucket' => (string) ($row['time_bucket'] ?? ''),
                'model' => $rowModel,
                'input_tokens' => $inputTokens,
                'output_tokens' => $outputTokens,
                'cached_tokens' => $cachedTokens,
                'total_tokens' => $inputTokens + $outputTokens + $cachedTokens,
            ];
        }

        return $results;
    }

    /**
     * Advanced history with per-model token series for charting.
     *
     * @return array{series: array<string, list<array{bucket: string, tokens: int}>>, totals: array<string, int>}
     */
    public function historyAdvanced(string $bucket = 'daily', string $period = '30d'): array
    {
        $raw = $this->history($bucket, $period);

        $series = [];
        $totals = [];

        foreach ($raw as $row) {
            $model = $row['model'];
            if (!isset($series[$model])) {
                $series[$model] = [];
                $totals[$model] = 0;
            }

            $tokens = $row['input_tokens'] + $row['output_tokens'] + $row['cached_tokens'];
            $series[$model][] = [
                'bucket' => $row['bucket'],
                'tokens' => $tokens,
            ];
            $totals[$model] += $tokens;
        }

        return [
            'series' => $series,
            'totals' => $totals,
        ];
    }

    /**
     * Log an error for debugging.
     */
    public function storeError(string $message, array $context = []): void
    {
        $this->logs->log(null, 'claude.usage.error', array_merge(['message' => $message], $context));
    }

    /**
     * Check whether the cached snapshot is stale and should be refreshed.
     */
    public function shouldRefresh(): bool
    {
        $lastRefresh = $this->versions->get('claude_usage_last_refresh');
        if ($lastRefresh === null) {
            return true;
        }

        return (time() - (int) $lastRefresh) >= self::MIN_REFRESH_SECONDS;
    }

    /**
     * Aggregate from the database and persist a fresh snapshot.
     */
    public function refreshSnapshot(): array
    {
        $summary = $this->dashboardSummary();

        $snapshotData = [
            'status' => 'ok',
            'models' => $summary['usage_30d'],
        ];

        $this->recordSnapshot($snapshotData);
        $this->versions->set('claude_usage_last_refresh', (string) time());

        return $summary;
    }

    private static function periodToSeconds(string $period): int
    {
        return match ($period) {
            '24h' => 86400,
            '7d' => 7 * 86400,
            '30d' => 30 * 86400,
            default => 7 * 86400,
        };
    }
}
