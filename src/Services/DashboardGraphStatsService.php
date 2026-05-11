<?php

declare(strict_types=1);

namespace App\Services;

use App\Repositories\ChatGptUsageStore;
use App\Repositories\DashboardGraphStatsRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\VersionRepository;

class DashboardGraphStatsService
{
    private const BACKFILL_VERSION_KEY = 'dashboard_graph_stats_backfill_v1';
    private bool $backfillChecked = false;

    public function __construct(
        private readonly DashboardGraphStatsRepository $repository,
        private readonly TokenUsageRepository $tokenUsages,
        private readonly ChatGptUsageStore $chatGptUsageStore,
        private readonly VersionRepository $versions
    ) {
    }

    public function recordTokenUsage(array $usage, ?string $recordedAt = null): void
    {
        if (!$this->hasUsageSignal($usage)) {
            return;
        }

        $this->repository->incrementUsageDaily([
            'total' => (int) ($usage['total'] ?? 0),
            'input' => (int) ($usage['input'] ?? 0),
            'output' => (int) ($usage['output'] ?? 0),
            'cached' => (int) ($usage['cached'] ?? 0),
            'reasoning' => (int) ($usage['reasoning'] ?? 0),
        ], $recordedAt);
    }

    public function recordQuotaSnapshot(array $snapshot): void
    {
        if (!isset($snapshot['fetched_at']) || !is_string($snapshot['fetched_at']) || trim($snapshot['fetched_at']) === '') {
            return;
        }

        $this->repository->recordQuotaSnapshot($snapshot);
    }

    public function backfillMissingHistory(): void
    {
        $this->backfillChecked = true;

        if ($this->versions->get(self::BACKFILL_VERSION_KEY) !== null) {
            return;
        }

        $firstUsageAt = $this->tokenUsages->firstRecordedAt();
        if ($firstUsageAt !== null) {
            foreach ($this->tokenUsages->dailyTotalsSince($firstUsageAt) as $row) {
                $day = trim((string) ($row['date'] ?? ''));
                if ($day === '') {
                    continue;
                }
                $this->repository->upsertUsageDaily([
                    'date' => $day,
                    'total' => (int) ($row['input'] ?? 0) + (int) ($row['output'] ?? 0) + (int) ($row['cached'] ?? 0),
                    'input' => (int) ($row['input'] ?? 0),
                    'output' => (int) ($row['output'] ?? 0),
                    'cached' => (int) ($row['cached'] ?? 0),
                    'reasoning' => (int) ($row['reasoning'] ?? 0),
                ]);
            }
        }

        foreach ($this->chatGptUsageStore->history(null) as $snapshot) {
            $this->recordQuotaSnapshot($snapshot);
        }

        $this->versions->set(self::BACKFILL_VERSION_KEY, gmdate(DATE_ATOM));
    }

    public function firstUsageRecordedAt(): ?string
    {
        $this->ensureBackfilled();
        return $this->repository->firstUsageRecordedAt();
    }

    public function usageDailySince(string $startIso): array
    {
        $this->ensureBackfilled();
        return $this->repository->usageDailySince($startIso);
    }

    public function quotaHistory(?string $since = null): array
    {
        $this->ensureBackfilled();
        return $this->repository->quotaHistory($since);
    }

    public function deleteOlderThan(int $days): array
    {
        return $this->repository->deleteOlderThan($days);
    }

    private function hasUsageSignal(array $usage): bool
    {
        foreach (['total', 'input', 'output', 'cached', 'reasoning'] as $key) {
            if (isset($usage[$key]) && (int) $usage[$key] > 0) {
                return true;
            }
        }

        return false;
    }

    private function ensureBackfilled(): void
    {
        if ($this->backfillChecked) {
            return;
        }

        $this->backfillMissingHistory();
    }
}
