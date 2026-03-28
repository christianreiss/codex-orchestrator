<?php

declare(strict_types=1);

namespace App\Services;

use App\Exceptions\ValidationException;

class SkillManifestService
{
    public function normalizeSlug(string $slug): string
    {
        $normalized = trim($slug);

        if ($normalized === '') {
            throw new ValidationException(['slug' => ['slug is required']]);
        }
        if (strlen($normalized) > 255) {
            throw new ValidationException(['slug' => ['slug must be 255 characters or fewer']]);
        }
        if (!preg_match('/^[a-z0-9][a-z0-9._-]*$/', $normalized)) {
            throw new ValidationException(['slug' => ['slug must start with a lowercase letter or number and contain only lowercase letters, numbers, dot, underscore, or dash']]);
        }

        return $normalized;
    }

    /**
     * @param array<string, mixed> $draft
     * @return array{slug:string,display_name:string,description:string,tags:array<int,string>,what:string,when:string,steps:string}
     */
    public function normalizeDraft(array $draft): array
    {
        $slug = $this->normalizeSlug((string) ($draft['slug'] ?? ''));
        $displayName = $this->normalizeLine($draft['display_name'] ?? null, 'display_name', true);
        $description = $this->normalizeLine($draft['description'] ?? null, 'description', true);
        $tags = $this->normalizeTags($draft['tags'] ?? []);
        $what = $this->normalizeSection($draft['what'] ?? null, 'what');
        $when = $this->normalizeSection($draft['when'] ?? null, 'when');
        $steps = $this->normalizeSection($draft['steps'] ?? null, 'steps');

        return [
            'slug' => $slug,
            'display_name' => $displayName,
            'description' => $description,
            'tags' => $tags,
            'what' => $what,
            'when' => $when,
            'steps' => $steps,
        ];
    }

    /**
     * @param array{display_name:string,description:?string,tags:array<int,string>,what:string,when:string,steps:string} $fields
     */
    public function buildManifest(array $fields): string
    {
        $displayName = trim((string) ($fields['display_name'] ?? ''));
        $description = isset($fields['description']) ? trim((string) $fields['description']) : '';
        $tags = is_array($fields['tags'] ?? null) ? array_values($fields['tags']) : [];
        $what = trim(str_replace("\r\n", "\n", (string) ($fields['what'] ?? '')));
        $when = trim(str_replace("\r\n", "\n", (string) ($fields['when'] ?? '')));
        $steps = trim(str_replace("\r\n", "\n", (string) ($fields['steps'] ?? '')));

        $lines = ['---'];
        if ($displayName !== '') {
            $lines[] = 'name: ' . $this->quoteYaml($displayName);
        }
        if ($description !== '') {
            $lines[] = 'description: ' . $this->quoteYaml($description);
        }
        if ($tags !== []) {
            $lines[] = 'tags:';
            foreach ($tags as $tag) {
                $lines[] = '  - ' . $this->quoteYaml((string) $tag);
            }
        }
        $lines[] = '---';
        $lines[] = '';
        $lines[] = '# What this skill does';
        $lines[] = '';
        $lines[] = $what;
        $lines[] = '';
        $lines[] = '## When to use this skill';
        $lines[] = '';
        $lines[] = $when;
        $lines[] = '';
        $lines[] = '## Step-by-Step Instructions';
        $lines[] = '';
        $lines[] = $steps;

        return preg_replace("/\n{3,}/", "\n\n", implode("\n", $lines)) . "\n";
    }

    /**
     * @param mixed $value
     * @return array<int,string>
     */
    private function normalizeTags(mixed $value): array
    {
        if (!is_array($value)) {
            throw new ValidationException(['tags' => ['tags must be an array']]);
        }

        $tags = [];
        foreach ($value as $tag) {
            if (!is_string($tag)) {
                continue;
            }

            $normalized = trim(preg_replace('/\s+/', ' ', $tag) ?? '');
            if ($normalized === '') {
                continue;
            }
            if (!in_array($normalized, $tags, true)) {
                $tags[] = $normalized;
            }
        }

        return $tags;
    }

    private function normalizeLine(mixed $value, string $field, bool $required): string
    {
        if (!is_string($value)) {
            if ($required) {
                throw new ValidationException([$field => [$field . ' is required']]);
            }

            return '';
        }

        $normalized = trim(preg_replace('/\s+/', ' ', $value) ?? '');
        if ($normalized === '' && $required) {
            throw new ValidationException([$field => [$field . ' is required']]);
        }

        return $normalized;
    }

    private function normalizeSection(mixed $value, string $field): string
    {
        if (!is_string($value)) {
            throw new ValidationException([$field => [$field . ' is required']]);
        }

        $normalized = trim(str_replace("\r\n", "\n", $value));
        if ($normalized === '') {
            throw new ValidationException([$field => [$field . ' is required']]);
        }

        return $normalized;
    }

    private function quoteYaml(string $value): string
    {
        $escaped = str_replace(['\\', '"'], ['\\\\', '\\"'], $value);

        return '"' . $escaped . '"';
    }
}
