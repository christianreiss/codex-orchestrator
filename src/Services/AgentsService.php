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
use App\Repositories\VersionRepository;
use App\Services\Traits\HostServiceTrait;
use App\Support\Engine;

class AgentsService
{
    use HostServiceTrait;
    public const BACKUP_LIMIT_VERSION_KEY = 'agents_backup_limit';
    private const MAX_BACKUP_LIMIT = 200;

    public function __construct(
        private readonly AgentsRepository $agents,
        private readonly LogRepository $logs,
        private readonly ?SkillService $skills = null,
        private readonly ?ClientConfigService $clientConfigService = null,
        private readonly ?MemoryService $memoryService = null,
        private readonly ?VersionRepository $versions = null
    ) {
    }

    public function retrieve(?string $sha256, ?array $host = null, string $engine = Engine::CODEX): array
    {
        $this->assertSha($sha256, true);
        $row = $this->resolveServedDocument($host, $engine);
        $hostId = $this->hostId($host);

        if ($row === null) {
            $this->logs->log($hostId, 'agents.retrieve', ['status' => 'missing']);

            return [
                'status' => 'missing',
            ];
        }

        $served = $this->buildServedDocument($row, $host, $engine);
        $canonicalSha = $served['sha256'] ?? hash('sha256', (string) ($served['body'] ?? ''));
        $status = ($sha256 !== null && hash_equals($canonicalSha, $sha256)) ? 'unchanged' : 'updated';

        $result = [
            'status' => $status,
            'version_id' => isset($row['id']) ? (int) $row['id'] : null,
            'sha256' => $canonicalSha,
            'base_sha256' => $served['base_sha256'] ?? ($row['sha256'] ?? hash('sha256', (string) ($row['body'] ?? ''))),
            'managed_sha256' => $served['managed_sha256'] ?? null,
            'sections' => is_array($served['sections'] ?? null) ? $served['sections'] : [],
            'updated_at' => $served['updated_at'] ?? null,
            'size_bytes' => strlen((string) ($served['body'] ?? '')),
        ];

        if ($status !== 'unchanged') {
            $result['content'] = (string) ($served['body'] ?? '');
        }

        $this->logs->log($hostId, 'agents.retrieve', ['status' => $status]);

        return $result;
    }

    public function ensureSeededFromFile(string $path): array
    {
        $latest = $this->agents->latest();
        if ($latest !== null) {
            return [
                'status' => 'skipped',
                'reason' => 'canonical_document_exists',
                'version_id' => isset($latest['id']) ? (int) $latest['id'] : null,
                'sha256' => $latest['sha256'] ?? hash('sha256', (string) ($latest['body'] ?? '')),
                'pruned_count' => 0,
            ];
        }

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
        $stored = $this->agents->storeVersionIfChangedWithRetention($body, null, $sha, $this->backupLimit());
        $status = (string) ($stored['status'] ?? 'missing');
        $prunedIds = $this->normalizePrunedIds($stored['pruned_ids'] ?? []);

        if ($prunedIds !== []) {
            $this->logPrunedVersions('seed', $prunedIds);
        }

        $this->logs->log(null, 'agents.seed', [
            'status' => $status,
            'sha256' => $sha,
            'path' => $seedPath,
            'pruned_count' => count($prunedIds),
        ]);

        return [
            'status' => $status,
            'sha256' => $sha,
            'pruned_count' => count($prunedIds),
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
                'backup_limit' => $this->backupLimit(),
                'versions' => $versionPayloads,
            ];
        }

        return [
            'status' => 'ok',
            'mode' => $state['mode'] ?? AgentsRepository::MODE_LATEST,
            'active_id' => $activeId !== null ? (int) $activeId : null,
            'served_id' => $servedId !== null ? (int) $servedId : null,
            'latest_id' => $latestId !== null ? (int) $latestId : null,
            'backup_limit' => $this->backupLimit(),
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

        $stored = $this->agents->storeVersionIfChangedWithRetention($body, $this->hostId($host), $computedSha, $this->backupLimit());
        $status = (string) ($stored['status'] ?? 'created');
        $saved = is_array($stored['row'] ?? null) ? $stored['row'] : [];
        $prunedIds = $this->normalizePrunedIds($stored['pruned_ids'] ?? []);

        if ($prunedIds !== []) {
            $this->logPrunedVersions('store', $prunedIds);
        }

        $this->logs->log($this->hostId($host), 'agents.store', [
            'status' => $status,
            'pruned_count' => count($prunedIds),
        ]);

        return [
            'status' => $status,
            'version_id' => $saved['id'] ?? null,
            'sha256' => $saved['sha256'] ?? $computedSha,
            'updated_at' => $saved['updated_at'] ?? gmdate(DATE_ATOM),
            'size_bytes' => strlen((string) ($saved['body'] ?? $body)),
            'pruned_count' => count($prunedIds),
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
            $prunedCount = $this->pruneBackupsIfNeeded('serve_mode');
            $result = $this->adminFetch();
            if ($prunedCount > 0) {
                $result['pruned_count'] = $prunedCount;
            }

            return $result;
        }

        if ($versionId === null || $versionId <= 0) {
            throw new ValidationException(['version_id' => ['version_id is required to lock']]);
        }

        $target = $this->agents->findById($versionId);
        if ($target === null) {
            throw new ValidationException(['version_id' => ['version_id not found']]);
        }

        $this->agents->updateState(AgentsRepository::MODE_LOCKED, $versionId);

        $prunedCount = $this->pruneBackupsIfNeeded('serve_mode');
        $result = $this->adminFetch();
        if ($prunedCount > 0) {
            $result['pruned_count'] = $prunedCount;
        }

        return $result;
    }

    public function adminFetchVersion(int $versionId): array
    {
        if ($versionId <= 0) {
            throw new ValidationException(['version_id' => ['version_id is required']]);
        }

        $row = $this->agents->findById($versionId);
        if ($row === null) {
            throw new ValidationException(['version_id' => ['version_id not found']]);
        }

        $state = $this->agents->state();
        $latest = $this->agents->latest();
        $served = $this->resolveServedDocument();

        return [
            'id' => (int) $row['id'],
            'sha256' => $row['sha256'] ?? hash('sha256', (string) ($row['body'] ?? '')),
            'updated_at' => $row['updated_at'] ?? null,
            'created_at' => $row['created_at'] ?? null,
            'size_bytes' => strlen((string) ($row['body'] ?? '')),
            'content' => (string) ($row['body'] ?? ''),
            'is_latest' => isset($latest['id']) && (int) $latest['id'] === (int) $row['id'],
            'is_active' => isset($state['active_document_id']) && (int) $state['active_document_id'] === (int) $row['id'],
            'is_served' => isset($served['id']) && (int) $served['id'] === (int) $row['id'],
        ];
    }

    public function revertVersion(int $versionId): array
    {
        if ($versionId <= 0) {
            throw new ValidationException(['version_id' => ['version_id is required']]);
        }

        $source = $this->agents->findById($versionId);
        if ($source === null) {
            throw new ValidationException(['version_id' => ['version_id not found']]);
        }

        $body = (string) ($source['body'] ?? '');
        $sha = $source['sha256'] ?? hash('sha256', $body);
        $created = $this->agents->createVersionWithRetention($body, null, $sha, $this->backupLimit());
        $this->agents->updateState(AgentsRepository::MODE_LATEST, null);
        $createdRow = is_array($created['row'] ?? null) ? $created['row'] : [];
        $prunedIds = $this->normalizePrunedIds($created['pruned_ids'] ?? []);

        if ($prunedIds !== []) {
            $this->logPrunedVersions('revert', $prunedIds);
        }

        $this->logs->log(null, 'agents.revert', [
            'status' => 'reverted',
            'source_version_id' => $versionId,
            'new_version_id' => isset($createdRow['id']) ? (int) $createdRow['id'] : null,
            'pruned_count' => count($prunedIds),
        ]);

        $result = $this->adminFetch();
        if ($prunedIds !== []) {
            $result['pruned_count'] = count($prunedIds);
        }

        return $result;
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

    public function updateBackupRetention(mixed $rawLimit): array
    {
        $limit = $this->normalizeBackupLimitInput($rawLimit);

        if ($this->versions === null) {
            throw new ValidationException(['backup_limit' => ['backup retention is unavailable']]);
        }

        if ($limit === null) {
            $this->versions->delete(self::BACKUP_LIMIT_VERSION_KEY);
        } else {
            $this->versions->set(self::BACKUP_LIMIT_VERSION_KEY, (string) $limit);
        }

        $prunedCount = $this->pruneBackupsIfNeeded('settings');
        $this->logs->log(null, 'admin.agents_backup_retention', [
            'backup_limit' => $limit,
            'pruned_count' => $prunedCount,
        ]);

        return [
            'backup_limit' => $limit,
            'pruned_count' => $prunedCount,
        ];
    }

    public function pruneBackupsIfNeeded(string $reason): int
    {
        $limit = $this->backupLimit();
        if ($limit === null || $limit <= 0) {
            return 0;
        }

        $prunedIds = $this->normalizePrunedIds($this->agents->pruneHistoricalVersions($limit));
        if ($prunedIds !== []) {
            $this->logPrunedVersions($reason, $prunedIds, $limit);
        }

        return count($prunedIds);
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

    private function resolveServedDocument(?array $host = null, string $engine = Engine::CODEX): ?array
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

        // Try engine-specific document first, then fall back to default.
        $state = $this->agents->state($engine);
        $mode = $state['mode'] ?? AgentsRepository::MODE_LATEST;
        $activeId = $state['active_document_id'] ?? null;

        if ($mode === AgentsRepository::MODE_LOCKED && $activeId !== null) {
            $active = $this->agents->findById((int) $activeId);
            if ($active !== null) {
                return $active;
            }

            $this->agents->updateState(AgentsRepository::MODE_LATEST, null, $engine);
            $this->logs->log($this->hostId($host), 'agents.active_missing', [
                'status' => 'fallback_latest',
                'active_id' => $activeId,
                'engine' => $engine,
            ]);
        }

        // Try engine-specific latest first.
        $latest = $this->agents->latestByEngine($engine);
        if ($latest !== null) {
            return $latest;
        }

        // Fall back to the default (codex) agents document if this is Claude
        // and no Claude-specific document exists yet.
        if ($engine !== Engine::CODEX) {
            return $this->agents->latest();
        }

        return $this->agents->latest();
    }

    private function buildServedDocument(array $row, ?array $host = null, string $engine = Engine::CODEX): array
    {
        $body = (string) ($row['body'] ?? '');
        $baseSha = $row['sha256'] ?? hash('sha256', $body);
        $skillsSection = $this->skillsSection($engine);
        $memoriesSection = $this->memoriesSection($host, $engine);
        $skillsBlock = ($skillsSection['present'] ?? false) ? (string) ($skillsSection['body'] ?? '') : null;
        $memoriesBlock = ($memoriesSection['present'] ?? false) ? (string) ($memoriesSection['body'] ?? '') : null;
        $sections = [
            'skills' => $this->publicSectionMetadata($skillsSection),
            'memories' => $this->publicSectionMetadata($memoriesSection),
        ];

        if ($skillsBlock === null && $memoriesBlock === null) {
            return [
                'body' => $body,
                'sha256' => $baseSha,
                'base_sha256' => $baseSha,
                'managed_sha256' => null,
                'sections' => $sections,
                'updated_at' => $row['updated_at'] ?? null,
            ];
        }

        $rendered = rtrim($body);
        if ($rendered !== '') {
            $rendered .= "\n\n";
        }
        if ($skillsBlock !== null) {
            $rendered .= $skillsBlock . "\n";
        }
        if ($memoriesBlock !== null) {
            if ($skillsBlock !== null) {
                $rendered .= "\n";
            }
            $rendered .= $memoriesBlock . "\n";
        }

        return [
            'body' => $rendered,
            'sha256' => hash('sha256', $rendered),
            'base_sha256' => $baseSha,
            'managed_sha256' => $this->managedSha($skillsBlock, $memoriesBlock),
            'sections' => $sections,
            'updated_at' => $row['updated_at'] ?? null,
        ];
    }

    private function skillsSection(string $engine = Engine::CODEX): array
    {
        if ($this->skills === null || $this->clientConfigService === null) {
            return [
                'present' => false,
                'count' => 0,
                'sha256' => null,
                'reason' => 'service_unavailable',
            ];
        }

        $config = $this->clientConfigService->adminFetch();
        if (($config['status'] ?? 'missing') !== 'ok') {
            return [
                'present' => false,
                'count' => 0,
                'sha256' => null,
                'reason' => 'config_missing',
            ];
        }

        $settings = is_array($config['settings'] ?? null) ? $config['settings'] : [];
        if (($settings['orchestrator_mcp_enabled'] ?? true) === false) {
            return [
                'present' => false,
                'count' => 0,
                'sha256' => null,
                'reason' => 'mcp_disabled',
            ];
        }

        $skills = array_values(array_filter(
            $this->skills->listForAgents(),
            static fn (array $skill): bool => trim((string) ($skill['slug'] ?? '')) !== ''
        ));
        if ($skills === []) {
            return [
                'present' => false,
                'count' => 0,
                'sha256' => null,
                'reason' => 'no_skills',
            ];
        }

        $prefix = $this->markerPrefix($engine);

        $lines = [
            sprintf('<!-- %s:skills:start -->', $prefix),
            '## Skills',
            sprintf('The following skills are available through the managed `%s` MCP server. Read details with `skill://{slug}` resources.', $prefix),
            '',
        ];

        foreach ($skills as $skill) {
            $slug = trim((string) ($skill['slug'] ?? ''));
            if ($slug === '') {
                continue;
            }

            $description = $this->normalizeSkillDescription($skill['description'] ?? null, $slug);
            $lines[] = sprintf('- `%s` - %s', $slug, $description);
        }

        $lines[] = sprintf('<!-- %s:skills:end -->', $prefix);

        $body = implode("\n", $lines);

        return [
            'present' => true,
            'count' => count($skills),
            'sha256' => hash('sha256', $body),
            'reason' => 'ok',
            'body' => $body,
        ];
    }

    private function normalizeSkillDescription(mixed $description, string $slug): string
    {
        if (is_string($description)) {
            $normalized = trim(preg_replace('/\s+/', ' ', $description) ?? '');
            if ($normalized !== '') {
                return $normalized;
            }
        }

        return sprintf('Skill available via MCP; open `skill://%s` for details.', $slug);
    }

    private function memoriesSection(?array $host, string $engine = Engine::CODEX): array
    {
        if ($this->memoryService === null || $this->clientConfigService === null) {
            return [
                'present' => false,
                'count' => 0,
                'fallback_count' => 0,
                'sha256' => null,
                'reason' => 'service_unavailable',
            ];
        }

        $config = $this->clientConfigService->adminFetch();
        if (($config['status'] ?? 'missing') !== 'ok') {
            return [
                'present' => false,
                'count' => 0,
                'fallback_count' => 0,
                'sha256' => null,
                'reason' => 'config_missing',
            ];
        }

        $settings = is_array($config['settings'] ?? null) ? $config['settings'] : [];
        if (($settings['orchestrator_mcp_enabled'] ?? true) === false) {
            return [
                'present' => false,
                'count' => 0,
                'fallback_count' => 0,
                'sha256' => null,
                'reason' => 'mcp_disabled',
            ];
        }

        $hostId = $this->hostId($host);
        if ($hostId === null) {
            return [
                'present' => false,
                'count' => 0,
                'fallback_count' => 0,
                'sha256' => null,
                'reason' => 'host_missing',
            ];
        }

        $memories = $this->memoryService->listForAgentsDocument($host);

        $prefix = $this->markerPrefix($engine);

        $lines = [
            sprintf('<!-- %s:memories:start -->', $prefix),
            '## Memories',
            'The following memories are stored for this host. Use `memory_retrieve` to read full content.',
            '',
        ];

        $count = 0;
        $fallbackCount = 0;
        foreach ($memories as $memory) {
            $key = trim((string) ($memory['memory_key'] ?? ''));
            if ($key === '') {
                continue;
            }
            $count++;
            $hasSummary = is_string($memory['summary'] ?? null) && trim((string) $memory['summary']) !== '';
            if (!$hasSummary) {
                $fallbackCount++;
            }
            $summary = $this->normalizeMemoryDescription($memory['summary'] ?? null, $key);
            $lines[] = sprintf('- `%s` - %s', $key, $summary);
        }

        if ($count === 0) {
            return [
                'present' => false,
                'count' => 0,
                'fallback_count' => 0,
                'sha256' => null,
                'reason' => 'no_memories',
            ];
        }

        $lines[] = sprintf('<!-- %s:memories:end -->', $prefix);

        $body = implode("\n", $lines);

        return [
            'present' => true,
            'count' => $count,
            'fallback_count' => $fallbackCount,
            'sha256' => hash('sha256', $body),
            'reason' => 'ok',
            'body' => $body,
        ];
    }

    private function markerPrefix(string $engine): string
    {
        return Engine::wrapperName($engine);
    }

    private function normalizeMemoryDescription(mixed $description, string $key): string
    {
        if (is_string($description)) {
            $normalized = trim(preg_replace('/\s+/', ' ', $description) ?? '');
            if ($normalized !== '') {
                return $normalized;
            }
        }

        return sprintf('Memory stored under key `%s`.', $key);
    }

    private function publicSectionMetadata(array $section): array
    {
        unset($section['body']);

        return $section;
    }

    private function managedSha(?string $skillsBlock, ?string $memoriesBlock): ?string
    {
        $parts = [];
        if ($skillsBlock !== null && $skillsBlock !== '') {
            $parts[] = $skillsBlock;
        }
        if ($memoriesBlock !== null && $memoriesBlock !== '') {
            $parts[] = $memoriesBlock;
        }

        if ($parts === []) {
            return null;
        }

        return hash('sha256', implode("\n\n", $parts));
    }

    private function backupLimit(): ?int
    {
        if ($this->versions === null) {
            return null;
        }

        $stored = $this->versions->get(self::BACKUP_LIMIT_VERSION_KEY);
        if (!is_string($stored) || trim($stored) === '' || !is_numeric($stored)) {
            return null;
        }

        $limit = (int) $stored;
        if ($limit <= 0) {
            return null;
        }

        return min($limit, self::MAX_BACKUP_LIMIT);
    }

    private function normalizeBackupLimitInput(mixed $rawLimit): ?int
    {
        if ($rawLimit === null || $rawLimit === '') {
            return null;
        }

        $normalized = is_string($rawLimit) ? trim($rawLimit) : $rawLimit;
        if (!is_numeric($normalized)) {
            throw new ValidationException(['backup_limit' => ['backup_limit must be an integer between 0 and 200']]);
        }

        $limit = (int) $normalized;
        if ((string) $limit !== (string) $normalized) {
            throw new ValidationException(['backup_limit' => ['backup_limit must be an integer between 0 and 200']]);
        }

        if ($limit < 0 || $limit > self::MAX_BACKUP_LIMIT) {
            throw new ValidationException(['backup_limit' => ['backup_limit must be between 0 and 200']]);
        }

        return $limit === 0 ? null : $limit;
    }

    private function normalizePrunedIds(mixed $value): array
    {
        if (!is_array($value)) {
            return [];
        }

        $result = [];
        foreach ($value as $id) {
            if (is_numeric($id) && (int) $id > 0) {
                $result[] = (int) $id;
            }
        }

        return array_values(array_unique($result));
    }

    private function logPrunedVersions(string $reason, array $prunedIds, ?int $limit = null): void
    {
        if ($prunedIds === []) {
            return;
        }

        $this->logs->log(null, 'agents.backups_pruned', [
            'reason' => $reason,
            'backup_limit' => $limit ?? $this->backupLimit(),
            'pruned_count' => count($prunedIds),
            'version_ids' => $prunedIds,
        ]);
    }
}
