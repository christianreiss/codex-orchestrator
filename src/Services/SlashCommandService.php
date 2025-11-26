<?php

namespace App\Services;

use App\Exceptions\ValidationException;
use App\Repositories\LogRepository;
use App\Repositories\SlashCommandRepository;

class SlashCommandService
{
    public function __construct(
        private readonly SlashCommandRepository $commands,
        private readonly LogRepository $logs
    ) {
    }

    public function listCommands(?array $host = null): array
    {
        $rows = $this->commands->all();
        $hostId = isset($host['id']) && is_numeric($host['id']) ? (int) $host['id'] : null;
        $this->logs->log($hostId, 'slash.list', ['count' => count($rows)]);

        return $rows;
    }

    public function retrieve(string $filename, ?string $sha256, ?array $host = null): array
    {
        $normalizedFilename = $this->normalizeFilename($filename);
        $this->assertSha256($sha256, true);

        $row = $this->commands->findByFilename($normalizedFilename);
        $hostId = isset($host['id']) && is_numeric($host['id']) ? (int) $host['id'] : null;

        if ($row === null) {
            $this->logs->log($hostId, 'slash.retrieve', [
                'filename' => $normalizedFilename,
                'status' => 'missing',
            ]);

            return [
                'status' => 'missing',
                'filename' => $normalizedFilename,
            ];
        }

        $canonicalSha = (string) ($row['sha256'] ?? '');
        if ($canonicalSha === '' && isset($row['prompt'])) {
            $canonicalSha = hash('sha256', (string) $row['prompt']);
        }
        $status = ($sha256 !== null && hash_equals($canonicalSha, $sha256)) ? 'unchanged' : 'updated';
        $result = [
            'status' => $status,
            'filename' => $normalizedFilename,
            'sha256' => $canonicalSha,
            'description' => $row['description'] ?? null,
            'argument_hint' => $row['argument_hint'] ?? null,
            'updated_at' => $row['updated_at'] ?? null,
        ];

        if ($status !== 'unchanged') {
            $result['prompt'] = $row['prompt'] ?? '';
        }

        $this->logs->log($hostId, 'slash.retrieve', [
            'filename' => $normalizedFilename,
            'status' => $status,
        ]);

        return $result;
    }

    public function store(array $payload, ?array $host = null): array
    {
        $filenameRaw = is_array($payload) ? ($payload['filename'] ?? '') : '';
        $promptRaw = is_array($payload) ? ($payload['prompt'] ?? ($payload['content'] ?? '')) : '';
        $descriptionRaw = is_array($payload) ? ($payload['description'] ?? null) : null;
        $argumentHintRaw = is_array($payload) ? ($payload['argument_hint'] ?? null) : null;
        $providedSha = is_array($payload) ? ($payload['sha256'] ?? null) : null;

        $filename = $this->normalizeFilename((string) $filenameRaw);
        $prompt = trim((string) $promptRaw) === '' ? '' : (string) $promptRaw;

        $errors = [];
        if ($prompt === '') {
            $errors['prompt'][] = 'prompt is required';
        }

        $this->assertSha256($providedSha, false, $errors);

        if ($errors) {
            throw new ValidationException($errors);
        }

        [$parsedDescription, $parsedArgumentHint] = $this->parseFrontMatter($prompt);
        $description = $descriptionRaw !== null ? trim((string) $descriptionRaw) : $parsedDescription;
        $argumentHint = $argumentHintRaw !== null ? trim((string) $argumentHintRaw) : $parsedArgumentHint;

        $sha = hash('sha256', $prompt);
        if ($providedSha !== null && !hash_equals($sha, (string) $providedSha)) {
            $errors['sha256'][] = 'sha256 does not match prompt contents';
            throw new ValidationException($errors);
        }

        $existing = $this->commands->findByFilename($filename);
        $existingSha = $existing['sha256'] ?? null;
        $metadataChanged = $existing !== null && (
            ($existing['description'] ?? null) !== $description ||
            ($existing['argument_hint'] ?? null) !== $argumentHint
        );

        $status = 'created';
        if ($existing) {
            $status = ($existingSha !== null && hash_equals($existingSha, $sha) && !$metadataChanged) ? 'unchanged' : 'updated';
        }

        $saved = $status === 'unchanged'
            ? $existing
            : $this->commands->upsert($filename, $sha, $description, $argumentHint, $prompt, $this->hostId($host));

        $this->logs->log($this->hostId($host), 'slash.store', [
            'filename' => $filename,
            'status' => $status,
        ]);

        return [
            'status' => $status,
            'filename' => $filename,
            'sha256' => $saved['sha256'] ?? $sha,
            'updated_at' => $saved['updated_at'] ?? gmdate(DATE_ATOM),
        ];
    }

    private function normalizeFilename(string $filename): string
    {
        $normalized = trim($filename);

        if ($normalized === '') {
            throw new ValidationException(['filename' => ['filename is required']]);
        }
        if (strlen($normalized) > 255) {
            throw new ValidationException(['filename' => ['filename must be 255 characters or fewer']]);
        }
        if (str_contains($normalized, '..') || str_contains($normalized, '/')) {
            throw new ValidationException(['filename' => ['filename cannot include path separators']]);
        }
        if (!preg_match('/^[A-Za-z0-9._-]+$/', $normalized)) {
            throw new ValidationException(['filename' => ['filename may only contain letters, numbers, dots, underscores, and hyphens']]);
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

    private function parseFrontMatter(string $prompt): array
    {
        $description = null;
        $argumentHint = null;

        $lines = preg_split('/\r\n|\r|\n/', $prompt);
        if (!$lines || trim($lines[0]) !== '---') {
            return [$description, $argumentHint];
        }

        $endIndex = null;
        for ($i = 1; $i < count($lines); $i++) {
            if (trim($lines[$i]) === '---') {
                $endIndex = $i;
                break;
            }
        }

        if ($endIndex === null) {
            return [$description, $argumentHint];
        }

        for ($i = 1; $i < $endIndex; $i++) {
            $line = trim((string) $lines[$i]);
            if ($line === '') {
                continue;
            }
            $parts = explode(':', $line, 2);
            if (count($parts) !== 2) {
                continue;
            }
            [$key, $value] = $parts;
            $key = strtolower(trim($key));
            $value = trim($value);
            if ($key === 'description') {
                $description = $value;
            } elseif ($key === 'argument-hint') {
                $argumentHint = $value;
            }
        }

        return [$description, $argumentHint];
    }

    private function hostId(?array $host): ?int
    {
        return isset($host['id']) && is_numeric($host['id']) ? (int) $host['id'] : null;
    }
}
