<?php

declare(strict_types=1);

namespace App\Services;

use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Repositories\AuthPayloadRepository;
use App\Repositories\LogRepository;

class SkillDraftService
{
    public function __construct(
        private readonly AuthPayloadRepository $payloads,
        private readonly LogRepository $logs,
        private readonly SkillManifestService $manifestService,
        private readonly ?RunnerVerifier $runner = null,
        private readonly ?RunnerValidationService $runnerValidationService = null
    ) {
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function generate(array $payload, ?array $host = null): array
    {
        $prompt = trim((string) ($payload['prompt'] ?? ''));
        $slugHint = trim((string) ($payload['slug_hint'] ?? ''));

        if ($prompt === '') {
            throw new ValidationException(['prompt' => ['prompt is required']]);
        }

        if ($this->runner === null) {
            $this->logs->log($this->hostId($host), 'skill.generate', [
                'status' => 'skipped',
                'reason' => 'runner unavailable',
            ]);

            throw new HttpException('Auth runner unavailable', 503);
        }

        $authPayload = $this->canonicalAuthPayload();
        if ($authPayload === null) {
            $this->logs->log($this->hostId($host), 'skill.generate', [
                'status' => 'skipped',
                'reason' => 'canonical auth missing',
            ]);

            throw new HttpException('Canonical auth missing', 503);
        }

        $result = $this->runner->generateSkillDraft($prompt, $authPayload, $slugHint !== '' ? $slugHint : null);
        $status = strtolower(trim((string) ($result['status'] ?? '')));

        if ($status !== 'ok') {
            $this->logs->log($this->hostId($host), 'skill.generate', [
                'status' => 'failed',
                'reason' => $result['reason'] ?? 'generation failed',
                'latency_ms' => $result['latency_ms'] ?? null,
                'reachable' => $result['reachable'] ?? null,
            ]);

            throw new HttpException('Skill generation failed: ' . ($result['reason'] ?? 'runner returned non-ok status'), 502);
        }

        try {
            $draft = $this->manifestService->normalizeDraft($result);
        } catch (ValidationException $exception) {
            $this->logs->log($this->hostId($host), 'skill.generate', [
                'status' => 'failed',
                'reason' => 'invalid runner draft payload',
                'latency_ms' => $result['latency_ms'] ?? null,
            ]);

            throw new HttpException('Skill generation failed: invalid runner draft payload', 502);
        }

        $manifest = $this->manifestService->buildManifest($draft);
        $response = $draft;
        $response['manifest'] = $manifest;
        $response['latency_ms'] = $result['latency_ms'] ?? null;
        $response['codex_version'] = $result['codex_version'] ?? null;

        $this->logs->log($this->hostId($host), 'skill.generate', [
            'status' => 'generated',
            'slug' => $draft['slug'],
            'latency_ms' => $result['latency_ms'] ?? null,
        ]);

        return $response;
    }

    private function canonicalAuthPayload(): ?array
    {
        if ($this->runnerValidationService !== null) {
            return $this->runnerValidationService->canonicalAuthSnapshot();
        }

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

    private function hostId(?array $host): ?int
    {
        if (!is_array($host) || !isset($host['id']) || !is_numeric($host['id'])) {
            return null;
        }

        return (int) $host['id'];
    }
}
