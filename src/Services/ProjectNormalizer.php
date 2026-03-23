<?php

declare(strict_types=1);

namespace App\Services;

use App\Exceptions\ValidationException;

class ProjectNormalizer
{
    public function normalizeSlug(mixed $value): string
    {
        $slug = trim((string) $value);
        if ($slug === '') {
            throw new ValidationException(['slug' => ['slug is required']]);
        }
        if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9_-]*$/', $slug)) {
            throw new ValidationException(['slug' => ['slug must match /^[A-Za-z0-9][A-Za-z0-9_-]*$/']]);
        }

        return $slug;
    }

    public function normalizeAbout(mixed $value): ?array
    {
        if ($value === null) {
            return null;
        }
        if (!is_array($value)) {
            throw new ValidationException(['about' => ['about must be an object']]);
        }

        $normalized = [];
        foreach ($value as $key => $entry) {
            if (!is_string($key) || trim($key) === '') {
                continue;
            }
            if (is_scalar($entry) || $entry === null) {
                $normalized[$key] = is_string($entry) ? trim($entry) : $entry;
                continue;
            }
            if (is_array($entry)) {
                $normalized[$key] = $entry;
            }
        }

        return $normalized === [] ? null : $normalized;
    }

    public function normalizeRoster(mixed $value): string
    {
        $text = trim((string) $value);
        if (strlen($text) > 65535) {
            throw new ValidationException(['roster_markdown' => ['roster_markdown must be 65535 characters or fewer']]);
        }

        return $text;
    }

    /**
     * @return array{0:string,1:string}
     */
    public function normalizeNotePayload(array $payload): array
    {
        $header = trim((string) ($payload['header'] ?? ''));
        $body = trim((string) ($payload['body'] ?? ''));
        $errors = [];
        if ($header === '') {
            $errors['header'][] = 'header is required';
        }
        if ($body === '') {
            $errors['body'][] = 'body is required';
        }
        if ($errors) {
            throw new ValidationException($errors);
        }

        return [$header, $body];
    }

    /**
     * @return array{0:string,1:string}
     */
    public function normalizeTodoPayload(array $payload): array
    {
        $title = trim((string) ($payload['title'] ?? ''));
        $detail = trim((string) ($payload['detail'] ?? ''));
        $errors = [];
        if ($title === '') {
            $errors['title'][] = 'title is required';
        }
        if ($errors) {
            throw new ValidationException($errors);
        }

        return [$title, $detail];
    }

    /**
     * @return array{0:string,1:?string,2:string,3:?string}
     */
    public function normalizeFilePayload(array $payload): array
    {
        $storedName = $this->normalizeStoredName($payload['stored_name'] ?? ($payload['name'] ?? ''));
        $description = $this->normalizeOptionalString($payload['description'] ?? null);
        $content = (string) ($payload['content'] ?? ($payload['text'] ?? ''));
        $mimeType = $this->normalizeOptionalString($payload['mime_type'] ?? null);
        if ($content === '') {
            throw new ValidationException(['content' => ['content is required']]);
        }

        return [$storedName, $description, $content, $mimeType];
    }

    /**
     * @return array{0:string,1:string,2:string}
     */
    public function normalizeFeedbackPayload(array $payload): array
    {
        $type = strtolower(trim((string) ($payload['type'] ?? 'feature')));
        $title = trim((string) ($payload['title'] ?? ''));
        $body = trim((string) ($payload['body'] ?? ''));
        $errors = [];
        if (!in_array($type, ['bug', 'feature', 'note'], true)) {
            $errors['type'][] = 'type must be bug, feature, or note';
        }
        if ($title === '') {
            $errors['title'][] = 'title is required';
        }
        if ($body === '') {
            $errors['body'][] = 'body is required';
        }
        if ($errors) {
            throw new ValidationException($errors);
        }

        return [$type, $title, $body];
    }

    public function normalizeStoredName(mixed $value): string
    {
        $name = trim((string) $value);
        if ($name === '') {
            throw new ValidationException(['stored_name' => ['stored_name is required']]);
        }
        $normalized = preg_replace('#/+#', '/', str_replace('\\', '/', $name));
        $normalized = $normalized === null ? $name : $normalized;
        $segments = array_values(array_filter(explode('/', $normalized), static fn (string $segment): bool => $segment !== ''));
        if ($segments === []) {
            throw new ValidationException(['stored_name' => ['stored_name is invalid']]);
        }
        foreach ($segments as $segment) {
            if ($segment === '.' || $segment === '..') {
                throw new ValidationException(['stored_name' => ['stored_name cannot contain dot segments']]);
            }
        }

        return implode('/', $segments);
    }

    public function normalizeOptionalString(mixed $value): ?string
    {
        if (!is_scalar($value) || is_bool($value)) {
            return null;
        }
        $trimmed = trim((string) $value);

        return $trimmed === '' ? null : $trimmed;
    }
}
