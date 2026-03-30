<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Repositories\AuthPayloadRepository;
use App\Repositories\LogRepository;

class MemorySummaryService
{
    public function __construct(
        private readonly AuthPayloadRepository $payloads,
        private readonly LogRepository $logs,
        private readonly ?RunnerVerifier $runner = null
    ) {
    }

    public function summarize(string $memoryKey, string $content, ?array $host = null): ?string
    {
        if ($this->runner === null) {
            $this->logs->log($this->hostId($host), 'memory.summary', [
                'key' => $memoryKey,
                'status' => 'skipped',
                'reason' => 'runner unavailable',
            ]);

            return null;
        }

        $authPayload = $this->canonicalAuthPayload();
        if ($authPayload === null) {
            $this->logs->log($this->hostId($host), 'memory.summary', [
                'key' => $memoryKey,
                'status' => 'skipped',
                'reason' => 'canonical auth missing',
            ]);

            return null;
        }

        $result = $this->runner->summarizeMemory($memoryKey, $content, $authPayload);
        $summary = $this->normalizeSummary($result['summary'] ?? null);
        $status = strtolower(trim((string) ($result['status'] ?? '')));

        if ($status === 'ok' && $summary !== null) {
            $this->logs->log($this->hostId($host), 'memory.summary', [
                'key' => $memoryKey,
                'status' => 'generated',
                'latency_ms' => $result['latency_ms'] ?? null,
            ]);

            return $summary;
        }

        $this->logs->log($this->hostId($host), 'memory.summary', [
            'key' => $memoryKey,
            'status' => 'failed',
            'reason' => $result['reason'] ?? 'summary unavailable',
            'latency_ms' => $result['latency_ms'] ?? null,
            'reachable' => $result['reachable'] ?? null,
        ]);

        return null;
    }

    private function canonicalAuthPayload(): ?array
    {
        $payload = $this->payloads->latest();
        if (!is_array($payload)) {
            return null;
        }

        if (isset($payload['body']) && is_string($payload['body']) && trim($payload['body']) !== '') {
            $decoded = json_decode($payload['body'], true);
            if (is_array($decoded)) {
                return $decoded;
            }
        }

        $lastRefresh = isset($payload['last_refresh']) ? trim((string) $payload['last_refresh']) : '';
        $entries = is_array($payload['entries'] ?? null) ? $payload['entries'] : [];
        if ($lastRefresh === '' || $entries === []) {
            return null;
        }

        $auths = [];
        foreach ($entries as $entry) {
            if (!is_array($entry)) {
                continue;
            }

            $target = trim((string) ($entry['target'] ?? ''));
            $token = trim((string) ($entry['token'] ?? ''));
            if ($target === '' || $token === '') {
                continue;
            }

            $item = [
                'token' => $token,
                'token_type' => trim((string) ($entry['token_type'] ?? 'bearer')) ?: 'bearer',
            ];

            foreach (['organization', 'project', 'api_base'] as $key) {
                if (isset($entry[$key]) && is_string($entry[$key]) && trim($entry[$key]) !== '') {
                    $item[$key] = trim((string) $entry[$key]);
                }
            }

            if (is_array($entry['meta'] ?? null)) {
                foreach ($entry['meta'] as $key => $value) {
                    if ((is_scalar($value) || $value === null) && !array_key_exists((string) $key, $item)) {
                        $item[(string) $key] = $value;
                    }
                }
            }

            ksort($item);
            $auths[$target] = $item;
        }

        if ($auths === []) {
            return null;
        }

        ksort($auths);

        return [
            'last_refresh' => $lastRefresh,
            'auths' => $auths,
        ];
    }

    private function normalizeSummary(mixed $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }

        $normalized = trim(preg_replace('/\s+/', ' ', $value) ?? '');
        if ($normalized === '') {
            return null;
        }

        return $normalized;
    }

    private function hostId(?array $host): ?int
    {
        if (!is_array($host) || !isset($host['id']) || !is_numeric($host['id'])) {
            return null;
        }

        return (int) $host['id'];
    }
}
