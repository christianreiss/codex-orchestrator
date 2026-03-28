<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use Throwable;

class RunnerVerifier
{
    private readonly string $skillSummaryUrl;

    public function __construct(
        private readonly string $runnerUrl,
        string $defaultBaseUrl = '',
        private readonly float $timeoutSeconds = 8.0,
        private readonly string $sharedSecret = '',
        ?string $skillSummaryUrl = null
    ) {
        $normalizedSummaryUrl = is_string($skillSummaryUrl) ? trim($skillSummaryUrl) : '';
        $this->skillSummaryUrl = $normalizedSummaryUrl !== '' ? $normalizedSummaryUrl : $this->deriveSkillSummaryUrl($runnerUrl);
    }

    public function verify(array $authPayload, ?string $baseUrl = null, ?float $timeoutSeconds = null, ?array $host = null): array
    {
        $payload = [
            'auth_json' => $authPayload,
        ];

        $timeout = $timeoutSeconds ?? $this->timeoutSeconds;
        $payload['timeout_seconds'] = $timeout;
        return $this->sendRequest($this->runnerUrl, $payload, $timeout);
    }

    public function summarizeSkill(string $slug, string $manifest, array $authPayload, ?float $timeoutSeconds = null): array
    {
        if ($this->skillSummaryUrl === '') {
            return [
                'status' => 'fail',
                'reason' => 'skill summary endpoint is not configured',
                'reachable' => false,
            ];
        }

        $timeout = $timeoutSeconds ?? $this->timeoutSeconds;

        return $this->sendRequest($this->skillSummaryUrl, [
            'auth_json' => $authPayload,
            'slug' => $slug,
            'manifest' => $manifest,
            'timeout_seconds' => $timeout,
        ], $timeout);
    }

    private function extractStatus(array $httpResponseHeader): ?int
    {
        if (isset($httpResponseHeader[0]) && preg_match('#\s(\d{3})\s#', (string) $httpResponseHeader[0], $m)) {
            return (int) $m[1];
        }

        return null;
    }

    private function attemptRequest(string $url, string $body, float $timeout): array
    {
        $start = microtime(true);
        try {
            $headers = '';
            if (trim($this->sharedSecret) !== '') {
                $headers .= "X-Runner-Auth: " . trim($this->sharedSecret) . "\r\n";
            }
            $context = stream_context_create([
                'http' => [
                    'method' => 'POST',
                    'header' => "Content-Type: application/json\r\n" . $headers,
                    'content' => $body,
                    'timeout' => $timeout,
                    'ignore_errors' => true, // allow reading response bodies on non-200
                ],
            ]);

            $response = file_get_contents($url, false, $context);
            $latencyMs = (int) ((microtime(true) - $start) * 1000);
            $status = $this->extractStatus($http_response_header ?? []);
            if ($response === false) {
                return [
                    'status' => 'fail',
                    'reason' => $status !== null
                        ? 'runner request failed (status ' . $status . ')'
                        : 'runner request failed',
                    'latency_ms' => $latencyMs,
                    'reachable' => false,
                ];
            }

            if ($response === '') {
                return [
                    'status' => 'fail',
                    'reason' => $status !== null
                        ? 'runner returned empty response (status ' . $status . ')'
                        : 'runner returned empty response',
                    'latency_ms' => $latencyMs,
                    'reachable' => true,
                ];
            }

            $decoded = json_decode($response, true);
            if (!is_array($decoded)) {
                return [
                    'status' => 'fail',
                    'reason' => $status !== null
                        ? 'invalid runner response (status ' . $status . ')'
                        : 'invalid runner response',
                    'latency_ms' => $latencyMs,
                    'reachable' => true,
                ];
            }

            if (!isset($decoded['latency_ms'])) {
                $decoded['latency_ms'] = $latencyMs;
            }
            $decoded['reachable'] = true;

            return $decoded;
        } catch (Throwable $exception) {
            return [
                'status' => 'fail',
                'reason' => $exception->getMessage(),
                'reachable' => false,
            ];
        }
    }

    private function probeRunnerReady(string $url, float $timeout): array
    {
        $start = microtime(true);
        try {
            $context = stream_context_create([
                'http' => [
                    'method' => 'GET',
                    'timeout' => $timeout,
                    'ignore_errors' => true,
                ],
            ]);
            $response = file_get_contents($url, false, $context);
            $latencyMs = (int) ((microtime(true) - $start) * 1000);
            $status = $this->extractStatus($http_response_header ?? []);
            if ($response === false) {
                return [
                    'status' => 'fail',
                    'reason' => $status !== null
                        ? 'runner ping failed (status ' . $status . ')'
                        : 'runner ping failed',
                    'latency_ms' => $latencyMs,
                    'reachable' => false,
                ];
            }

            return [
                'status' => 'ok',
                'latency_ms' => $latencyMs,
                'reachable' => true,
            ];
        } catch (Throwable $exception) {
            return [
                'status' => 'fail',
                'reason' => $exception->getMessage(),
                'reachable' => false,
            ];
        }
    }

    private function sendRequest(string $url, array $payload, float $timeout): array
    {
        $body = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($body === false) {
            return [
                'status' => 'fail',
                'reason' => 'failed to encode payload',
                'reachable' => false,
            ];
        }

        $pingTimeout = max(1.0, min(3.0, $timeout / 4));
        $ready = $this->probeRunnerReady($url, $pingTimeout);
        if (($ready['reachable'] ?? false) === false) {
            usleep(500000);
            $ready = $this->probeRunnerReady($url, $pingTimeout);
        }
        if (($ready['reachable'] ?? true) === false) {
            return $ready;
        }

        $result = $this->attemptRequest($url, $body, $timeout);
        if (($result['reachable'] ?? true) === false && $timeout > 2.0) {
            usleep(300000);
            $retry = $this->attemptRequest($url, $body, min($timeout, 5.0));
            if (($retry['status'] ?? '') !== 'fail' || ($retry['reachable'] ?? true)) {
                return $retry;
            }
            if (!isset($retry['reason']) && isset($result['reason'])) {
                $retry['reason'] = $result['reason'];
            }
            return $retry;
        }

        return $result;
    }

    private function deriveSkillSummaryUrl(string $runnerUrl): string
    {
        $normalized = trim($runnerUrl);
        if ($normalized === '') {
            return '';
        }

        $parts = parse_url($normalized);
        if (!is_array($parts)) {
            return '';
        }

        $path = isset($parts['path']) ? (string) $parts['path'] : '';
        if ($path === '' || $path === '/') {
            $parts['path'] = '/skills/summarize';
        } elseif (preg_match('#/verify/?$#', $path) === 1) {
            $parts['path'] = preg_replace('#/verify/?$#', '/skills/summarize', $path) ?? '/skills/summarize';
        } else {
            $parts['path'] = rtrim($path, '/') . '/skills/summarize';
        }

        return $this->buildUrl($parts);
    }

    /**
     * @param array<string, mixed> $parts
     */
    private function buildUrl(array $parts): string
    {
        $scheme = isset($parts['scheme']) ? $parts['scheme'] . '://' : '';
        $user = isset($parts['user']) ? (string) $parts['user'] : '';
        $pass = isset($parts['pass']) ? ':' . (string) $parts['pass'] : '';
        $auth = $user !== '' ? $user . $pass . '@' : '';
        $host = (string) ($parts['host'] ?? '');
        $port = isset($parts['port']) ? ':' . (int) $parts['port'] : '';
        $path = (string) ($parts['path'] ?? '');
        $query = isset($parts['query']) ? '?' . (string) $parts['query'] : '';
        $fragment = isset($parts['fragment']) ? '#' . (string) $parts['fragment'] : '';

        return $scheme . $auth . $host . $port . $path . $query . $fragment;
    }
}
