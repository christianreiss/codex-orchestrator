<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Repositories\TokenUsageRepository;
use DateInterval;
use DateTimeImmutable;
use DateTimeZone;

class CostHistoryService
{
    private const MAX_DAYS = 180;
    private const DEFAULT_DAYS = 60;

    public function __construct(
        private readonly TokenUsageRepository $tokenUsageRepository,
        private readonly PricingService $pricingService,
        private readonly string $model = 'gpt-5.4'
    ) {
    }

    public function history(int $days = 60): array
    {
        return $this->historyAdvanced($days, null, null, 'day', 'component', true);
    }

    public function historyAdvanced(
        int $days = self::DEFAULT_DAYS,
        ?string $from = null,
        ?string $until = null,
        string $interval = 'day',
        string $groupBy = 'component',
        bool $includeTokens = true
    ): array {
        $normalizedDays = $days < 1 ? self::DEFAULT_DAYS : $days;
        $normalizedDays = min(self::MAX_DAYS, $normalizedDays);
        $normalizedInterval = $this->normalizeInterval($interval);
        $normalizedGroupBy = $this->normalizeGroupBy($groupBy);

        $pricing = $this->pricingService->latestPricing($this->model, false);
        $hasPricing = $this->hasPricing($pricing);
        $firstRecorded = $this->tokenUsageRepository->firstRecordedAt();
        $untilDate = $this->normalizeDate($until) ?? new DateTimeImmutable('today', new DateTimeZone('UTC'));
        $startDate = $this->normalizeDate($from);

        if ($firstRecorded === null) {
            return [
                'days' => $normalizedDays,
                'since' => null,
                'from' => null,
                'until' => $untilDate->format(DATE_ATOM),
                'interval' => $normalizedInterval,
                'group_by' => $normalizedGroupBy,
                'include_tokens' => $includeTokens,
                'currency' => $pricing['currency'] ?? 'USD',
                'pricing' => $pricing,
                'has_pricing' => $hasPricing,
                'series' => [],
                'points' => [],
            ];
        }

        $firstDate = $this->normalizeDate($firstRecorded) ?? new DateTimeImmutable('today', new DateTimeZone('UTC'));
        if ($startDate === null) {
            $startDate = $untilDate->sub(new DateInterval('P' . $normalizedDays . 'D'));
        }
        if ($startDate < $firstDate) {
            $startDate = $firstDate;
        }
        $endDate = $untilDate;
        if ($startDate > $endDate) {
            [$startDate, $endDate] = [$endDate, $startDate];
        }
        if ($endDate < $startDate) {
            $endDate = $startDate;
        }

        $rawPoints = $this->tokenUsageRepository->dailyTotalsSince($startDate->format(DATE_ATOM));
        $pointMap = [];
        foreach ($rawPoints as $row) {
            if (!isset($row['date'])) {
                continue;
            }
            $pointMap[$row['date']] = [
                'input' => (int) ($row['input'] ?? 0),
                'output' => (int) ($row['output'] ?? 0),
                'cached' => (int) ($row['cached'] ?? 0),
                'cost' => isset($row['cost']) ? (float) $row['cost'] : null,
            ];
        }

        $dailyPoints = [];
        for ($cursor = $startDate; $cursor <= $endDate; $cursor = $cursor->add(new DateInterval('P1D'))) {
            $dayKey = $cursor->format('Y-m-d');
            $tokens = $pointMap[$dayKey] ?? ['input' => 0, 'output' => 0, 'cached' => 0, 'cost' => null];
            $storedCost = $tokens['cost'] ?? null;
            if ($storedCost !== null && $storedCost > 0) {
                $costs = $this->splitStoredCost($storedCost, $tokens, $pricing, $hasPricing);
            } else {
                $costs = $this->calculateCosts($tokens, $pricing, $hasPricing);
            }
            $dailyPoints[] = [
                'date' => $dayKey,
                'tokens' => [
                    'input' => (int) $tokens['input'],
                    'output' => (int) $tokens['output'],
                    'cached' => (int) $tokens['cached'],
                    'total' => (int) $tokens['input'] + (int) $tokens['output'] + (int) $tokens['cached'],
                ],
                'costs' => $costs,
            ];
        }

        $points = $normalizedInterval === 'week'
            ? $this->aggregateWeekly($dailyPoints, $pricing, $hasPricing)
            : $dailyPoints;

        $responsePoints = array_map(static function (array $point) use ($includeTokens): array {
            $item = [
                'date' => $point['date'],
                'costs' => $point['costs'],
            ];
            if ($includeTokens) {
                $item['tokens'] = $point['tokens'];
            }
            return $item;
        }, $points);

        return [
            'days' => $normalizedDays,
            'since' => $startDate->format(DATE_ATOM),
            'from' => $startDate->format(DATE_ATOM),
            'until' => $endDate->format(DATE_ATOM),
            'interval' => $normalizedInterval,
            'group_by' => $normalizedGroupBy,
            'include_tokens' => $includeTokens,
            'currency' => $pricing['currency'] ?? 'USD',
            'pricing' => $pricing,
            'has_pricing' => $hasPricing,
            'series' => $this->buildSeries($points, $normalizedGroupBy, $includeTokens),
            'points' => $responsePoints,
        ];
    }

    /**
     * @param array<int, array<string, mixed>> $points
     * @return array<int, array<string, mixed>>
     */
    private function aggregateWeekly(array $points, array $pricing, bool $hasPricing): array
    {
        $buckets = [];
        foreach ($points as $point) {
            $date = $this->normalizeDate((string) ($point['date'] ?? ''));
            if ($date === null) {
                continue;
            }
            $weekStart = $date->modify('monday this week');
            $key = $weekStart->format('Y-m-d');
            if (!isset($buckets[$key])) {
                $buckets[$key] = [
                    'date' => $key,
                    'tokens' => [
                        'input' => 0,
                        'output' => 0,
                        'cached' => 0,
                        'total' => 0,
                    ],
                    'costs' => [
                        'input' => 0.0,
                        'output' => 0.0,
                        'cached' => 0.0,
                        'total' => 0.0,
                    ],
                ];
            }
            $buckets[$key]['tokens']['input'] += (int) ($point['tokens']['input'] ?? 0);
            $buckets[$key]['tokens']['output'] += (int) ($point['tokens']['output'] ?? 0);
            $buckets[$key]['tokens']['cached'] += (int) ($point['tokens']['cached'] ?? 0);
            $buckets[$key]['tokens']['total'] += (int) ($point['tokens']['total'] ?? 0);
            $buckets[$key]['costs']['input'] += (float) ($point['costs']['input'] ?? 0.0);
            $buckets[$key]['costs']['output'] += (float) ($point['costs']['output'] ?? 0.0);
            $buckets[$key]['costs']['cached'] += (float) ($point['costs']['cached'] ?? 0.0);
            $buckets[$key]['costs']['total'] += (float) ($point['costs']['total'] ?? 0.0);
        }

        ksort($buckets);
        $weekly = [];
        foreach ($buckets as $bucket) {
            $weekly[] = [
                'date' => $bucket['date'],
                'tokens' => $bucket['tokens'],
                'costs' => $bucket['costs'],
            ];
        }

        return $weekly;
    }

    /**
     * @param array<int, array<string, mixed>> $points
     * @return array<int, array<string, mixed>>
     */
    private function buildSeries(array $points, string $groupBy, bool $includeTokens): array
    {
        $definitions = $groupBy === 'total'
            ? [
                ['key' => 'total', 'label' => 'Total cost'],
            ]
            : [
                ['key' => 'total', 'label' => 'Total cost'],
                ['key' => 'input', 'label' => 'Input cost'],
                ['key' => 'output', 'label' => 'Output cost'],
                ['key' => 'cached', 'label' => 'Cached cost'],
            ];

        $series = [];
        foreach ($definitions as $definition) {
            $seriesPoints = [];
            foreach ($points as $point) {
                $date = (string) ($point['date'] ?? '');
                if ($date === '') {
                    continue;
                }
                $entry = [
                    'ts' => $date . 'T00:00:00Z',
                    'value' => (float) ($point['costs'][$definition['key']] ?? 0.0),
                ];
                if ($includeTokens) {
                    $entry['tokens'] = (int) ($point['tokens'][$definition['key']] ?? 0);
                }
                $seriesPoints[] = $entry;
            }

            $series[] = [
                'key' => $definition['key'],
                'label' => $definition['label'],
                'points' => $seriesPoints,
            ];
        }

        return $series;
    }

    private function normalizeInterval(string $interval): string
    {
        $value = strtolower(trim($interval));
        if ($value === 'day' || $value === 'week') {
            return $value;
        }

        return 'day';
    }

    private function normalizeGroupBy(string $groupBy): string
    {
        $value = strtolower(trim($groupBy));
        if ($value === 'total' || $value === 'component') {
            return $value;
        }

        return 'component';
    }

    private function normalizeDate(?string $value): ?DateTimeImmutable
    {
        if ($value === null) {
            return null;
        }
        $trimmed = trim($value);
        if ($trimmed === '') {
            return null;
        }
        try {
            $date = new DateTimeImmutable($trimmed);
        } catch (\Throwable) {
            return null;
        }

        return $date->setTimezone(new DateTimeZone('UTC'))->setTime(0, 0, 0);
    }

    private function hasPricing(array $pricing): bool
    {
        return ($pricing['input_price_per_1k'] ?? 0) > 0
            || ($pricing['output_price_per_1k'] ?? 0) > 0
            || ($pricing['cached_price_per_1k'] ?? 0) > 0;
    }

    private function splitStoredCost(float $totalCost, array $tokens, array $pricing, bool $hasPricing): array
    {
        if (!$hasPricing || $totalCost <= 0) {
            return [
                'input' => 0.0,
                'output' => 0.0,
                'cached' => 0.0,
                'total' => $totalCost,
            ];
        }

        $calculated = $this->calculateCosts($tokens, $pricing, $hasPricing);
        $calculatedTotal = $calculated['total'];
        if ($calculatedTotal > 0) {
            $ratio = $totalCost / $calculatedTotal;
            return [
                'input' => $calculated['input'] * $ratio,
                'output' => $calculated['output'] * $ratio,
                'cached' => $calculated['cached'] * $ratio,
                'total' => $totalCost,
            ];
        }

        return [
            'input' => 0.0,
            'output' => 0.0,
            'cached' => 0.0,
            'total' => $totalCost,
        ];
    }

    private function calculateCosts(array $tokens, array $pricing, bool $hasPricing): array
    {
        if (!$hasPricing) {
            return [
                'input' => 0.0,
                'output' => 0.0,
                'cached' => 0.0,
                'total' => 0.0,
            ];
        }

        $inputTokens = (int) ($tokens['input'] ?? 0);
        $outputTokens = (int) ($tokens['output'] ?? 0);
        $cachedTokens = (int) ($tokens['cached'] ?? 0);

        $inputCost = ($inputTokens / 1000) * (float) ($pricing['input_price_per_1k'] ?? 0);
        $outputCost = ($outputTokens / 1000) * (float) ($pricing['output_price_per_1k'] ?? 0);
        $cachedCost = ($cachedTokens / 1000) * (float) ($pricing['cached_price_per_1k'] ?? 0);

        return [
            'input' => $inputCost,
            'output' => $outputCost,
            'cached' => $cachedCost,
            'total' => $inputCost + $outputCost + $cachedCost,
        ];
    }
}
