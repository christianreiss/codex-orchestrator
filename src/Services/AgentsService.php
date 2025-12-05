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
        $row = $this->agents->latest();
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

    public function adminFetch(): array
    {
        $row = $this->agents->latest();
        if ($row === null) {
            return [
                'status' => 'missing',
            ];
        }

        return [
            'status' => 'ok',
            'sha256' => $row['sha256'] ?? hash('sha256', (string) ($row['body'] ?? '')),
            'updated_at' => $row['updated_at'] ?? null,
            'size_bytes' => strlen((string) ($row['body'] ?? '')),
            'content' => (string) ($row['body'] ?? ''),
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

        $saved = $status === 'unchanged' ? $existing : $this->agents->upsert($body, $this->hostId($host), $computedSha);

        $this->logs->log($this->hostId($host), 'agents.store', ['status' => $status]);

        return [
            'status' => $status,
            'sha256' => $saved['sha256'] ?? $computedSha,
            'updated_at' => $saved['updated_at'] ?? gmdate(DATE_ATOM),
            'size_bytes' => strlen((string) ($saved['body'] ?? $body)),
        ];
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
}
