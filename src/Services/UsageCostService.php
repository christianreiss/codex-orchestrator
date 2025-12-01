<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Repositories\TokenUsageIngestRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\VersionRepository;

class UsageCostService
{
    private const BACKFILL_VERSION_KEY = 'token_usage_cost_backfill_v1';

    public function __construct(
        private readonly TokenUsageRepository $tokenUsageRepository,
        private readonly TokenUsageIngestRepository $tokenUsageIngestRepository,
        private readonly PricingService $pricingService,
        private readonly VersionRepository $versions,
        private readonly string $model = 'gpt-5.1'
    ) {
    }

    public function backfillMissingCosts(): void
    {
        if ($this->versions->get(self::BACKFILL_VERSION_KEY) !== null) {
            return;
        }

        try {
            $pricing = $this->pricingService->latestPricing($this->model, false);
            $inputPrice = (float) ($pricing['input_price_per_1k'] ?? 0);
            $outputPrice = (float) ($pricing['output_price_per_1k'] ?? 0);
            $cachedPrice = (float) ($pricing['cached_price_per_1k'] ?? 0);

            $this->tokenUsageRepository->backfillCosts($inputPrice, $outputPrice, $cachedPrice);
            $this->tokenUsageIngestRepository->backfillCosts($inputPrice, $outputPrice, $cachedPrice);

            $this->versions->set(self::BACKFILL_VERSION_KEY, gmdate(DATE_ATOM));
        } catch (\Throwable $exception) {
            error_log('[cost-backfill] failed: ' . $exception->getMessage());
        }
    }
}
