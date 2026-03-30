<?php

declare(strict_types=1);

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

class StartupSyncService
{
    public function __construct(
        private readonly AgentsService $agents,
        private readonly ClientConfigService $configs
    ) {
    }

    public function collect(array $payload, array $host, string $baseUrl, string $apiKey, bool $includeContent = false): array
    {
        $agents = $this->collectAgents($payload['agents'] ?? null, $host, $includeContent);
        $config = $this->collectConfig($payload, $host, $baseUrl, $apiKey, $includeContent);

        $reasons = [];
        if (!empty($agents['changed'])) {
            $reasons[] = 'agents_changed';
        }
        if (!empty($config['changed'])) {
            $reasons[] = 'config_changed';
        }

        return [
            'status' => $reasons === [] ? 'ok' : 'update',
            'reasons' => $reasons,
            'agents' => $agents,
            'config' => $config,
        ];
    }

    private function collectAgents(mixed $payload, ?array $host, bool $includeContent): array
    {
        $payloadData = is_array($payload) ? $payload : [];
        $sha = $this->normalizeSha($payloadData['sha256'] ?? null);
        $result = $this->agents->retrieve($sha, $host);
        if (!$includeContent) {
            unset($result['content']);
        }

        $status = strtolower(trim((string) ($result['status'] ?? '')));
        $changed = $status === 'updated' || ($status === 'missing' && $sha !== null);

        return [
            'status' => $result['status'] ?? 'missing',
            'changed' => $changed,
            'sha256' => $result['sha256'] ?? null,
            'base_sha256' => $result['base_sha256'] ?? null,
            'managed_sha256' => $result['managed_sha256'] ?? null,
            'sections' => $result['sections'] ?? null,
            'updated_at' => $result['updated_at'] ?? null,
            'size_bytes' => $result['size_bytes'] ?? null,
            'content' => $includeContent ? ($result['content'] ?? null) : null,
        ];
    }

    private function collectConfig(array $payload, ?array $host, string $baseUrl, string $apiKey, bool $includeContent): array
    {
        $configPayload = [];
        if (isset($payload['config']) && is_array($payload['config'])) {
            $configPayload = $payload['config'];
        }

        $sha = $this->normalizeSha($configPayload['sha256'] ?? ($payload['config_sha256'] ?? null));
        $username = $this->normalizeString($configPayload['username'] ?? ($payload['username'] ?? null));
        $home = $this->normalizeString($configPayload['home'] ?? ($payload['home'] ?? null));

        $result = $this->configs->retrieve($sha, $host, $baseUrl, $apiKey, $username, $home);
        if (!$includeContent) {
            unset($result['content']);
        }

        $status = strtolower(trim((string) ($result['status'] ?? '')));
        $changed = $status === 'updated' || ($status === 'missing' && $sha !== null);

        return [
            'status' => $result['status'] ?? 'missing',
            'changed' => $changed,
            'sha256' => $result['sha256'] ?? null,
            'base_sha256' => $result['base_sha256'] ?? null,
            'updated_at' => $result['updated_at'] ?? null,
            'size_bytes' => $result['size_bytes'] ?? null,
            'content' => $includeContent ? ($result['content'] ?? null) : null,
        ];
    }
    private function normalizeSha(mixed $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }

        $normalized = strtolower(trim($value));
        if ($normalized === '') {
            return null;
        }

        if (!preg_match('/^[a-f0-9]{64}$/', $normalized)) {
            return null;
        }

        return $normalized;
    }

    private function normalizeString(mixed $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }

        $normalized = trim($value);
        return $normalized === '' ? null : $normalized;
    }

}
