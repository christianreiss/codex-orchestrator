<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christianreiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Exceptions\ValidationException;
use App\Repositories\AgentsRepository;
use App\Repositories\LogRepository;

class AgentsService
{
    public function __construct(
        private readonly AgentsRepository $agents,
        private readonly LogRepository $logs
    ) {
    }

    public function retrieve(?string $sha256, ?array $host = null): array
    {
        $this->assertSha($sha256, true);
        $row = $this->resolveServedDocument($host);
        $hostId = $this->hostId($host);

        if ($row === null) {
            $this->logs->log($hostId, 'agents.retrieve', ['status' => 'missing']);

            return [
                'status' => 'missing',
            ];
        }

        $canonicalSha = $row['sha256'] ?? hash('sha256', (string) ($row['body'] ?? ''));
        $status = ($sha256 !== null && hash_equals($canonicalSha, $sha256)) ? 'unchanged' : 'updated';

        $result = [
            'status' => $status,
            'version_id' => isset($row['id']) ? (int) $row['id'] : null,
            'sha256' => $canonicalSha,
            'updated_at' => $row['updated_at'] ?? null,
            'size_bytes' => strlen((string) ($row['body'] ?? '')),
        ];

        if ($status !== 'unchanged') {
            $result['content'] = (string) ($row['body'] ?? '');
        }

        $this->logs->log($hostId, 'agents.retrieve', ['status' => $status]);

        return $result;
    }

    public function ensureSeededFromFile(string $path): array
    {
        $seedPath = trim($path);
        if ($seedPath === '' || !is_file($seedPath) || !is_readable($seedPath)) {
            return [
                'status' => 'missing',
            ];
        }

        $body = file_get_contents($seedPath);
        if ($body === false) {
            return [
                'status' => 'missing',
            ];
        }

        $sha = hash('sha256', $body);
        $existing = $this->agents->latest();
        $existingSha = $existing['sha256'] ?? hash('sha256', (string) ($existing['body'] ?? ''));
        $status = $existing === null ? 'created' : (hash_equals((string) $existingSha, $sha) ? 'unchanged' : 'updated');

        if ($status !== 'unchanged') {
            $this->agents->createVersion($body, null, $sha);
        }

        $this->logs->log(null, 'agents.seed', [
            'status' => $status,
            'sha256' => $sha,
            'path' => $seedPath,
        ]);

        return [
            'status' => $status,
            'sha256' => $sha,
        ];
    }

    public function adminFetch(): array
    {
        $state = $this->agents->state();
        $latest = $this->agents->latest();
        $served = $this->resolveServedDocument();
        $versions = $this->agents->listVersions(50);

        $latestId = $latest['id'] ?? null;
        $activeId = $state['active_document_id'] ?? null;
        $servedId = $served['id'] ?? null;

        $versionPayloads = [];
        foreach ($versions as $version) {
            $id = isset($version['id']) ? (int) $version['id'] : null;
            $versionPayloads[] = [
                'id' => $id,
                'sha256' => $version['sha256'] ?? hash('sha256', (string) ($version['body'] ?? '')),
                'updated_at' => $version['updated_at'] ?? null,
                'created_at' => $version['created_at'] ?? null,
                'size_bytes' => strlen((string) ($version['body'] ?? '')),
                'is_latest' => $latestId !== null && $id === (int) $latestId,
                'is_active' => $activeId !== null && $id === (int) $activeId,
                'is_served' => $servedId !== null && $id === (int) $servedId,
            ];
        }

        if ($served === null) {
            return [
                'status' => 'missing',
                'mode' => $state['mode'] ?? AgentsRepository::MODE_LATEST,
                'active_id' => $activeId !== null ? (int) $activeId : null,
                'served_id' => $servedId !== null ? (int) $servedId : null,
                'latest_id' => $latestId !== null ? (int) $latestId : null,
                'versions' => $versionPayloads,
            ];
        }

        return [
            'status' => 'ok',
            'mode' => $state['mode'] ?? AgentsRepository::MODE_LATEST,
            'active_id' => $activeId !== null ? (int) $activeId : null,
            'served_id' => $servedId !== null ? (int) $servedId : null,
            'latest_id' => $latestId !== null ? (int) $latestId : null,
            'sha256' => $served['sha256'] ?? hash('sha256', (string) ($served['body'] ?? '')),
            'updated_at' => $served['updated_at'] ?? null,
            'size_bytes' => strlen((string) ($served['body'] ?? '')),
            'content' => (string) ($served['body'] ?? ''),
            'versions' => $versionPayloads,
        ];
    }

    public function store(string $content, ?string $providedSha = null, ?array $host = null): array
    {
        $body = (string) $content;
        $errors = [];
        $this->assertSha($providedSha, true, $errors);
        $computedSha = hash('sha256', $body);

        if ($providedSha !== null && !hash_equals($computedSha, $providedSha)) {
            $errors['sha256'][] = 'sha256 does not match AGENTS.md contents';
        }

        if ($errors) {
            throw new ValidationException($errors);
        }

        $existing = $this->agents->latest();
        $existingSha = $existing['sha256'] ?? null;
        $status = $existing === null ? 'created' : (hash_equals((string) $existingSha, $computedSha) ? 'unchanged' : 'updated');

        $saved = $status === 'unchanged' ? $existing : $this->agents->createVersion($body, $this->hostId($host), $computedSha);

        $this->logs->log($this->hostId($host), 'agents.store', ['status' => $status]);

        return [
            'status' => $status,
            'version_id' => $saved['id'] ?? ($existing['id'] ?? null),
            'sha256' => $saved['sha256'] ?? $computedSha,
            'updated_at' => $saved['updated_at'] ?? gmdate(DATE_ATOM),
            'size_bytes' => strlen((string) ($saved['body'] ?? $body)),
        ];
    }

    public function setServeMode(string $mode, ?int $versionId = null): array
    {
        $normalized = strtolower(trim($mode));
        if (!in_array($normalized, [AgentsRepository::MODE_LATEST, AgentsRepository::MODE_LOCKED], true)) {
            throw new ValidationException(['mode' => ['mode must be latest or locked']]);
        }

        $this->agents->state();

        if ($normalized === AgentsRepository::MODE_LATEST) {
            $this->agents->updateState(AgentsRepository::MODE_LATEST, null);
            return $this->adminFetch();
        }

        if ($versionId === null || $versionId <= 0) {
            throw new ValidationException(['version_id' => ['version_id is required to lock']]);
        }

        $target = $this->agents->findById($versionId);
        if ($target === null) {
            throw new ValidationException(['version_id' => ['version_id not found']]);
        }

        $this->agents->updateState(AgentsRepository::MODE_LOCKED, $versionId);

        return $this->adminFetch();
    }

    public function deleteVersion(int $versionId): array
    {
        if ($versionId <= 0) {
            throw new ValidationException(['version_id' => ['version_id is required']]);
        }

        $served = $this->resolveServedDocument();
        if ($served !== null && isset($served['id']) && (int) $served['id'] === $versionId) {
            throw new ValidationException(['version_id' => ['cannot delete the served version']]);
        }

        $deleted = $this->agents->deleteVersion($versionId);
        if (!$deleted) {
            throw new ValidationException(['version_id' => ['version_id not found']]);
        }

        $this->logs->log(null, 'agents.delete', ['status' => 'deleted', 'version_id' => $versionId]);

        return $this->adminFetch();
    }

    private function hostId(?array $host): ?int
    {
        $hostId = $host['id'] ?? null;
        return is_numeric($hostId) ? (int) $hostId : null;
    }

    private function assertSha(?string $sha, bool $allowNull = false, array &$errors = []): void
    {
        if ($sha === null) {
            if ($allowNull) {
                return;
            }
            $errors['sha256'][] = 'sha256 is required';
            if ($errors) {
                throw new ValidationException($errors);
            }
            return;
        }

        $value = trim($sha);
        if ($value !== '' && !preg_match('/^[A-Fa-f0-9]{64}$/', $value)) {
            $errors['sha256'][] = 'sha256 must be 64 hex characters';
        }

        if ($errors) {
            throw new ValidationException($errors);
        }
    }

    private function resolveServedDocument(?array $host = null): ?array
    {
        $hostOverrideRaw = $host['agents_document_id_override'] ?? null;
        if (is_numeric($hostOverrideRaw)) {
            $hostOverride = (int) $hostOverrideRaw;
            if ($hostOverride > 0) {
                $override = $this->agents->findById($hostOverride);
                if ($override !== null) {
                    return $override;
                }

                $this->logs->log($this->hostId($host), 'agents.host_override_missing', [
                    'status' => 'fallback_latest',
                    'override_id' => $hostOverride,
                ]);
            }
        }

        $state = $this->agents->state();
        $mode = $state['mode'] ?? AgentsRepository::MODE_LATEST;
        $activeId = $state['active_document_id'] ?? null;

        if ($mode === AgentsRepository::MODE_LOCKED && $activeId !== null) {
            $active = $this->agents->findById((int) $activeId);
            if ($active !== null) {
                return $active;
            }

            $this->agents->updateState(AgentsRepository::MODE_LATEST, null);
            $this->logs->log($this->hostId($host), 'agents.active_missing', [
                'status' => 'fallback_latest',
                'active_id' => $activeId,
            ]);
        }

        return $this->agents->latest();
    }
}
