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
use App\Services\Traits\HostServiceTrait;
use App\Support\Engine;

class SkillService
{
    use HostServiceTrait;
    public const CANONICAL_URI_PREFIX = 'skill://';

    public function __construct(
        private readonly SkillRepository $skills,
        private readonly LogRepository $logs,
        private readonly ?ProjectModuleService $projectModule = null,
        private readonly ?SkillSummaryService $summaryService = null,
        private readonly ?SkillManifestService $manifestService = null,
        private readonly ?JoplinSkillService $joplinSkill = null
    ) {
    }

    /**
     * @param string|null $engine Filter skills by engine. NULL returns all skills.
     *                            A specific engine returns universal (NULL engine) + engine-specific skills.
     */
    public function listSkills(?array $host = null, bool $includeDeleted = false, ?string $engine = null): array
    {
        $rows = $this->publishedSkills($includeDeleted);

        // Filter by engine: include universal skills (engine IS NULL) and engine-specific ones.
        if ($engine !== null && Engine::isValid($engine)) {
            $rows = array_values(array_filter($rows, static function (array $row) use ($engine): bool {
                $skillEngine = $row['engine'] ?? null;
                return $skillEngine === null || $skillEngine === '' || $skillEngine === $engine;
            }));
        }

        $this->logs->log($this->hostId($host), 'skill.list', ['count' => count($rows), 'engine' => $engine]);

        return $rows;
    }

    public function listForAgents(): array
    {
        return array_map(
            static function (array $row): array {
                return [
                    'slug' => $row['slug'] ?? null,
                    'description' => $row['description'] ?? null,
                    'display_name' => $row['display_name'] ?? null,
                    'canonical_uri' => $row['canonical_uri'] ?? null,
                ];
            },
            $this->publishedSkills(false)
        );
    }

    public function retrieve(string $slug, ?string $sha256, ?array $host = null): array
    {
        $normalized = $this->normalizeSlug($slug);
        $this->assertSha256($sha256, true);

        $row = $this->resolveSkill($normalized);
        $hostId = $this->hostId($host);

        if ($row === null) {
            $this->logs->log($hostId, 'skill.retrieve', [
                'slug' => $normalized,
                'status' => 'missing',
            ]);

            return $this->decorateSkillPayload($normalized, [
                'status' => 'missing',
                'slug' => $normalized,
            ]);
        }

        if (!empty($row['deleted_at'])) {
            $this->logs->log($hostId, 'skill.retrieve', [
                'slug' => $normalized,
                'status' => 'deleted',
            ]);

            return $this->decorateSkillPayload($normalized, [
                'status' => 'deleted',
                'slug' => $normalized,
                'uri' => $this->skillUri($normalized),
                'deleted_at' => $row['deleted_at'] ?? gmdate(DATE_ATOM),
            ]);
        }

        $canonicalSha = (string) ($row['sha256'] ?? '');
        if ($canonicalSha === '' && isset($row['manifest'])) {
            $canonicalSha = hash('sha256', (string) $row['manifest']);
        }

        $status = ($sha256 !== null && hash_equals($canonicalSha, $sha256)) ? 'unchanged' : 'updated';
        $result = $this->decorateSkillPayload($normalized, [
            'status' => $status,
            'slug' => $normalized,
            'uri' => $this->skillUri($normalized),
            'sha256' => $canonicalSha,
            'display_name' => $row['display_name'] ?? null,
            'description' => $row['description'] ?? null,
            'updated_at' => $row['updated_at'] ?? null,
            'managed' => !empty($row['managed']),
        ]);

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
        $row = $this->resolveSkill($normalized);
        if ($row === null) {
            return null;
        }

        return $this->decorateSkillPayload($normalized, [
            'slug' => $normalized,
            'uri' => $this->skillUri($normalized),
            'sha256' => $row['sha256'] ?? hash('sha256', (string) ($row['manifest'] ?? '')),
            'display_name' => $row['display_name'] ?? null,
            'description' => $row['description'] ?? null,
            'manifest' => $row['manifest'] ?? '',
            'updated_at' => $row['updated_at'] ?? null,
            'managed' => !empty($row['managed']),
        ]);
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
        if ($this->isManagedSlug($slug)) {
            throw new ValidationException(['slug' => ['slug is reserved for the managed project coordination skill']]);
        }
        if ($this->isJoplinManagedSlug($slug)) {
            throw new ValidationException(['slug' => ['slug is reserved for the managed Joplin skill']]);
        }

        $sha = hash('sha256', $manifest);
        if ($providedSha !== null && !hash_equals($sha, (string) $providedSha)) {
            $errors['sha256'][] = 'sha256 does not match manifest contents';
            throw new ValidationException($errors);
        }

        $existing = $this->skills->findBySlug($slug);
        $existingSha = $existing['sha256'] ?? null;
        $manifestChanged = !$existing || !is_string($existingSha) || !hash_equals($existingSha, $sha);
        $descriptionToPersist = $descriptionRaw === null ? ($existing['description'] ?? null) : $description;
        $metadataChanged = $existing !== null && (
            ($existing['display_name'] ?? null) !== $displayName ||
            ($existing['description'] ?? null) !== $descriptionToPersist
        );

        $status = 'created';
        if ($existing) {
            $status = ($existingSha !== null && hash_equals($existingSha, $sha) && !$metadataChanged) ? 'unchanged' : 'updated';
        }

        $saved = $status === 'unchanged'
            ? $existing
            : $this->skills->upsert($slug, $sha, $displayName, $descriptionToPersist, $manifest, $this->hostId($host));

        if ($descriptionRaw === null && $manifestChanged) {
            $generatedDescription = $this->summaryService?->summarize($slug, $manifest, $host);
            if ($generatedDescription !== null && $generatedDescription !== ($saved['description'] ?? null)) {
                $saved = $this->skills->upsert(
                    $slug,
                    $sha,
                    $displayName,
                    $generatedDescription,
                    $manifest,
                    $this->hostId($host)
                );
            }
        }

        $this->logs->log($this->hostId($host), 'skill.store', [
            'slug' => $slug,
            'status' => $status,
        ]);

        return $this->decorateSkillPayload($slug, [
            'status' => $status,
            'slug' => $slug,
            'sha256' => $saved['sha256'] ?? $sha,
            'updated_at' => $saved['updated_at'] ?? gmdate(DATE_ATOM),
            'managed' => !empty($saved['managed']),
        ]);
    }

    public function delete(string $slug, ?array $host = null): bool
    {
        $normalized = $this->normalizeSlug($slug);
        if ($this->isManagedSlug($normalized)) {
            throw new ValidationException(['slug' => ['managed project coordination skill cannot be deleted directly']]);
        }
        if ($this->isJoplinManagedSlug($normalized)) {
            throw new ValidationException(['slug' => ['managed Joplin skill cannot be deleted directly']]);
        }
        $deleted = $this->skills->delete($normalized);
        $this->logs->log($this->hostId($host), 'skill.delete', [
            'slug' => $normalized,
            'deleted' => $deleted,
        ]);

        return $deleted;
    }

    private function normalizeSlug(string $slug): string
    {
        if ($this->manifestService !== null) {
            return $this->manifestService->normalizeSlug($slug);
        }

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

    private function resolveSkill(string $slug): ?array
    {
        if ($this->isManagedSlug($slug)) {
            return $this->managedSkill();
        }
        if ($this->isJoplinManagedSlug($slug)) {
            return $this->joplinSkill();
        }

        return $this->skills->findBySlug($slug);
    }

    private function managedSkill(): ?array
    {
        return $this->projectModule?->managedSkill();
    }

    private function joplinSkill(): ?array
    {
        return $this->joplinSkill?->managedSkill();
    }

    private function publishedSkills(bool $includeDeleted): array
    {
        $rows = $this->skills->all($includeDeleted);
        $rows = $this->injectManagedSkill($rows, ProjectModuleService::MANAGED_SKILL_SLUG, $this->managedSkill());
        $rows = $this->injectManagedSkill($rows, JoplinSkillService::MANAGED_SKILL_SLUG, $this->joplinSkill());

        return array_map(
            fn (array $row): array => $this->decorateSkillRow($this->addCanonicalUri($row)),
            $rows
        );
    }

    private function injectManagedSkill(array $rows, string $slug, ?array $managed): array
    {
        if ($managed === null) {
            return $rows;
        }

        $rows = array_values(array_filter(
            $rows,
            static fn (array $row): bool => (string) ($row['slug'] ?? '') !== $slug
        ));
        $rows[] = $managed;
        usort($rows, static fn (array $a, array $b): int => strcmp((string) ($a['slug'] ?? ''), (string) ($b['slug'] ?? '')));

        return $rows;
    }

    private function decorateSkillRow(array $row): array
    {
        $slug = trim((string) ($row['slug'] ?? ''));
        if ($slug === '') {
            return $row;
        }

        return $this->decorateSkillPayload($slug, $row + [
            'managed' => !empty($row['managed']),
        ]);
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    private function decorateSkillPayload(string $slug, array $payload): array
    {
        $payload['uri'] = $this->skillUri($slug);
        $payload['canonical_uri'] = $this->skillUri($slug);

        return $payload;
    }

    private function skillUri(string $slug): string
    {
        return self::CANONICAL_URI_PREFIX . rawurlencode($slug);
    }

    private function isManagedSlug(string $slug): bool
    {
        return $slug === ProjectModuleService::MANAGED_SKILL_SLUG && $this->managedSkill() !== null;
    }

    private function isJoplinManagedSlug(string $slug): bool
    {
        return $slug === JoplinSkillService::MANAGED_SKILL_SLUG && $this->joplinSkill() !== null;
    }

    private function addCanonicalUri(array $row): array
    {
        $slug = trim((string) ($row['slug'] ?? ''));
        if ($slug === '') {
            return $row;
        }

        $row['uri'] = $this->skillUri($slug);

        return $row;
    }
}
