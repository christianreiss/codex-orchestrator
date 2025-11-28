<?php

namespace App\Services;

use Throwable;

class RunnerVerifier
{
    public function __construct(
        private readonly string $runnerUrl,
        private readonly string $defaultBaseUrl,
        private readonly float $timeoutSeconds = 8.0
    ) {
    }

    public function verify(array $authPayload, ?string $baseUrl = null, ?float $timeoutSeconds = null, ?array $host = null): array
    {
        $payload = [
            'auth_json' => $authPayload,
            'base_url' => $baseUrl ?: $this->defaultBaseUrl,
        ];
        if ($host !== null) {
            if (isset($host['api_key']) && is_string($host['api_key'])) {
                $payload['api_key'] = $host['api_key'];
            }
            if (isset($host['fqdn']) && is_string($host['fqdn'])) {
                $payload['fqdn'] = $host['fqdn'];
            }
        }

        $body = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($body === false) {
            return [
                'status' => 'fail',
                'reason' => 'failed to encode payload',
                'reachable' => false,
            ];
        }

        $timeout = $timeoutSeconds ?? $this->timeoutSeconds;
        $start = microtime(true);
        try {
            $context = stream_context_create([
                'http' => [
                    'method' => 'POST',
                    'header' => "Content-Type: application/json\r\n",
                    'content' => $body,
                    'timeout' => $timeout,
                    'ignore_errors' => true, // allow reading response bodies on non-200
                ],
            ]);

            $response = file_get_contents($this->runnerUrl, false, $context);
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

    private function extractStatus(array $httpResponseHeader): ?int
    {
        if (isset($httpResponseHeader[0]) && preg_match('#\s(\d{3})\s#', (string) $httpResponseHeader[0], $m)) {
            return (int) $m[1];
        }

        return null;
    }
}
