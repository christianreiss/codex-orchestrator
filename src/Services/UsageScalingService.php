<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Repositories\VersionRepository;

class UsageScalingService
{
    public const VERSION_KEY_RULES = 'scaling_rules';
    public const VERSION_KEY_STATE = 'scaling_active_state';

    private const DEFAULT_MIN_ELAPSED_FRACTION = 0.05;
    private const DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 1800;
    /** @var list<array{projected_percent:int, reasoning_effort:string, model:string}> */
    private const DEFAULT_TIERS = [
        ['projected_percent' => 80, 'reasoning_effort' => 'high', 'model' => 'gpt-5.4'],
        ['projected_percent' => 85, 'reasoning_effort' => 'medium', 'model' => 'gpt-5.4'],
        ['projected_percent' => 92, 'reasoning_effort' => 'high', 'model' => 'gpt-5.3-codex'],
        ['projected_percent' => 100, 'reasoning_effort' => 'medium', 'model' => 'gpt-5.3-codex'],
    ];

    public function __construct(
        private readonly ChatGptUsageService $usageService,
        private readonly VersionRepository $versions
    ) {
    }

    /**
     * Compute the scaling adjustment for the given lane based on projected
     * end-of-window usage and the configured tier thresholds.
     *
     * Returns null when scaling is disabled, insufficient data exists, or
     * no tier threshold is exceeded.
     *
     * @return array{reasoning_effort:?string, model:?string, projected_percent:float, tier_index:int}|null
     */
    public function computeScalingAdjustment(?string $lane = null): ?array
    {
        $rules = $this->loadRules();
        if ($rules === null || !($rules['enabled'] ?? false)) {
            return null;
        }

        $tiers = $rules['tiers'] ?? [];
        if (!is_array($tiers) || $tiers === []) {
            return null;
        }

        $summary = $this->usageService->latestWindowSummary();
        if ($summary === null) {
            return null;
        }

        $rawLane = $lane ?? ($summary['active_quota_lane'] ?? 'normal');
        $activeLane = is_string($rawLane) ? $rawLane : 'normal';

        $window = $this->windowForLane($summary, $activeLane);
        if ($window === null) {
            return null;
        }

        $secondary = $window['secondary_window'] ?? null;
        if (!is_array($secondary)) {
            return null;
        }

        $fetchedAt = $summary['fetched_at'] ?? null;
        $maxAgeRaw = $rules['max_snapshot_age_seconds'] ?? self::DEFAULT_MAX_SNAPSHOT_AGE_SECONDS;
        $maxAge = is_numeric($maxAgeRaw) ? (int) $maxAgeRaw : self::DEFAULT_MAX_SNAPSHOT_AGE_SECONDS;
        if (is_string($fetchedAt) && $maxAge > 0) {
            $fetchedTs = strtotime($fetchedAt);
            if ($fetchedTs !== false && (time() - $fetchedTs) > $maxAge) {
                return null;
            }
        }

        $projected = $this->projectFromWindow($secondary, $rules);
        if ($projected === null) {
            return null;
        }

        $matched = $this->matchTier($projected, $tiers);
        if ($matched === null) {
            return null;
        }

        $result = [
            'reasoning_effort' => $matched['reasoning_effort'] ?? null,
            'model' => $matched['model'] ?? null,
            'projected_percent' => round($projected, 2),
            'tier_index' => $matched['_index'],
            'lane' => $activeLane,
        ];

        $this->persistActiveState($result);

        return $result;
    }

    /**
     * Project end-of-window usage percentage for a given lane.
     */
    public function projectEndOfWindowPercent(string $lane): ?float
    {
        $summary = $this->usageService->latestWindowSummary();
        if ($summary === null) {
            return null;
        }

        $window = $this->windowForLane($summary, $lane);
        if ($window === null) {
            return null;
        }

        $secondary = $window['secondary_window'] ?? null;
        if (!is_array($secondary)) {
            return null;
        }

        return $this->projectFromWindow($secondary, $this->loadRules() ?? []);
    }

    /**
     * Check whether a host should be exempt from scaling adjustments.
     */
    public function isHostExempt(array $host, ?array $rules = null): bool
    {
        $rules ??= $this->loadRules() ?? [];

        if (($rules['vip_exempt'] ?? true) && !empty($host['vip'])) {
            return true;
        }

        if (!empty($host['scaling_exempt'])) {
            return true;
        }

        if ($rules['host_override_wins'] ?? true) {
            $hasModelOverride = isset($host['model_override']) && $host['model_override'] !== null && $host['model_override'] !== '';
            $hasEffortOverride = isset($host['reasoning_effort_override']) && $host['reasoning_effort_override'] !== null && $host['reasoning_effort_override'] !== '';
            if ($hasModelOverride || $hasEffortOverride) {
                return true;
            }
        }

        return false;
    }

    /**
     * Full scaling status for the admin dashboard.
     *
     * @return array{enabled:bool, rules:?array, normal:?array, spark:?array}
     */
    public function currentStatus(): array
    {
        $rules = $this->loadRules();
        $enabled = $rules !== null && ($rules['enabled'] ?? false);

        $summary = $this->usageService->latestWindowSummary();
        $normalStatus = $this->laneStatus($summary, 'normal', $rules);
        $sparkStatus = $this->laneStatus($summary, 'spark', $rules);

        $activeState = $this->loadActiveState();

        return [
            'enabled' => $enabled,
            'rules' => $rules,
            'normal' => $normalStatus,
            'spark' => $sparkStatus,
            'active_state' => $activeState,
        ];
    }

    /**
     * Validate and store scaling rules.
     *
     * @return string[] Validation errors (empty on success)
     */
    public function storeRules(array $rules): array
    {
        $errors = $this->validateRules($rules);
        if ($errors !== []) {
            return $errors;
        }

        $encoded = json_encode($rules, JSON_UNESCAPED_SLASHES);
        if (!is_string($encoded)) {
            return ['Failed to encode rules as JSON'];
        }
        $this->versions->set(self::VERSION_KEY_RULES, $encoded);

        return [];
    }

    /**
     * Load and decode the scaling rules from the versions table.
     */
    public function loadRules(): ?array
    {
        $raw = $this->versions->get(self::VERSION_KEY_RULES);
        if ($raw === null) {
            return null;
        }

        $decoded = json_decode($raw, true);
        return is_array($decoded) ? $decoded : null;
    }

    /**
     * @return list<array{projected_percent:int, reasoning_effort:string, model:string}>
     */
    public static function defaultTiers(): array
    {
        return self::DEFAULT_TIERS;
    }

    // -- Internal helpers --

    private function windowForLane(array $summary, string $lane): ?array
    {
        if ($lane === 'spark') {
            return $summary['spark_window'] ?? null;
        }

        return $summary['normal_window'] ?? null;
    }

    /**
     * Project end-of-window percentage from a secondary window array.
     *
     * Returns null when insufficient time has elapsed (volatility guard).
     */
    private function projectFromWindow(array $secondary, array $rules): ?float
    {
        $usedPercent = $secondary['used_percent'] ?? null;
        $limitSeconds = $secondary['limit_seconds'] ?? null;
        $resetAfterSeconds = $secondary['reset_after_seconds'] ?? null;

        if (!is_numeric($usedPercent) || !is_numeric($limitSeconds) || !is_numeric($resetAfterSeconds)) {
            return null;
        }

        $usedPercent = (float) $usedPercent;
        $limitSeconds = (int) $limitSeconds;
        $resetAfterSeconds = (int) $resetAfterSeconds;

        if ($limitSeconds <= 0 || $resetAfterSeconds < 0) {
            return null;
        }

        $elapsed = $limitSeconds - $resetAfterSeconds;
        if ($elapsed <= 0) {
            return $usedPercent;
        }

        $minFraction = (float) ($rules['min_window_elapsed_fraction'] ?? self::DEFAULT_MIN_ELAPSED_FRACTION);
        if ($minFraction > 0 && ($elapsed / $limitSeconds) < $minFraction) {
            return null;
        }

        $burnRatePerSecond = $usedPercent / $elapsed;
        $projected = $usedPercent + ($burnRatePerSecond * $resetAfterSeconds);

        return $projected;
    }

    /**
     * Find the highest-threshold tier that the projected percentage exceeds.
     */
    private function matchTier(float $projectedPercent, array $tiers): ?array
    {
        $matched = null;
        foreach ($tiers as $index => $tier) {
            if (!is_array($tier)) {
                continue;
            }
            $threshold = $tier['projected_percent'] ?? null;
            if (!is_numeric($threshold)) {
                continue;
            }
            if ($projectedPercent >= (float) $threshold) {
                $tier['_index'] = $index;
                $matched = $tier;
            }
        }

        return $matched;
    }

    /**
     * Compute status for a single lane (used by currentStatus).
     */
    private function laneStatus(?array $summary, string $lane, ?array $rules): ?array
    {
        if ($summary === null) {
            return null;
        }

        $window = $this->windowForLane($summary, $lane);
        if ($window === null) {
            return null;
        }

        $secondary = $window['secondary_window'] ?? null;
        if (!is_array($secondary)) {
            return null;
        }

        $usedPercent = $secondary['used_percent'] ?? null;
        $limitSeconds = $secondary['limit_seconds'] ?? null;
        $resetAfterSeconds = $secondary['reset_after_seconds'] ?? null;
        $resetAt = $secondary['reset_at'] ?? null;

        $projected = $this->projectFromWindow($secondary, $rules ?? []);

        $burnRatePerHour = null;
        if (is_numeric($usedPercent) && is_numeric($limitSeconds) && is_numeric($resetAfterSeconds)) {
            $elapsed = (int) $limitSeconds - (int) $resetAfterSeconds;
            if ($elapsed > 0) {
                $burnRatePerHour = round(((float) $usedPercent / $elapsed) * 3600, 4);
            }
        }

        $tiers = ($rules['tiers'] ?? []);
        $activeTier = ($projected !== null && is_array($tiers) && $tiers !== [])
            ? $this->matchTier($projected, $tiers)
            : null;

        return [
            'current_used_percent' => $usedPercent,
            'projected_percent' => $projected !== null ? round($projected, 2) : null,
            'burn_rate_percent_per_hour' => $burnRatePerHour,
            'reset_after_seconds' => $resetAfterSeconds,
            'reset_at' => $resetAt,
            'active_tier_index' => $activeTier['_index'] ?? null,
            'active_reasoning_effort' => $activeTier['reasoning_effort'] ?? null,
            'active_model' => $activeTier['model'] ?? null,
        ];
    }

    /**
     * Validate a scaling rules array.
     *
     * @return string[]
     */
    private function validateRules(array $rules): array
    {
        $errors = [];

        if (!isset($rules['enabled']) || !is_bool($rules['enabled'])) {
            $errors[] = 'enabled must be a boolean';
        }

        $tiers = $rules['tiers'] ?? null;
        if (!is_array($tiers) || $tiers === []) {
            $errors[] = 'tiers must be a non-empty array';
            return $errors;
        }

        foreach ($tiers as $i => $tier) {
            if (!is_array($tier)) {
                $errors[] = "tiers[{$i}] must be an object";
                continue;
            }
            if (!isset($tier['projected_percent']) || !is_numeric($tier['projected_percent'])) {
                $errors[] = "tiers[{$i}].projected_percent must be numeric";
            }

            $effort = $tier['reasoning_effort'] ?? null;
            if ($effort !== null && ConfigNormalizer::normalizeReasoningEffort($effort) === null) {
                $errors[] = "tiers[{$i}].reasoning_effort must be one of: " . implode(', ', ConfigNormalizer::REASONING_EFFORTS);
            }

            $model = $tier['model'] ?? null;
            if ($model !== null && ConfigNormalizer::normalizeSupportedModel($model) === null) {
                $errors[] = "tiers[{$i}].model must be one of: " . implode(', ', ConfigNormalizer::SUPPORTED_MODELS);
            }
            if ($model === 'gpt-5.3-codex-spark') {
                $errors[] = "tiers[{$i}].model must not be gpt-5.3-codex-spark";
            }

            if ($model !== null && $effort !== null) {
                if (!ConfigNormalizer::modelSupportsReasoningEffort($model, $effort)) {
                    $supported = implode(', ', ConfigNormalizer::supportedReasoningEffortsForModel($model));
                    $errors[] = sprintf('tiers[%s]: model %s does not support effort %s (supported: %s)', $i, (string) $model, (string) $effort, $supported);
                }
            }
        }

        return $errors;
    }

    private function persistActiveState(array $state): void
    {
        $state['computed_at'] = gmdate(DATE_ATOM);
        $encoded = json_encode($state, JSON_UNESCAPED_SLASHES);
        if (is_string($encoded)) {
            $this->versions->set(self::VERSION_KEY_STATE, $encoded);
        }
    }

    private function loadActiveState(): ?array
    {
        $raw = $this->versions->get(self::VERSION_KEY_STATE);
        if ($raw === null) {
            return null;
        }

        $decoded = json_decode($raw, true);
        return is_array($decoded) ? $decoded : null;
    }
}
