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

    public function __construct(
        private readonly TokenUsageRepository $tokenUsageRepository,
        private readonly PricingService $pricingService,
        private readonly string $model = 'gpt-5.1'
    ) {
    }

    public function history(int $days = 60): array
    {
        $normalizedDays = $days < 1 ? 60 : $days;
        $normalizedDays = min(self::MAX_DAYS, $normalizedDays);

        $pricing = $this->pricingService->latestPricing($this->model, false);
        $hasPricing = $this->hasPricing($pricing);
        $firstRecorded = $this->tokenUsageRepository->firstRecordedAt();

        if ($firstRecorded === null) {
            return [
                'days' => $normalizedDays,
                'since' => null,
                'until' => gmdate(DATE_ATOM),
                'currency' => $pricing['currency'] ?? 'USD',
                'pricing' => $pricing,
                'has_pricing' => $hasPricing,
                'points' => [],
            ];
        }

        $sinceTs = strtotime('-' . $normalizedDays . ' days');
        $firstTs = strtotime($firstRecorded);
        if ($firstTs && $sinceTs !== false && $firstTs > $sinceTs) {
            $sinceTs = $firstTs;
        }
        if ($sinceTs === false) {
            $sinceTs = time() - (60 * 86400);
        }

        $startDate = new DateTimeImmutable(gmdate('Y-m-d', $sinceTs), new DateTimeZone('UTC'));
        $endDate = new DateTimeImmutable('today', new DateTimeZone('UTC'));
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
            ];
        }

        $points = [];
        for ($cursor = $startDate; $cursor <= $endDate; $cursor = $cursor->add(new DateInterval('P1D'))) {
            $dayKey = $cursor->format('Y-m-d');
            $tokens = $pointMap[$dayKey] ?? ['input' => 0, 'output' => 0, 'cached' => 0];
            $costs = $this->calculateCosts($tokens, $pricing, $hasPricing);

            $points[] = [
                'date' => $dayKey,
                'tokens' => [
                    'input' => $tokens['input'],
                    'output' => $tokens['output'],
                    'cached' => $tokens['cached'],
                    'total' => $tokens['input'] + $tokens['output'] + $tokens['cached'],
                ],
                'costs' => $costs,
            ];
        }

        return [
            'days' => $normalizedDays,
            'since' => $startDate->format(DATE_ATOM),
            'until' => $endDate->format(DATE_ATOM),
            'currency' => $pricing['currency'] ?? 'USD',
            'pricing' => $pricing,
            'has_pricing' => $hasPricing,
            'points' => $points,
        ];
    }

    private function hasPricing(array $pricing): bool
    {
        return ($pricing['input_price_per_1k'] ?? 0) > 0
            || ($pricing['output_price_per_1k'] ?? 0) > 0
            || ($pricing['cached_price_per_1k'] ?? 0) > 0;
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
