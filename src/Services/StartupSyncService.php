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
        private readonly SlashCommandService $slashCommands,
        private readonly SkillService $skills,
        private readonly AgentsService $agents,
        private readonly ClientConfigService $configs
    ) {
    }

    public function collect(array $payload, array $host, string $baseUrl, string $apiKey, bool $includeContent = false): array
    {
        $slash = $this->collectSlashCommands($payload['slash_commands'] ?? null, $host, $includeContent);
        $skills = $this->collectSkills($payload['skills'] ?? null, $host, $includeContent);
        $agents = $this->collectAgents($payload['agents'] ?? null, $host, $includeContent);
        $config = $this->collectConfig($payload, $host, $baseUrl, $apiKey, $includeContent);

        $reasons = [];
        if ($slash['changed_count'] > 0) {
            $reasons[] = 'slash_commands_changed';
        }
        if ($skills['changed_count'] > 0) {
            $reasons[] = 'skills_changed';
        }
        if (!empty($agents['changed'])) {
            $reasons[] = 'agents_changed';
        }
        if (!empty($config['changed'])) {
            $reasons[] = 'config_changed';
        }

        return [
            'status' => $reasons === [] ? 'ok' : 'update',
            'reasons' => $reasons,
            'slash_commands' => $slash,
            'skills' => $skills,
            'agents' => $agents,
            'config' => $config,
        ];
    }

    private function collectSlashCommands(mixed $payload, ?array $host, bool $includeContent): array
    {
        $local = $this->normalizeNamedShaMap($payload, 'filename');
        $rows = $this->slashCommands->listCommands($host, true);

        $remote = [];
        $changed = [];
        $updatedCount = 0;
        $removedCount = 0;

        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }
            $filename = trim((string) ($row['filename'] ?? ''));
            if ($filename === '') {
                continue;
            }

            $remoteSha = $this->normalizeSha($row['sha256'] ?? null);
            $deletedAt = isset($row['deleted_at']) && is_string($row['deleted_at']) && trim($row['deleted_at']) !== ''
                ? (string) $row['deleted_at']
                : null;
            $isDeleted = $deletedAt !== null;
            $localHas = array_key_exists($filename, $local);
            $localSha = $localHas ? $local[$filename] : null;

            $remote[] = [
                'filename' => $filename,
                'sha256' => $remoteSha,
                'deleted_at' => $deletedAt,
            ];

            if ($isDeleted) {
                if (!$localHas) {
                    continue;
                }

                $removedCount++;
                $changed[] = [
                    'filename' => $filename,
                    'status' => 'deleted',
                    'deleted_at' => $deletedAt,
                ];
                continue;
            }

            $matches = $localHas
                && $localSha !== null
                && $remoteSha !== null
                && hash_equals($remoteSha, $localSha);

            if ($matches) {
                continue;
            }

            $updatedCount++;
            $entry = [
                'filename' => $filename,
                'status' => 'updated',
                'sha256' => $remoteSha,
                'description' => isset($row['description']) ? (string) $row['description'] : null,
                'argument_hint' => isset($row['argument_hint']) ? (string) $row['argument_hint'] : null,
                'updated_at' => isset($row['updated_at']) ? (string) $row['updated_at'] : null,
            ];

            if ($includeContent) {
                $doc = $this->slashCommands->find($filename);
                if ($doc !== null) {
                    $entry['prompt'] = (string) ($doc['prompt'] ?? '');
                    $entry['sha256'] = $this->normalizeSha($doc['sha256'] ?? null) ?? $entry['sha256'];
                    $entry['description'] = isset($doc['description']) ? (string) $doc['description'] : $entry['description'];
                    $entry['argument_hint'] = isset($doc['argument_hint']) ? (string) $doc['argument_hint'] : $entry['argument_hint'];
                    $entry['updated_at'] = isset($doc['updated_at']) ? (string) $doc['updated_at'] : $entry['updated_at'];
                }
            }

            $changed[] = $entry;
        }

        return [
            'status' => $changed === [] ? 'unchanged' : 'updated',
            'changed_count' => count($changed),
            'updated_count' => $updatedCount,
            'removed_count' => $removedCount,
            'remote_count' => count($remote),
            'local_count' => count($local),
            'remote' => $remote,
            'changed' => $changed,
        ];
    }

    private function collectSkills(mixed $payload, ?array $host, bool $includeContent): array
    {
        $local = $this->normalizeNamedShaMap($payload, 'slug');
        $rows = $this->skills->listSkills($host, true);

        $remote = [];
        $changed = [];
        $updatedCount = 0;
        $removedCount = 0;

        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }
            $slug = trim((string) ($row['slug'] ?? ''));
            if ($slug === '') {
                continue;
            }

            $remoteSha = $this->normalizeSha($row['sha256'] ?? null);
            $deletedAt = isset($row['deleted_at']) && is_string($row['deleted_at']) && trim($row['deleted_at']) !== ''
                ? (string) $row['deleted_at']
                : null;
            $isDeleted = $deletedAt !== null;
            $localHas = array_key_exists($slug, $local);
            $localSha = $localHas ? $local[$slug] : null;

            $remote[] = [
                'slug' => $slug,
                'sha256' => $remoteSha,
                'deleted_at' => $deletedAt,
                'managed' => !empty($row['managed']),
            ];

            if ($isDeleted) {
                if (!$localHas) {
                    continue;
                }

                $removedCount++;
                $changed[] = [
                    'slug' => $slug,
                    'status' => 'deleted',
                    'deleted_at' => $deletedAt,
                ];
                continue;
            }

            $matches = $localHas
                && $localSha !== null
                && $remoteSha !== null
                && hash_equals($remoteSha, $localSha);

            if ($matches) {
                continue;
            }

            $updatedCount++;
            $entry = [
                'slug' => $slug,
                'status' => 'updated',
                'sha256' => $remoteSha,
                'managed' => !empty($row['managed']),
                'display_name' => isset($row['display_name']) ? (string) $row['display_name'] : null,
                'description' => isset($row['description']) ? (string) $row['description'] : null,
                'updated_at' => isset($row['updated_at']) ? (string) $row['updated_at'] : null,
            ];

            if ($includeContent) {
                $doc = $this->skills->find($slug);
                if ($doc !== null) {
                    $entry['manifest'] = (string) ($doc['manifest'] ?? '');
                    $entry['sha256'] = $this->normalizeSha($doc['sha256'] ?? null) ?? $entry['sha256'];
                    $entry['display_name'] = isset($doc['display_name']) ? (string) $doc['display_name'] : $entry['display_name'];
                    $entry['description'] = isset($doc['description']) ? (string) $doc['description'] : $entry['description'];
                    $entry['updated_at'] = isset($doc['updated_at']) ? (string) $doc['updated_at'] : $entry['updated_at'];
                }
            }

            $changed[] = $entry;
        }

        return [
            'status' => $changed === [] ? 'unchanged' : 'updated',
            'changed_count' => count($changed),
            'updated_count' => $updatedCount,
            'removed_count' => $removedCount,
            'remote_count' => count($remote),
            'local_count' => count($local),
            'remote' => $remote,
            'changed' => $changed,
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

    /**
     * @return array<string, string|null>
     */
    private function normalizeNamedShaMap(mixed $payload, string $key): array
    {
        $items = [];
        if (is_array($payload)) {
            if (array_key_exists('items', $payload) && is_array($payload['items'])) {
                $items = $payload['items'];
            } else {
                $items = $payload;
            }
        }

        $normalized = [];
        foreach ($items as $entry) {
            if (!is_array($entry)) {
                continue;
            }

            $name = trim((string) ($entry[$key] ?? ''));
            if ($name === '') {
                continue;
            }

            $normalized[$name] = $this->normalizeSha($entry['sha256'] ?? null);
        }

        return $normalized;
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
