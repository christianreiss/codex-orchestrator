<?php

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

        $primary = [
            'used_percent' => $snapshot['primary_used_percent'] ?? null,
            'limit_seconds' => $snapshot['primary_limit_seconds'] ?? null,
            'reset_after_seconds' => $snapshot['primary_reset_after_seconds'] ?? null,
            'reset_at' => $snapshot['primary_reset_at'] ?? null,
        ];

        $secondary = [
            'used_percent' => $snapshot['secondary_used_percent'] ?? null,
            'limit_seconds' => $snapshot['secondary_limit_seconds'] ?? null,
            'reset_after_seconds' => $snapshot['secondary_reset_after_seconds'] ?? null,
            'reset_at' => $snapshot['secondary_reset_at'] ?? null,
        ];

        return [
            'status' => $snapshot['status'] ?? null,
            'plan_type' => $snapshot['plan_type'] ?? null,
            'rate_allowed' => $snapshot['rate_allowed'] ?? null,
            'rate_limit_reached' => $snapshot['rate_limit_reached'] ?? null,
            'fetched_at' => $snapshot['fetched_at'] ?? null,
            'next_eligible_at' => $snapshot['next_eligible_at'] ?? null,
            'primary_window' => $primary,
            'secondary_window' => $secondary,
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
        $rate = $json['rate_limit'] ?? [];
        $primary = $rate['primary_window'] ?? [];
        $secondary = $rate['secondary_window'] ?? [];
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
            'has_credits' => isset($credits['has_credits']) ? (bool) $credits['has_credits'] : null,
            'unlimited' => isset($credits['unlimited']) ? (bool) $credits['unlimited'] : null,
            'credit_balance' => isset($credits['balance']) ? (string) $credits['balance'] : null,
            'approx_local_messages' => $credits['approx_local_messages'] ?? null,
            'approx_cloud_messages' => $credits['approx_cloud_messages'] ?? null,
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
