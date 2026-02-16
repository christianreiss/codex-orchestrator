<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Repositories\ChatGptUsageStore;
use App\Repositories\LogRepository;

class ChatGptUsageService
{
    private const MIN_REFRESH_SECONDS = 300;

    public function __construct(
        private readonly AuthService $authService,
        private readonly ChatGptUsageStore $repository,
        private readonly LogRepository $logs,
        private readonly string $baseUrl = 'https://chatgpt.com/backend-api',
        private readonly float $timeoutSeconds = 10.0,
        private readonly mixed $httpClient = null
    ) {
    }

    public function latestSnapshot(): ?array
    {
        return $this->repository->latest();
    }

    public function latestWindowSummary(): ?array
    {
        $snapshot = $this->latestSnapshot();
        if ($snapshot === null) {
            return null;
        }

        $normalPrimary = $this->windowFromSnapshot($snapshot, 'primary_');
        $normalSecondary = $this->windowFromSnapshot($snapshot, 'secondary_');
        $sparkPrimary = $this->windowFromSnapshot($snapshot, 'spark_primary_');
        $sparkSecondary = $this->windowFromSnapshot($snapshot, 'spark_secondary_');
        $sparkWindow = $this->windowGroupOrNull($sparkPrimary, $sparkSecondary);

        $dailyBaseline = null;
        $dailyUsedPercent = null;
        $midnight = gmdate('Y-m-d\T00:00:00\Z');
        try {
            $dailyBaseline = $this->repository->earliestSince($midnight);
        } catch (\Throwable $exception) {
            $dailyBaseline = null;
        }
        if (
            isset($snapshot['secondary_used_percent'])
            && isset($snapshot['secondary_limit_seconds'])
            && $snapshot['secondary_limit_seconds'] !== null
        ) {
            $baselinePercent = $dailyBaseline['secondary_used_percent'] ?? null;
            if (is_int($baselinePercent) && is_int($snapshot['secondary_used_percent'])) {
                $delta = $snapshot['secondary_used_percent'] - $baselinePercent;
                $dailyUsedPercent = $delta > 0 ? $delta : 0;
            }
        }

        $activeLane = 'normal';
        if (isset($snapshot['active_quota_lane']) && is_string($snapshot['active_quota_lane'])) {
            $normalizedLane = strtolower(trim($snapshot['active_quota_lane']));
            if ($normalizedLane === 'spark' || $normalizedLane === 'normal') {
                $activeLane = $normalizedLane;
            }
        }

        return [
            'status' => $snapshot['status'] ?? null,
            'plan_type' => $snapshot['plan_type'] ?? null,
            'rate_allowed' => $snapshot['rate_allowed'] ?? null,
            'rate_limit_reached' => $snapshot['rate_limit_reached'] ?? null,
            'spark_rate_allowed' => $snapshot['spark_rate_allowed'] ?? null,
            'spark_rate_limit_reached' => $snapshot['spark_rate_limit_reached'] ?? null,
            'spark_limit_name' => $snapshot['spark_limit_name'] ?? null,
            'spark_metered_feature' => $snapshot['spark_metered_feature'] ?? null,
            'active_quota_lane' => $activeLane,
            'fetched_at' => $snapshot['fetched_at'] ?? null,
            'next_eligible_at' => $snapshot['next_eligible_at'] ?? null,
            // Backward compatibility for existing wrappers/clients: keep legacy keys as the normal lane.
            'primary_window' => $normalPrimary,
            'secondary_window' => $normalSecondary,
            'normal_window' => [
                'primary_window' => $normalPrimary,
                'secondary_window' => $normalSecondary,
            ],
            'spark_window' => $sparkWindow,
            'daily_used_percent' => $dailyUsedPercent,
            'daily_baseline_at' => $dailyBaseline['fetched_at'] ?? null,
        ];
    }

    public function history(int $days = 60): array
    {
        if ($days < 1) {
            $days = 60;
        }
        $days = min(180, $days);
        $since = gmdate(DATE_ATOM, strtotime('-' . $days . ' days'));

        $points = $this->repository->history($since);

        return [
            'days' => $days,
            'since' => $since,
            'points' => $points,
        ];
    }

    public function fetchLatest(bool $force = false): array
    {
        $now = time();
        $latest = $this->repository->latest();
        $eligibleAt = $latest && isset($latest['next_eligible_at']) ? strtotime((string) $latest['next_eligible_at']) : 0;
        if (!$force && $latest !== null && $eligibleAt > $now) {
            return [
                'snapshot' => $latest,
                'cached' => true,
                'next_eligible_at' => $latest['next_eligible_at'] ?? null,
            ];
        }

        $canonical = $this->authService->canonicalAuthSnapshot();
        if ($canonical === null) {
            $snapshot = $this->storeError('missing_canonical_auth', 'Canonical auth.json not available');
            return ['snapshot' => $snapshot, 'cached' => false, 'next_eligible_at' => $snapshot['next_eligible_at']];
        }

        $tokens = $canonical['tokens'] ?? null;
        if (!is_array($tokens)) {
            $snapshot = $this->storeError('missing_token', 'tokens object missing in auth.json');
            return ['snapshot' => $snapshot, 'cached' => false, 'next_eligible_at' => $snapshot['next_eligible_at']];
        }

        $accessToken = $tokens['access_token'] ?? null;
        if (!is_string($accessToken) || trim($accessToken) === '') {
            $snapshot = $this->storeError('missing_token', 'access_token missing or empty in auth.json');
            return ['snapshot' => $snapshot, 'cached' => false, 'next_eligible_at' => $snapshot['next_eligible_at']];
        }

        $accountId = $tokens['account_id'] ?? null;
        $accountId = is_string($accountId) && trim($accountId) !== '' ? trim($accountId) : null;

        $response = $this->requestUsage($accessToken, $accountId);
        $nextEligible = gmdate(DATE_ATOM, $now + self::MIN_REFRESH_SECONDS);

        if ($response['error'] !== null) {
            $snapshot = $this->repository->record([
                'status' => 'error',
                'error' => $response['error'],
                'raw' => $response['body'],
                'fetched_at' => gmdate(DATE_ATOM, $now),
                'next_eligible_at' => $nextEligible,
            ]);
            $this->logs->log(null, 'chatgpt.usage', [
                'status' => 'error',
                'reason' => $response['error'],
                'http_status' => $response['status'],
            ]);

            return ['snapshot' => $snapshot, 'cached' => false, 'next_eligible_at' => $nextEligible];
        }

        $parsed = $this->parseUsageJson($response['json']);
        $snapshot = $this->repository->record(array_merge($parsed, [
            'status' => 'ok',
            'raw' => $response['body'],
            'fetched_at' => gmdate(DATE_ATOM, $now),
            'next_eligible_at' => $nextEligible,
        ]));

        $this->logs->log(null, 'chatgpt.usage', [
            'status' => 'ok',
            'plan_type' => $snapshot['plan_type'] ?? null,
            'spark_limit_name' => $snapshot['spark_limit_name'] ?? null,
            'cached' => false,
        ]);

        return ['snapshot' => $snapshot, 'cached' => false, 'next_eligible_at' => $nextEligible];
    }

    private function requestUsage(string $accessToken, ?string $accountId): array
    {
        $url = rtrim($this->baseUrl, '/') . '/wham/usage';
        $headers = [
            'Authorization: Bearer ' . $accessToken,
            'User-Agent: codex-auth',
            'Accept: application/json',
        ];
        if ($accountId !== null) {
            $headers[] = 'ChatGPT-Account-Id: ' . $accountId;
        }

        $http = $this->httpClient ?? [$this, 'defaultHttpClient'];
        return $http($url, $headers, (float) $this->timeoutSeconds);
    }

    private function defaultHttpClient(string $url, array $headers, float $timeout): array
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_TIMEOUT => $timeout,
        ]);
        $body = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err = $body === false ? curl_error($ch) : null;
        curl_close($ch);

        if ($body === false) {
            return [
                'status' => $status ?: 0,
                'body' => '',
                'json' => null,
                'error' => $err ?: 'curl error',
            ];
        }

        $decoded = json_decode($body, true);
        $jsonErr = json_last_error() === JSON_ERROR_NONE ? null : json_last_error_msg();

        if ($status < 200 || $status >= 300) {
            return [
                'status' => $status,
                'body' => $body,
                'json' => $decoded,
                'error' => 'HTTP ' . $status,
            ];
        }

        if (!is_array($decoded)) {
            return [
                'status' => $status,
                'body' => $body,
                'json' => null,
                'error' => $jsonErr ?? 'Invalid JSON payload',
            ];
        }

        return [
            'status' => $status,
            'body' => $body,
            'json' => $decoded,
            'error' => null,
        ];
    }

    private function parseUsageJson(array $json): array
    {
        $rate = is_array($json['rate_limit'] ?? null) ? $json['rate_limit'] : [];
        $primary = is_array($rate['primary_window'] ?? null) ? $rate['primary_window'] : [];
        $secondary = is_array($rate['secondary_window'] ?? null) ? $rate['secondary_window'] : [];
        $spark = $this->extractSparkRateLimit($json['additional_rate_limits'] ?? null);
        $sparkRate = is_array($spark['rate_limit'] ?? null) ? $spark['rate_limit'] : [];
        $sparkPrimary = is_array($sparkRate['primary_window'] ?? null) ? $sparkRate['primary_window'] : [];
        $sparkSecondary = is_array($sparkRate['secondary_window'] ?? null) ? $sparkRate['secondary_window'] : [];
        $credits = $json['credits'] ?? [];

        return [
            'plan_type' => $json['plan_type'] ?? null,
            'rate_allowed' => isset($rate['allowed']) ? (bool) $rate['allowed'] : null,
            'rate_limit_reached' => isset($rate['limit_reached']) ? (bool) $rate['limit_reached'] : null,
            'primary_used_percent' => $this->normalizeInt($primary['used_percent'] ?? null),
            'primary_limit_seconds' => $this->normalizeInt($primary['limit_window_seconds'] ?? null),
            'primary_reset_after_seconds' => $this->normalizeInt($primary['reset_after_seconds'] ?? null),
            'primary_reset_at' => isset($primary['reset_at']) ? (string) $primary['reset_at'] : null,
            'secondary_used_percent' => $this->normalizeInt($secondary['used_percent'] ?? null),
            'secondary_limit_seconds' => $this->normalizeInt($secondary['limit_window_seconds'] ?? null),
            'secondary_reset_after_seconds' => $this->normalizeInt($secondary['reset_after_seconds'] ?? null),
            'secondary_reset_at' => isset($secondary['reset_at']) ? (string) $secondary['reset_at'] : null,
            'spark_limit_name' => isset($spark['limit_name']) && is_string($spark['limit_name']) ? trim($spark['limit_name']) : null,
            'spark_metered_feature' => isset($spark['metered_feature']) && is_string($spark['metered_feature']) ? trim($spark['metered_feature']) : null,
            'spark_rate_allowed' => isset($sparkRate['allowed']) ? (bool) $sparkRate['allowed'] : null,
            'spark_rate_limit_reached' => isset($sparkRate['limit_reached']) ? (bool) $sparkRate['limit_reached'] : null,
            'spark_primary_used_percent' => $this->normalizeInt($sparkPrimary['used_percent'] ?? null),
            'spark_primary_limit_seconds' => $this->normalizeInt($sparkPrimary['limit_window_seconds'] ?? null),
            'spark_primary_reset_after_seconds' => $this->normalizeInt($sparkPrimary['reset_after_seconds'] ?? null),
            'spark_primary_reset_at' => isset($sparkPrimary['reset_at']) ? (string) $sparkPrimary['reset_at'] : null,
            'spark_secondary_used_percent' => $this->normalizeInt($sparkSecondary['used_percent'] ?? null),
            'spark_secondary_limit_seconds' => $this->normalizeInt($sparkSecondary['limit_window_seconds'] ?? null),
            'spark_secondary_reset_after_seconds' => $this->normalizeInt($sparkSecondary['reset_after_seconds'] ?? null),
            'spark_secondary_reset_at' => isset($sparkSecondary['reset_at']) ? (string) $sparkSecondary['reset_at'] : null,
            'has_credits' => isset($credits['has_credits']) ? (bool) $credits['has_credits'] : null,
            'unlimited' => isset($credits['unlimited']) ? (bool) $credits['unlimited'] : null,
            'credit_balance' => isset($credits['balance']) ? (string) $credits['balance'] : null,
            'approx_local_messages' => $credits['approx_local_messages'] ?? null,
            'approx_cloud_messages' => $credits['approx_cloud_messages'] ?? null,
        ];
    }

    private function extractSparkRateLimit(mixed $limits): array
    {
        if (!is_array($limits)) {
            return [];
        }

        $winner = [];
        $winnerScore = 0;

        foreach ($limits as $candidate) {
            if (!is_array($candidate)) {
                continue;
            }
            $rate = $candidate['rate_limit'] ?? null;
            if (!is_array($rate)) {
                continue;
            }

            $limitName = is_string($candidate['limit_name'] ?? null) ? strtolower(trim((string) $candidate['limit_name'])) : '';
            $meteredFeature = is_string($candidate['metered_feature'] ?? null) ? strtolower(trim((string) $candidate['metered_feature'])) : '';
            $score = 0;
            if ($limitName !== '' && str_contains($limitName, 'spark')) {
                $score = 3;
            } elseif ($meteredFeature !== '' && str_contains($meteredFeature, 'spark')) {
                $score = 2;
            } elseif ($meteredFeature !== '' && str_contains($meteredFeature, 'bengalfox')) {
                // Current upstream Spark metered feature uses codename "bengalfox".
                $score = 1;
            }

            if ($score > $winnerScore) {
                $winner = $candidate;
                $winnerScore = $score;
            }
        }

        return $winnerScore > 0 ? $winner : [];
    }

    private function windowFromSnapshot(array $snapshot, string $prefix): array
    {
        return [
            'used_percent' => $snapshot[$prefix . 'used_percent'] ?? null,
            'limit_seconds' => $snapshot[$prefix . 'limit_seconds'] ?? null,
            'reset_after_seconds' => $snapshot[$prefix . 'reset_after_seconds'] ?? null,
            'reset_at' => $snapshot[$prefix . 'reset_at'] ?? null,
        ];
    }

    private function windowGroupOrNull(array $primary, array $secondary): ?array
    {
        $hasValue = false;
        foreach ([$primary, $secondary] as $window) {
            foreach ($window as $value) {
                if ($value !== null && $value !== '') {
                    $hasValue = true;
                    break 2;
                }
            }
        }

        if (!$hasValue) {
            return null;
        }

        return [
            'primary_window' => $primary,
            'secondary_window' => $secondary,
        ];
    }

    private function normalizeInt(mixed $value): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }

        if (is_numeric($value)) {
            $intVal = (int) $value;
            if ($intVal < 0) {
                return null;
            }

            return $intVal;
        }

        return null;
    }

    private function storeError(string $reason, string $message): array
    {
        $now = time();
        $nextEligible = gmdate(DATE_ATOM, $now + self::MIN_REFRESH_SECONDS);
        $snapshot = $this->repository->record([
            'status' => 'error',
            'error' => $message,
            'fetched_at' => gmdate(DATE_ATOM, $now),
            'next_eligible_at' => $nextEligible,
        ]);

        $this->logs->log(null, 'chatgpt.usage', [
            'status' => 'error',
            'reason' => $reason,
        ]);

        return $snapshot;
    }
}
