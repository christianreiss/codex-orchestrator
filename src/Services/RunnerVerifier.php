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

    public function verify(array $authPayload, ?string $baseUrl = null, ?float $timeoutSeconds = null): array
    {
        $payload = [
            'auth_json' => $authPayload,
            'base_url' => $baseUrl ?: $this->defaultBaseUrl,
        ];

        $body = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($body === false) {
            return [
                'status' => 'fail',
                'reason' => 'failed to encode payload',
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
                ],
            ]);

            $response = file_get_contents($this->runnerUrl, false, $context);
            $latencyMs = (int) ((microtime(true) - $start) * 1000);
            if ($response === false) {
                return [
                    'status' => 'fail',
                    'reason' => 'runner returned empty response',
                    'latency_ms' => $latencyMs,
                ];
            }

            $decoded = json_decode($response, true);
            if (!is_array($decoded)) {
                return [
                    'status' => 'fail',
                    'reason' => 'invalid runner response',
                    'latency_ms' => $latencyMs,
                ];
            }

            if (!isset($decoded['latency_ms'])) {
                $decoded['latency_ms'] = $latencyMs;
            }

            return $decoded;
        } catch (Throwable $exception) {
            return [
                'status' => 'fail',
                'reason' => $exception->getMessage(),
            ];
        }
    }
}
