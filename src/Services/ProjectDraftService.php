<?php

declare(strict_types=1);

namespace App\Services;

use App\Exceptions\HttpException;
use App\Repositories\AuthPayloadRepository;
use App\Repositories\LogRepository;
use App\Services\Traits\HostServiceTrait;

class ProjectDraftService
{
    use HostServiceTrait;

    public function __construct(
        private readonly AuthPayloadRepository $payloads,
        private readonly LogRepository $logs,
        private readonly ProjectCoordinationService $projects,
        private readonly ?RunnerVerifier $runner = null,
        private readonly ?RunnerValidationService $runnerValidationService = null
    ) {
    }

    /**
     * @return array<string, mixed>
     */
    public function assist(string $slug, ?array $host = null): array
    {
        if ($this->runner === null) {
            $this->logs->log($this->hostId($host), 'project.assist', [
                'status' => 'skipped',
                'reason' => 'runner unavailable',
                'slug' => $slug,
            ]);

            throw new HttpException('Auth runner unavailable', 503);
        }

        $authPayload = $this->canonicalAuthPayload();
        if ($authPayload === null) {
            $this->logs->log($this->hostId($host), 'project.assist', [
                'status' => 'skipped',
                'reason' => 'canonical auth missing',
                'slug' => $slug,
            ]);

            throw new HttpException('Canonical auth missing', 503);
        }

        $detail = $this->projects->projectDetail($slug, $host);
        $project = is_array($detail['project'] ?? null) ? $detail['project'] : [];
        $currentDraft = $this->currentDraftFromDetail($detail);
        $runnerProject = $this->buildRunnerProjectContext($detail);

        $result = $this->runner->assistProjectDraft($slug, $runnerProject, $authPayload);
        $status = strtolower(trim((string) ($result['status'] ?? '')));

        if ($status !== 'ok') {
            $this->logs->log($this->hostId($host), 'project.assist', [
                'status' => 'failed',
                'reason' => $result['reason'] ?? 'assist failed',
                'slug' => $slug,
                'latency_ms' => $result['latency_ms'] ?? null,
                'reachable' => $result['reachable'] ?? null,
            ]);

            throw new HttpException('Project assist failed: ' . ($result['reason'] ?? 'runner returned non-ok status'), 502);
        }

        $assistantMessage = $this->sanitizeLine($result['assistant_message'] ?? null, 240);
        if ($assistantMessage === null || $assistantMessage === '') {
            $this->logs->log($this->hostId($host), 'project.assist', [
                'status' => 'failed',
                'reason' => 'invalid runner assist payload',
                'slug' => $slug,
                'latency_ms' => $result['latency_ms'] ?? null,
            ]);

            throw new HttpException('Project assist failed: invalid runner assist payload', 502);
        }

        $draft = $this->buildDraftPayload($result, $currentDraft);

        $response = [
            'project' => (string) ($project['slug'] ?? $slug),
            'about' => $draft['about'],
            'roster_markdown' => $draft['roster_markdown'],
            'assistant_message' => $assistantMessage,
            'changed_fields' => $draft['changed_fields'],
            'latency_ms' => $result['latency_ms'] ?? null,
            'codex_version' => $result['codex_version'] ?? null,
        ];

        $this->logs->log($this->hostId($host), 'project.assist', [
            'status' => 'generated',
            'slug' => $response['project'],
            'changed_fields' => $response['changed_fields'],
            'latency_ms' => $result['latency_ms'] ?? null,
        ]);

        return $response;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function canonicalAuthPayload(): ?array
    {
        if ($this->runnerValidationService !== null) {
            return $this->runnerValidationService->canonicalAuthSnapshot();
        }

        $payload = $this->payloads->latest();
        if (!is_array($payload)) {
            return null;
        }

        if (isset($payload['body']) && is_string($payload['body']) && trim($payload['body']) !== '') {
            $decoded = json_decode($payload['body'], true);
            if (is_array($decoded)) {
                return $decoded;
            }
        }

        $lastRefresh = isset($payload['last_refresh']) ? trim((string) $payload['last_refresh']) : '';
        $entries = is_array($payload['entries'] ?? null) ? $payload['entries'] : [];
        if ($lastRefresh === '' || $entries === []) {
            return null;
        }

        $auths = [];
        foreach ($entries as $entry) {
            if (!is_array($entry)) {
                continue;
            }

            $target = trim((string) ($entry['target'] ?? ''));
            $token = trim((string) ($entry['token'] ?? ''));
            if ($target === '' || $token === '') {
                continue;
            }

            $item = [
                'token' => $token,
                'token_type' => trim((string) ($entry['token_type'] ?? 'bearer')) ?: 'bearer',
            ];

            foreach (['organization', 'project', 'api_base'] as $key) {
                if (isset($entry[$key]) && is_string($entry[$key]) && trim($entry[$key]) !== '') {
                    $item[$key] = trim((string) $entry[$key]);
                }
            }

            if (is_array($entry['meta'] ?? null)) {
                foreach ($entry['meta'] as $key => $value) {
                    if ((is_scalar($value) || $value === null) && !array_key_exists((string) $key, $item)) {
                        $item[(string) $key] = $value;
                    }
                }
            }

            $auths[$target] = $item;
        }

        if ($auths === []) {
            return null;
        }

        ksort($auths);

        return [
            'last_refresh' => $lastRefresh,
            'auths' => $auths,
        ];
    }

    /**
     * @param array<string, mixed> $detail
     * @return array<string, string>
     */
    private function currentDraftFromDetail(array $detail): array
    {
        $project = is_array($detail['project'] ?? null) ? $detail['project'] : [];
        $about = is_array($project['about'] ?? null) ? $project['about'] : [];

        return [
            'title' => trim((string) ($about['title'] ?? '')),
            'name' => trim((string) ($about['name'] ?? '')),
            'description' => trim((string) ($about['description'] ?? '')),
            'roster_markdown' => trim((string) ($project['roster_markdown'] ?? '')),
        ];
    }

    /**
     * @param array<string, mixed> $detail
     * @return array<string, mixed>
     */
    private function buildRunnerProjectContext(array $detail): array
    {
        $project = is_array($detail['project'] ?? null) ? $detail['project'] : [];
        $about = is_array($project['about'] ?? null) ? $project['about'] : [];

        return [
            'slug' => (string) ($project['slug'] ?? ''),
            'about' => [
                'title' => trim((string) ($about['title'] ?? '')),
                'name' => trim((string) ($about['name'] ?? '')),
                'description' => trim((string) ($about['description'] ?? '')),
            ],
            'roster_markdown' => trim((string) ($project['roster_markdown'] ?? '')),
            'counts' => is_array($project['counts'] ?? null) ? $project['counts'] : [],
            'notes' => $this->sliceItems($detail['notes'] ?? [], ['id', 'header', 'body', 'updated_at'], 6, 800),
            'todos' => $this->sliceItems($detail['todos'] ?? [], ['id', 'title', 'detail', 'done', 'updated_at'], 8, 600),
            'files' => $this->sliceItems($detail['files'] ?? [], ['id', 'stored_name', 'description', 'mime_type', 'size_bytes', 'content'], 6, 900),
            'feedback' => $this->sliceItems($detail['feedback'] ?? [], ['id', 'type', 'title', 'body', 'status', 'updated_at'], 8, 700),
            'recent_changes' => $this->sliceItems($detail['recent_changes'] ?? [], ['seq', 'event_type', 'action', 'payload', 'created_at'], 10, 500),
        ];
    }

    /**
     * @param mixed $items
     * @param list<string> $keys
     * @return list<array<string, mixed>>
     */
    private function sliceItems(mixed $items, array $keys, int $limit, int $textLimit): array
    {
        if (!is_array($items)) {
            return [];
        }

        $trimmed = [];
        foreach (array_slice($items, 0, $limit) as $item) {
            if (!is_array($item)) {
                continue;
            }

            $row = [];
            foreach ($keys as $key) {
                if (!array_key_exists($key, $item)) {
                    continue;
                }

                $value = $item[$key];
                if (is_string($value)) {
                    $row[$key] = $this->truncateText($value, $textLimit);
                    continue;
                }

                if (is_array($value)) {
                    $encoded = json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                    $row[$key] = is_string($encoded) ? $this->truncateText($encoded, $textLimit) : '';
                    continue;
                }

                if (is_scalar($value) || $value === null) {
                    $row[$key] = $value;
                }
            }

            $trimmed[] = $row;
        }

        return $trimmed;
    }

    /**
     * @param array<string, mixed> $result
     * @param array<string, string> $current
     * @return array{about: array<string, string>, roster_markdown: string, changed_fields: list<string>}
     */
    private function buildDraftPayload(array $result, array $current): array
    {
        $about = [];
        $changedFields = [];

        foreach (['title' => 120, 'name' => 120, 'description' => 220] as $field => $maxLen) {
            $value = $this->sanitizeLine($result[$field] ?? null, $maxLen);
            if ($value === null || $value === '' || $value === ($current[$field] ?? '')) {
                continue;
            }

            $about[$field] = $value;
            $changedFields[] = $field;
        }

        $roster = $this->sanitizeBlock($result['roster_markdown'] ?? null, 4000);
        if ($roster === null || $roster === '' || $roster === ($current['roster_markdown'] ?? '')) {
            $roster = '';
        } else {
            $changedFields[] = 'roster_markdown';
        }

        return [
            'about' => $about,
            'roster_markdown' => $roster,
            'changed_fields' => $changedFields,
        ];
    }

    private function sanitizeLine(mixed $value, int $maxLen): ?string
    {
        if (!is_scalar($value) || is_bool($value)) {
            return null;
        }

        $sanitized = preg_replace('/\s+/', ' ', trim((string) $value));
        $sanitized = $sanitized === null ? trim((string) $value) : trim($sanitized);
        $sanitized = trim($sanitized, " \t\n\r`\"'-");
        if ($sanitized === '') {
            return '';
        }

        if (strlen($sanitized) > $maxLen) {
            $sanitized = rtrim(substr($sanitized, 0, $maxLen - 3), " ,;:.") . '...';
        }

        return $sanitized;
    }

    private function sanitizeBlock(mixed $value, int $maxLen): ?string
    {
        if (!is_scalar($value) || is_bool($value)) {
            return null;
        }

        $normalized = str_replace("\r\n", "\n", trim((string) $value));
        if ($normalized === '') {
            return '';
        }

        if (strlen($normalized) > $maxLen) {
            $normalized = rtrim(substr($normalized, 0, $maxLen - 3), " \n\r\t") . '...';
        }

        return $normalized;
    }

    private function truncateText(string $value, int $limit): string
    {
        $text = trim($value);
        if (strlen($text) <= $limit) {
            return $text;
        }

        return rtrim(substr($text, 0, $limit - 3), " \n\r\t") . '...';
    }
}
