<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Config;
use App\Repositories\PricingSnapshotRepository;
use App\Repositories\LogRepository;

class PricingService
{
    private const REFRESH_SECONDS = 86400;

    public function __construct(
        private readonly PricingSnapshotRepository $repository,
        private readonly LogRepository $logs,
        private readonly string $defaultModel = 'gpt-5.1',
        private readonly string $pricingUrl = '',
        private readonly mixed $httpClient = null
    ) {
    }

    public function latestPricing(string $model, bool $force = false): array
    {
        $now = time();
        $cached = $this->repository->latestForModel($model);
        $missingPrices = !$cached
            || (($cached['input_price_per_1k'] ?? 0) <= 0 && ($cached['output_price_per_1k'] ?? 0) <= 0 && ($cached['cached_price_per_1k'] ?? 0) <= 0);
        $freshEnough = $cached !== null && isset($cached['fetched_at']) && (strtotime((string) $cached['fetched_at']) >= ($now - self::REFRESH_SECONDS));
        if ($cached && !$force && $freshEnough && !$missingPrices) {
            return $cached;
        }

        $pricing = $this->fetchPricing($model);
        $stored = $this->repository->record($pricing);
        $this->logs->log(null, 'pricing.refresh', [
            'model' => $model,
            'source_url' => $pricing['source_url'] ?? null,
            'fetched_at' => $stored['fetched_at'] ?? null,
        ]);

        return $stored;
    }

    public function calculateCost(array $pricing, array $tokens): float
    {
        $inputPrice = isset($pricing['input_price_per_1k']) ? (float) $pricing['input_price_per_1k'] : 0.0;
        $outputPrice = isset($pricing['output_price_per_1k']) ? (float) $pricing['output_price_per_1k'] : 0.0;
        $cachedPrice = isset($pricing['cached_price_per_1k']) ? (float) $pricing['cached_price_per_1k'] : 0.0;

        if ($inputPrice <= 0 && $outputPrice <= 0 && $cachedPrice <= 0) {
            return 0.0;
        }

        $inputTokens = isset($tokens['input']) ? (int) $tokens['input'] : 0;
        $outputTokens = isset($tokens['output']) ? (int) $tokens['output'] : 0;
        $cachedTokens = isset($tokens['cached']) ? (int) $tokens['cached'] : 0;

        $cost = 0.0;
        $cost += ($inputTokens / 1000) * $inputPrice;
        $cost += ($outputTokens / 1000) * $outputPrice;
        $cost += ($cachedTokens / 1000) * $cachedPrice;

        return $cost;
    }

    private function fetchPricing(string $model): array
    {
        $url = $this->pricingUrl !== '' ? $this->pricingUrl : (string) Config::get('PRICING_URL', '');
        if ($url !== '') {
            $resp = $this->httpGet($url);
            if ($resp['status'] >= 200 && $resp['status'] < 300 && is_array($resp['json'])) {
                $parsed = $this->parsePricingJson($resp['json'], $model);
                if ($parsed !== null) {
                    $parsed['source_url'] = $url;
                    $parsed['raw'] = $resp['body'];
                    return $parsed;
                }
            }
        }

        $fallback = $this->fallbackPricing($model);
        $fallback['source_url'] = $url ?: 'env';
        $fallback['raw'] = null;

        return $fallback;
    }

    private function parsePricingJson(array $json, string $model): ?array
    {
        // Expected shape: { "gpt-5.1": { "currency": "USD", "input_per_1k": 0.010, "output_per_1k": 0.030, "cached_per_1k": 0.003 } }
        $entry = $json[$model] ?? null;
        if (!is_array($entry)) {
            return null;
        }

        $input = $this->asFloat($entry['input_per_1k'] ?? null);
        $output = $this->asFloat($entry['output_per_1k'] ?? null);
        $cached = $this->asFloat($entry['cached_per_1k'] ?? 0.0);

        if ($input === null || $output === null) {
            return null;
        }

        return [
            'model' => $model,
            'currency' => isset($entry['currency']) && is_string($entry['currency']) ? $entry['currency'] : 'USD',
            'input_price_per_1k' => $input,
            'output_price_per_1k' => $output,
            'cached_price_per_1k' => $cached,
            'fetched_at' => gmdate(DATE_ATOM),
        ];
    }

    private function fallbackPricing(string $model): array
    {
        $defaultInput = 0.00125;
        $defaultOutput = 0.01;
        $defaultCached = 0.000125;
        $input = $this->asFloat(Config::get('GPT51_INPUT_PER_1K', $defaultInput)) ?? $defaultInput;
        $output = $this->asFloat(Config::get('GPT51_OUTPUT_PER_1K', $defaultOutput)) ?? $defaultOutput;
        $cached = $this->asFloat(Config::get('GPT51_CACHED_PER_1K', $defaultCached)) ?? $defaultCached;
        $currency = is_string(Config::get('PRICING_CURRENCY', 'USD')) ? (string) Config::get('PRICING_CURRENCY', 'USD') : 'USD';

        return [
            'model' => $model,
            'currency' => $currency,
            'input_price_per_1k' => $input,
            'output_price_per_1k' => $output,
            'cached_price_per_1k' => $cached,
            'fetched_at' => gmdate(DATE_ATOM),
        ];
    }

    private function httpGet(string $url): array
    {
        $http = $this->httpClient ?? [$this, 'defaultHttpClient'];
        return $http($url);
    }

    private function defaultHttpClient(string $url): array
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => 10,
            CURLOPT_HTTPHEADER => [
                'Accept: application/json',
                'User-Agent: codex-auth',
            ],
        ]);
        $body = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error = $body === false ? curl_error($ch) : null;
        curl_close($ch);

        $decoded = null;
        if ($body !== false) {
            $decoded = json_decode($body, true);
        }

        return [
            'status' => $status ?: 0,
            'body' => $body === false ? '' : $body,
            'json' => $decoded,
            'error' => $error,
        ];
    }

    private function asFloat(mixed $value): ?float
    {
        if ($value === null || $value === '') {
            return null;
        }
        if (is_numeric($value)) {
            return (float) $value;
        }

        return null;
    }
}
