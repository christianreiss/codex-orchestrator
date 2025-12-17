<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Exceptions\ValidationException;
use App\Repositories\LogRepository;
use App\Repositories\SkillRepository;

class SkillService
{
    public function __construct(
        private readonly SkillRepository $skills,
        private readonly LogRepository $logs
    ) {
    }

    public function listSkills(?array $host = null, bool $includeDeleted = false): array
    {
        $rows = $this->skills->all($includeDeleted);
        $this->logs->log($this->hostId($host), 'skill.list', ['count' => count($rows)]);

        return $rows;
    }

    public function retrieve(string $slug, ?string $sha256, ?array $host = null): array
    {
        $normalized = $this->normalizeSlug($slug);
        $this->assertSha256($sha256, true);

        $row = $this->skills->findBySlug($normalized);
        $hostId = $this->hostId($host);

        if ($row === null) {
            $this->logs->log($hostId, 'skill.retrieve', [
                'slug' => $normalized,
                'status' => 'missing',
            ]);

            return [
                'status' => 'missing',
                'slug' => $normalized,
            ];
        }

        if (!empty($row['deleted_at'])) {
            $this->logs->log($hostId, 'skill.retrieve', [
                'slug' => $normalized,
                'status' => 'deleted',
            ]);

            return [
                'status' => 'deleted',
                'slug' => $normalized,
                'deleted_at' => $row['deleted_at'] ?? gmdate(DATE_ATOM),
            ];
        }

        $canonicalSha = (string) ($row['sha256'] ?? '');
        if ($canonicalSha === '' && isset($row['manifest'])) {
            $canonicalSha = hash('sha256', (string) $row['manifest']);
        }

        $status = ($sha256 !== null && hash_equals($canonicalSha, $sha256)) ? 'unchanged' : 'updated';
        $result = [
            'status' => $status,
            'slug' => $normalized,
            'sha256' => $canonicalSha,
            'display_name' => $row['display_name'] ?? null,
            'description' => $row['description'] ?? null,
            'updated_at' => $row['updated_at'] ?? null,
        ];

        if ($status !== 'unchanged') {
            $result['manifest'] = $row['manifest'] ?? '';
        }

        $this->logs->log($hostId, 'skill.retrieve', [
            'slug' => $normalized,
            'status' => $status,
        ]);

        return $result;
    }

    public function find(string $slug): ?array
    {
        $normalized = $this->normalizeSlug($slug);
        $row = $this->skills->findBySlug($normalized);
        if ($row === null) {
            return null;
        }

        return [
            'slug' => $normalized,
            'sha256' => $row['sha256'] ?? hash('sha256', (string) ($row['manifest'] ?? '')),
            'display_name' => $row['display_name'] ?? null,
            'description' => $row['description'] ?? null,
            'manifest' => $row['manifest'] ?? '',
            'updated_at' => $row['updated_at'] ?? null,
        ];
    }

    public function store(array $payload, ?array $host = null): array
    {
        $slugRaw = $payload['slug'] ?? ($payload['filename'] ?? '');
        $manifestRaw = $payload['manifest'] ?? ($payload['content'] ?? '');
        $displayNameRaw = $payload['display_name'] ?? null;
        $descriptionRaw = $payload['description'] ?? null;
        $providedSha = $payload['sha256'] ?? null;

        $slug = $this->normalizeSlug((string) $slugRaw);
        $manifest = trim((string) $manifestRaw) === '' ? '' : (string) $manifestRaw;

        $errors = [];
        if ($manifest === '') {
            $errors['manifest'][] = 'manifest is required';
        }

        $this->assertSha256(is_string($providedSha) ? $providedSha : null, true, $errors);

        if ($errors) {
            throw new ValidationException($errors);
        }

        $displayName = $displayNameRaw !== null ? trim((string) $displayNameRaw) : null;
        $description = $descriptionRaw !== null ? trim((string) $descriptionRaw) : null;

        $sha = hash('sha256', $manifest);
        if ($providedSha !== null && !hash_equals($sha, (string) $providedSha)) {
            $errors['sha256'][] = 'sha256 does not match manifest contents';
            throw new ValidationException($errors);
        }

        $existing = $this->skills->findBySlug($slug);
        $existingSha = $existing['sha256'] ?? null;
        $metadataChanged = $existing !== null && (
            ($existing['display_name'] ?? null) !== $displayName ||
            ($existing['description'] ?? null) !== $description
        );

        $status = 'created';
        if ($existing) {
            $status = ($existingSha !== null && hash_equals($existingSha, $sha) && !$metadataChanged) ? 'unchanged' : 'updated';
        }

        $saved = $status === 'unchanged'
            ? $existing
            : $this->skills->upsert($slug, $sha, $displayName, $description, $manifest, $this->hostId($host));

        $this->logs->log($this->hostId($host), 'skill.store', [
            'slug' => $slug,
            'status' => $status,
        ]);

        return [
            'status' => $status,
            'slug' => $slug,
            'sha256' => $saved['sha256'] ?? $sha,
            'updated_at' => $saved['updated_at'] ?? gmdate(DATE_ATOM),
        ];
    }

    public function delete(string $slug, ?array $host = null): bool
    {
        $normalized = $this->normalizeSlug($slug);
        $deleted = $this->skills->delete($normalized);
        $this->logs->log($this->hostId($host), 'skill.delete', [
            'slug' => $normalized,
            'deleted' => $deleted,
        ]);

        return $deleted;
    }

    private function normalizeSlug(string $slug): string
    {
        $normalized = trim($slug);

        if ($normalized === '') {
            throw new ValidationException(['slug' => ['slug is required']]);
        }
        if (strlen($normalized) > 255) {
            throw new ValidationException(['slug' => ['slug must be 255 characters or fewer']]);
        }
        if (str_contains($normalized, '..') || str_contains($normalized, '/')) {
            throw new ValidationException(['slug' => ['slug cannot include path separators']]);
        }
        if (!preg_match('/^[A-Za-z0-9._-]+$/', $normalized)) {
            throw new ValidationException(['slug' => ['slug may only contain letters, numbers, dots, underscores, and hyphens']]);
        }

        return $normalized;
    }

    private function assertSha256(?string $sha, bool $allowNull = false, array &$errors = []): void
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
        if (!preg_match('/^[A-Fa-f0-9]{64}$/', $value)) {
            $errors['sha256'][] = 'sha256 must be 64 hex characters';
            if ($errors) {
                throw new ValidationException($errors);
            }
        }
    }

    private function hostId(?array $host): ?int
    {
        return isset($host['id']) && is_numeric($host['id']) ? (int) $host['id'] : null;
    }
}
