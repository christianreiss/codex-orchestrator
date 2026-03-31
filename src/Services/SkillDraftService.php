<?php

declare(strict_types=1);

namespace App\Services;

use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Repositories\AuthPayloadRepository;
use App\Repositories\LogRepository;

class SkillDraftService
{
    public function __construct(
        private readonly AuthPayloadRepository $payloads,
        private readonly LogRepository $logs,
        private readonly SkillManifestService $manifestService,
        private readonly ?RunnerVerifier $runner = null,
        private readonly ?RunnerValidationService $runnerValidationService = null
    ) {
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function generate(array $payload, ?array $host = null): array
    {
        $prompt = trim((string) ($payload['prompt'] ?? ''));
        $slugHint = trim((string) ($payload['slug_hint'] ?? ''));

        if ($prompt === '') {
            throw new ValidationException(['prompt' => ['prompt is required']]);
        }

        if ($this->runner === null) {
            $this->logs->log($this->hostId($host), 'skill.generate', [
                'status' => 'skipped',
                'reason' => 'runner unavailable',
            ]);

            throw new HttpException('Auth runner unavailable', 503);
        }

        $authPayload = $this->canonicalAuthPayload();
        if ($authPayload === null) {
            $this->logs->log($this->hostId($host), 'skill.generate', [
                'status' => 'skipped',
                'reason' => 'canonical auth missing',
            ]);

            throw new HttpException('Canonical auth missing', 503);
        }

        $result = $this->runner->generateSkillDraft($prompt, $authPayload, $slugHint !== '' ? $slugHint : null);
        $status = strtolower(trim((string) ($result['status'] ?? '')));

        if ($status !== 'ok') {
            $this->logs->log($this->hostId($host), 'skill.generate', [
                'status' => 'failed',
                'reason' => $result['reason'] ?? 'generation failed',
                'latency_ms' => $result['latency_ms'] ?? null,
                'reachable' => $result['reachable'] ?? null,
            ]);

            throw new HttpException('Skill generation failed: ' . ($result['reason'] ?? 'runner returned non-ok status'), 502);
        }

        try {
            $draft = $this->manifestService->normalizeDraft($result);
        } catch (ValidationException $exception) {
            $this->logs->log($this->hostId($host), 'skill.generate', [
                'status' => 'failed',
                'reason' => 'invalid runner draft payload',
                'latency_ms' => $result['latency_ms'] ?? null,
            ]);

            throw new HttpException('Skill generation failed: invalid runner draft payload', 502);
        }

        $manifest = $this->manifestService->buildManifest($draft);
        $response = $draft;
        $response['manifest'] = $manifest;
        $response['latency_ms'] = $result['latency_ms'] ?? null;
        $response['codex_version'] = $result['codex_version'] ?? null;

        $this->logs->log($this->hostId($host), 'skill.generate', [
            'status' => 'generated',
            'slug' => $draft['slug'],
            'latency_ms' => $result['latency_ms'] ?? null,
        ]);

        return $response;
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function assist(array $payload, ?array $host = null): array
    {
        $messages = $this->normalizeMessages($payload['messages'] ?? null);
        $mode = strtolower(trim((string) ($payload['mode'] ?? 'new')));
        if ($mode !== 'new' && $mode !== 'edit') {
            throw new ValidationException(['mode' => ['mode must be new or edit']]);
        }

        $currentSkill = $this->normalizeCurrentSkill($payload['skill'] ?? null, $mode);

        if ($this->runner === null) {
            $this->logs->log($this->hostId($host), 'skill.assist', [
                'status' => 'skipped',
                'reason' => 'runner unavailable',
                'mode' => $mode,
            ]);

            throw new HttpException('Auth runner unavailable', 503);
        }

        $authPayload = $this->canonicalAuthPayload();
        if ($authPayload === null) {
            $this->logs->log($this->hostId($host), 'skill.assist', [
                'status' => 'skipped',
                'reason' => 'canonical auth missing',
                'mode' => $mode,
            ]);

            throw new HttpException('Canonical auth missing', 503);
        }

        $result = $this->runner->assistSkillDraft(
            $messages,
            $currentSkill,
            $authPayload,
            $mode,
            $mode === 'edit'
        );
        $status = strtolower(trim((string) ($result['status'] ?? '')));

        if ($status !== 'ok') {
            $this->logs->log($this->hostId($host), 'skill.assist', [
                'status' => 'failed',
                'reason' => $result['reason'] ?? 'assist failed',
                'mode' => $mode,
                'slug' => $currentSkill['slug'] !== '' ? $currentSkill['slug'] : null,
                'latency_ms' => $result['latency_ms'] ?? null,
                'reachable' => $result['reachable'] ?? null,
            ]);

            throw new HttpException('Skill assist failed: ' . ($result['reason'] ?? 'runner returned non-ok status'), 502);
        }

        $assistantMessage = $this->normalizeAssistantMessage($result['assistant_message'] ?? null);
        if ($assistantMessage === null) {
            $this->logs->log($this->hostId($host), 'skill.assist', [
                'status' => 'failed',
                'reason' => 'invalid runner assist payload',
                'mode' => $mode,
                'latency_ms' => $result['latency_ms'] ?? null,
            ]);

            throw new HttpException('Skill assist failed: invalid runner assist payload', 502);
        }

        $draftPayload = [
            'slug' => (string) ($result['slug'] ?? $currentSkill['slug']),
            'display_name' => (string) ($result['display_name'] ?? ''),
            'description' => (string) ($result['description'] ?? ''),
            'tags' => $result['tags'] ?? [],
            'what' => (string) ($result['what'] ?? ''),
            'when' => (string) ($result['when'] ?? ''),
            'steps' => (string) ($result['steps'] ?? ''),
        ];

        if ($mode === 'edit') {
            $draftPayload['slug'] = $currentSkill['slug'];
        }

        try {
            $draft = $this->manifestService->normalizeDraft($draftPayload);
        } catch (ValidationException $exception) {
            $this->logs->log($this->hostId($host), 'skill.assist', [
                'status' => 'failed',
                'reason' => 'invalid runner assist payload',
                'mode' => $mode,
                'latency_ms' => $result['latency_ms'] ?? null,
            ]);

            throw new HttpException('Skill assist failed: invalid runner assist payload', 502);
        }

        $manifest = $this->manifestService->buildManifest($draft);
        $response = $draft;
        $response['assistant_message'] = $assistantMessage;
        $response['manifest'] = $manifest;
        $response['changed_fields'] = $this->diffDraftFields($currentSkill, $draft);
        $response['latency_ms'] = $result['latency_ms'] ?? null;
        $response['codex_version'] = $result['codex_version'] ?? null;

        $this->logs->log($this->hostId($host), 'skill.assist', [
            'status' => 'generated',
            'mode' => $mode,
            'slug' => $draft['slug'],
            'changed_fields' => $response['changed_fields'],
            'latency_ms' => $result['latency_ms'] ?? null,
        ]);

        return $response;
    }

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

            ksort($item);
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
     * @param mixed $value
     * @return array<int, array{role:string,content:string}>
     */
    private function normalizeMessages(mixed $value): array
    {
        if (!is_array($value) || $value === []) {
            throw new ValidationException(['messages' => ['messages must be a non-empty array']]);
        }

        $messages = [];
        foreach ($value as $index => $message) {
            if (!is_array($message)) {
                throw new ValidationException(['messages' => ['messages[' . $index . '] must be an object']]);
            }

            $role = strtolower(trim((string) ($message['role'] ?? '')));
            $content = trim((string) ($message['content'] ?? ''));

            if (!in_array($role, ['user', 'assistant'], true)) {
                throw new ValidationException(['messages' => ['messages[' . $index . '].role must be user or assistant']]);
            }
            if ($content === '') {
                throw new ValidationException(['messages' => ['messages[' . $index . '].content is required']]);
            }

            $messages[] = [
                'role' => $role,
                'content' => $content,
            ];
        }

        return $messages;
    }

    /**
     * @param mixed $value
     * @return array{slug:string,display_name:string,description:string,tags:array<int,string>,what:string,when:string,steps:string}
     */
    private function normalizeCurrentSkill(mixed $value, string $mode): array
    {
        if (!is_array($value)) {
            $value = [];
        }

        $slug = trim((string) ($value['slug'] ?? ''));
        if ($slug !== '') {
            $slug = $this->manifestService->normalizeSlug($slug);
        } elseif ($mode === 'edit') {
            throw new ValidationException(['skill' => ['skill.slug is required for edit mode']]);
        }

        return [
            'slug' => $slug,
            'display_name' => $this->sanitizeLine($value['display_name'] ?? ''),
            'description' => $this->sanitizeLine($value['description'] ?? ''),
            'tags' => $this->sanitizeTags($value['tags'] ?? []),
            'what' => $this->sanitizeSection($value['what'] ?? ''),
            'when' => $this->sanitizeSection($value['when'] ?? ''),
            'steps' => $this->sanitizeSection($value['steps'] ?? ''),
        ];
    }

    /**
     * @param mixed $value
     * @return array<int, string>
     */
    private function sanitizeTags(mixed $value): array
    {
        if (!is_array($value)) {
            return [];
        }

        $tags = [];
        foreach ($value as $tag) {
            if (!is_string($tag)) {
                continue;
            }

            $normalized = $this->sanitizeLine($tag);
            if ($normalized === '' || in_array($normalized, $tags, true)) {
                continue;
            }
            $tags[] = $normalized;
        }

        return $tags;
    }

    private function sanitizeLine(mixed $value): string
    {
        if (!is_string($value)) {
            return '';
        }

        return trim((string) preg_replace('/\s+/', ' ', $value));
    }

    private function sanitizeSection(mixed $value): string
    {
        if (!is_string($value)) {
            return '';
        }

        return trim(str_replace("\r\n", "\n", $value));
    }

    private function normalizeAssistantMessage(mixed $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }

        $normalized = trim(preg_replace('/\s+/', ' ', $value) ?? '');
        if ($normalized === '') {
            return null;
        }

        return $normalized;
    }

    /**
     * @param array{slug:string,display_name:string,description:string,tags:array<int,string>,what:string,when:string,steps:string} $before
     * @param array{slug:string,display_name:string,description:string,tags:array<int,string>,what:string,when:string,steps:string} $after
     * @return array<int, string>
     */
    private function diffDraftFields(array $before, array $after): array
    {
        $changed = [];
        foreach (['slug', 'display_name', 'description', 'tags', 'what', 'when', 'steps'] as $field) {
            if (($before[$field] ?? null) !== ($after[$field] ?? null)) {
                $changed[] = $field;
            }
        }

        return $changed;
    }

    private function hostId(?array $host): ?int
    {
        if (!is_array($host) || !isset($host['id']) || !is_numeric($host['id'])) {
            return null;
        }

        return (int) $host['id'];
    }
}
