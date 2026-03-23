<?php

declare(strict_types=1);

namespace App\Mcp;

use App\Services\MemoryService;
use App\Services\ProjectCoordinationService;
use App\Services\SkillService;
use InvalidArgumentException;

class McpResourceHandler
{
    private readonly MemoryService $memories;
    private readonly ?ProjectCoordinationService $projects;
    private readonly ?SkillService $skills;

    public function __construct(
        MemoryService $memories,
        ?ProjectCoordinationService $projects = null,
        ?SkillService $skills = null
    ) {
        $this->memories = $memories;
        $this->projects = $projects;
        $this->skills = $skills;
    }

    /**
     * List resource templates (parameterized resources) available from this server.
     *
     * @return array<int, array<string,mixed>>
     */
    public function listResourceTemplates(): array
    {
        $templates = [
            [
                'name' => 'memory_by_id',
                'description' => 'Read a stored memory by id/key',
                'uriTemplate' => 'memory://{id}',
                'mimeType' => 'text/plain',
                'arguments' => [
                    [
                        'name' => 'id',
                        'description' => 'Memory id/key (letters, numbers, dot/underscore/dash/colon)',
                        'required' => true,
                    ],
                ],
            ],
            [
                'name' => 'memory_store',
                'description' => 'A persistent vector/text memory store for Codex',
                'uriTemplate' => 'memory://{scope}:{name}',
                'mimeType' => 'text/plain',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'scope' => [
                            'type' => 'string',
                            'enum' => ['project', 'host', 'global'],
                        ],
                        'name' => ['type' => 'string'],
                    ],
                    'required' => ['scope', 'name'],
                ],
            ],
            [
                'name' => 'skill_manifest',
                'description' => 'Read a synced skill manifest by slug',
                'uriTemplate' => 'skill://{slug}',
                'mimeType' => 'text/markdown',
                'arguments' => [
                    [
                        'name' => 'slug',
                        'description' => 'Skill slug',
                        'required' => true,
                    ],
                ],
            ],
        ];

        if ($this->projectsEnabled()) {
            $templates[] = [
                'name' => 'project_bootstrap',
                'description' => 'Read compact shared project bootstrap context',
                'uriTemplate' => 'project://{slug}',
                'mimeType' => 'application/json',
                'arguments' => [
                    [
                        'name' => 'slug',
                        'description' => 'Project slug',
                        'required' => true,
                    ],
                ],
            ];
        }

        return $templates;
    }

    /**
     * List concrete resources (currently recent memories) to help clients browse without arguments.
     *
     * @param array<string,mixed> $host
     * @return array<int, array<string,mixed>>
     */
    public function listResources(array $host): array
    {
        $result = $this->memories->search(['query' => '', 'limit' => 20], $host);
        $resources = [];
        foreach ($result['matches'] ?? [] as $row) {
            $id = (string) ($row['id'] ?? '');
            if ($id === '') {
                continue;
            }
            $resources[] = [
                'uri' => $this->memoryUri($id),
                'name' => $id,
                'description' => $this->truncateDescription($row['content'] ?? ''),
                'mimeType' => 'text/plain',
            ];
        }

        foreach ($this->skillResourceList($host) as $resource) {
            $resources[] = $resource;
        }

        if ($this->projectsEnabled()) {
            foreach ($this->projects?->projectResourceList($host) ?? [] as $resource) {
                $resources[] = $resource;
            }
        }

        return $resources;
    }

    /**
     * Read a resource URI and return contents.
     *
     * @param array<string,mixed> $host
     * @return array<string,mixed>
     */
    public function readResource(string $uri, array $host): array
    {
        $projectSlug = $this->parseProjectUri($uri);
        if ($projectSlug !== null) {
            if (!$this->projectsEnabled()) {
                throw new InvalidArgumentException('Project coordination is disabled');
            }

            return $this->projects?->projectResourceRead($projectSlug, $host) ?? [
                'contents' => [],
            ];
        }

        $skillSlug = $this->parseSkillUri($uri);
        if ($skillSlug !== null) {
            $skill = $this->skills?->find($skillSlug);
            if ($skill === null) {
                throw new InvalidArgumentException('Resource not found: ' . $uri);
            }

            return [
                'contents' => [
                    [
                        'uri' => $this->skillUri($skillSlug),
                        'name' => (string) ($skill['display_name'] ?? $skillSlug),
                        'description' => (string) ($skill['description'] ?? 'Stored skill manifest'),
                        'mimeType' => 'text/markdown',
                        'text' => (string) ($skill['manifest'] ?? ''),
                    ],
                ],
            ];
        }

        $id = $this->parseMemoryUri($uri);
        if ($id === null) {
            throw new InvalidArgumentException('Unsupported resource URI: ' . $uri);
        }

        $result = $this->memories->retrieve(['id' => $id], $host);
        if (($result['status'] ?? '') !== 'found' || !isset($result['memory'])) {
            throw new InvalidArgumentException('Resource not found: ' . $uri);
        }

        $memory = $result['memory'];
        $content = (string) ($memory['content'] ?? '');

        return [
            'contents' => [
                [
                    'uri' => $this->memoryUri($id),
                    'name' => $id,
                    'description' => 'Stored memory',
                    'mimeType' => 'text/plain',
                    'text' => $content,
                ],
            ],
        ];
    }

    /**
     * Create a resource (memory) from a resource URI + text content.
     *
     * @param array<string,mixed> $params
     * @param array<string,mixed> $host
     * @return array<string,mixed>
     */
    public function createResource(string $uri, array $params, array $host): array
    {
        $id = $this->parseMemoryUri($uri);
        if ($id === null) {
            throw new InvalidArgumentException('Unsupported resource URI: ' . $uri);
        }

        $text = $this->extractTextContent($params);
        if ($text === null || trim($text) === '') {
            throw new InvalidArgumentException('text content is required');
        }

        $result = $this->memories->store(['id' => $id, 'content' => $text], $host);

        return [
            'resource' => [
                'uri' => $this->memoryUri($id),
                'name' => $id,
                'description' => $this->truncateDescription($text),
                'mimeType' => 'text/plain',
                'result' => $result,
            ],
        ];
    }

    /**
     * Update an existing resource (memory) by URI.
     *
     * @param array<string,mixed> $params
     * @param array<string,mixed> $host
     * @return array<string,mixed>
     */
    public function updateResource(string $uri, array $params, array $host): array
    {
        $id = $this->parseMemoryUri($uri);
        if ($id === null) {
            throw new InvalidArgumentException('Unsupported resource URI: ' . $uri);
        }

        $text = $this->extractTextContent($params);
        if ($text === null || trim($text) === '') {
            throw new InvalidArgumentException('text content is required');
        }

        $result = $this->memories->store(['id' => $id, 'content' => $text], $host);

        return [
            'resource' => [
                'uri' => $this->memoryUri($id),
                'name' => $id,
                'description' => $this->truncateDescription($text),
                'mimeType' => 'text/plain',
                'result' => $result,
            ],
        ];
    }

    /**
     * Delete a resource (memory) by URI.
     *
     * @param array<string,mixed> $host
     * @return array<string,mixed>
     */
    public function deleteResource(string $uri, array $host): array
    {
        $id = $this->parseMemoryUri($uri);
        if ($id === null) {
            throw new InvalidArgumentException('Unsupported resource URI: ' . $uri);
        }

        $result = $this->memories->delete(['id' => $id], $host);
        if (($result['status'] ?? '') !== 'deleted') {
            throw new InvalidArgumentException('Resource not found: ' . $uri);
        }

        return [
            'resource' => [
                'uri' => $this->memoryUri($id),
                'name' => $id,
                'deleted' => true,
            ],
        ];
    }

    /**
     * Resource tool helpers for dispatch.
     */
    public function readResourceTool(array $params, array $host): array
    {
        $uri = $this->normalizeString($params['uri'] ?? null);
        if ($uri === null || $uri === '') {
            throw new InvalidArgumentException('uri is required');
        }

        return $this->readResource($uri, $host);
    }

    public function createResourceTool(array $params, array $host): array
    {
        $uri = $this->normalizeString($params['uri'] ?? null);
        $text = $this->normalizeString($params['text'] ?? null);
        if ($uri === null || $uri === '') {
            throw new InvalidArgumentException('uri is required');
        }
        if ($text === null || $text === '') {
            throw new InvalidArgumentException('text is required');
        }

        return $this->createResource($uri, ['text' => $text], $host);
    }

    public function updateResourceTool(array $params, array $host): array
    {
        $uri = $this->normalizeString($params['uri'] ?? null);
        $text = $this->normalizeString($params['text'] ?? null);
        if ($uri === null || $uri === '') {
            throw new InvalidArgumentException('uri is required');
        }
        if ($text === null || $text === '') {
            throw new InvalidArgumentException('text is required');
        }

        return $this->updateResource($uri, ['text' => $text], $host);
    }

    public function deleteResourceTool(array $params, array $host): array
    {
        $uri = $this->normalizeString($params['uri'] ?? null);
        if ($uri === null || $uri === '') {
            throw new InvalidArgumentException('uri is required');
        }

        return $this->deleteResource($uri, $host);
    }

    public function listResourcesTool(array $host): array
    {
        return $this->listResources($host);
    }

    /**
     * Append a memory entry under a resource id (namespaced by a generated key).
     *
     * @param array<string,mixed> $params
     * @param array<string,mixed> $host
     * @return array<string,mixed>
     */
    public function memoryAppend(array $params, array $host): array
    {
        $resourceId = $this->sanitizeResourceId((string) ($params['resource_id'] ?? ''));
        $text = isset($params['text']) ? trim((string) $params['text']) : '';
        if ($text === '') {
            throw new InvalidArgumentException('text is required');
        }

        $tags = [];
        if (isset($params['tags']) && is_array($params['tags'])) {
            foreach ($params['tags'] as $tag) {
                if (is_string($tag) && trim($tag) !== '') {
                    $tags[] = trim($tag);
                }
            }
        }
        $tags[] = 'resource:' . $resourceId;

        $key = $resourceId . ':' . bin2hex(random_bytes(4));
        $result = $this->memories->store([
            'id' => $key,
            'content' => $text,
            'tags' => $tags,
        ], $host);

        return [
            'status' => $result['status'] ?? 'ok',
            'id' => $result['id'] ?? $key,
            'memory' => $result['memory'] ?? null,
        ];
    }

    /**
     * Query memories for a resource id.
     *
     * @param array<string,mixed> $params
     * @param array<string,mixed> $host
     * @return array<string,mixed>
     */
    public function memoryQuery(array $params, array $host): array
    {
        $resourceId = $this->sanitizeResourceId((string) ($params['resource_id'] ?? ''));
        $query = isset($params['query']) ? trim((string) $params['query']) : '';
        if ($query === '') {
            throw new InvalidArgumentException('query is required');
        }

        $topK = 5;
        if (isset($params['top_k']) && is_numeric($params['top_k'])) {
            $topK = max(1, min(50, (int) $params['top_k']));
        }

        $result = $this->memories->search([
            'query' => $query,
            'tags' => ['resource:' . $resourceId],
            'limit' => $topK,
        ], $host);

        return $result;
    }

    /**
     * List recent memories for a resource id.
     *
     * @param array<string,mixed> $params
     * @param array<string,mixed> $host
     * @return array<string,mixed>
     */
    public function memoryList(array $params, array $host): array
    {
        $resourceId = $this->sanitizeResourceId((string) ($params['resource_id'] ?? ''));

        $topK = 20;
        if (isset($params['top_k']) && is_numeric($params['top_k'])) {
            $topK = max(1, min(100, (int) $params['top_k']));
        }

        $result = $this->memories->search([
            'query' => '',
            'tags' => ['resource:' . $resourceId],
            'limit' => $topK,
        ], $host);

        return $result;
    }

    /**
     * Project tool methods.
     */
    public function projectList(array $host): array
    {
        if (!$this->projectsEnabled()) {
            throw new InvalidArgumentException('Project coordination is disabled');
        }

        return $this->projects?->listProjects($host) ?? ['projects' => []];
    }

    public function projectCreateTool(array $params, array $host): array
    {
        $slug = $this->requireProjectSlug($params);

        return $this->projects?->createProject($params + ['slug' => $slug], $host) ?? [];
    }

    public function projectDetailTool(array $params, array $host): array
    {
        $slug = $this->requireProjectSlug($params);
        return $this->projects?->projectDetail($slug, $host) ?? [];
    }

    public function projectBootstrapTool(array $params, array $host): array
    {
        $slug = $this->requireProjectSlug($params);
        return $this->projects?->bootstrap($slug, $host) ?? [];
    }

    public function projectChangesTool(array $params, array $host): array
    {
        $slug = $this->requireProjectSlug($params);
        $since = isset($params['since']) && is_numeric($params['since']) ? max(0, (int) $params['since']) : 0;

        return $this->projects?->listChanges($slug, $since, $host) ?? [];
    }

    public function projectNoteUpsertTool(array $params, array $host): array
    {
        $slug = $this->requireProjectSlug($params);
        $id = isset($params['id']) && is_numeric($params['id']) ? (int) $params['id'] : null;

        return $this->projects?->upsertNote($slug, $id, $params, $host) ?? [];
    }

    public function projectTodoCreateTool(array $params, array $host): array
    {
        $slug = $this->requireProjectSlug($params);
        return $this->projects?->createTodo($slug, $params, $host) ?? [];
    }

    public function projectTodoUpdateTool(array $params, array $host): array
    {
        $slug = $this->requireProjectSlug($params);
        $id = isset($params['id']) && is_numeric($params['id']) ? (int) $params['id'] : 0;
        if ($id <= 0) {
            throw new InvalidArgumentException('id is required');
        }

        return $this->projects?->updateTodo($slug, $id, $params, $host) ?? [];
    }

    public function projectTodoDoneTool(array $params, array $host, bool $done): array
    {
        $slug = $this->requireProjectSlug($params);
        $id = isset($params['id']) && is_numeric($params['id']) ? (int) $params['id'] : 0;
        if ($id <= 0) {
            throw new InvalidArgumentException('id is required');
        }

        return $this->projects?->setTodoDone($slug, $id, $done, $host) ?? [];
    }

    public function projectFileUpsertTool(array $params, array $host): array
    {
        $slug = $this->requireProjectSlug($params);
        return $this->projects?->upsertFile($slug, $params, $host) ?? [];
    }

    public function projectFeedbackCreateTool(array $params, array $host): array
    {
        $slug = $this->requireProjectSlug($params);
        return $this->projects?->createFeedback($slug, $params, $host) ?? [];
    }

    // --- Private helpers ---

    private function memoryUri(string $id): string
    {
        return 'memory://' . rawurlencode($id);
    }

    private function projectUri(string $slug): string
    {
        return 'project://' . rawurlencode($slug);
    }

    private function skillUri(string $slug): string
    {
        return 'skill://' . rawurlencode($slug);
    }

    private function parseMemoryUri(string $uri): ?string
    {
        $prefix = 'memory://';
        if (!str_starts_with($uri, $prefix)) {
            return null;
        }

        $id = substr($uri, strlen($prefix));
        $decoded = rawurldecode($id);
        return $decoded === '' ? null : $decoded;
    }

    private function parseProjectUri(string $uri): ?string
    {
        $prefix = 'project://';
        if (!str_starts_with($uri, $prefix)) {
            return null;
        }

        $slug = rawurldecode(substr($uri, strlen($prefix)));
        return $slug === '' ? null : $slug;
    }

    private function parseSkillUri(string $uri): ?string
    {
        $prefix = 'skill://';
        if (!str_starts_with($uri, $prefix)) {
            return null;
        }

        $slug = rawurldecode(substr($uri, strlen($prefix)));
        return $slug === '' ? null : $slug;
    }

    /**
     * @param array<string,mixed> $host
     * @return array<int, array<string,mixed>>
     */
    private function skillResourceList(array $host): array
    {
        if ($this->skills === null) {
            return [];
        }

        $resources = [];
        foreach ($this->skills->listSkills($host, false) as $skill) {
            $slug = trim((string) ($skill['slug'] ?? ''));
            if ($slug === '') {
                continue;
            }

            $resources[] = [
                'uri' => $this->skillUri($slug),
                'name' => (string) ($skill['display_name'] ?? $slug),
                'description' => (string) ($skill['description'] ?? 'Skill manifest'),
                'mimeType' => 'text/markdown',
            ];
        }

        return $resources;
    }

    private function extractTextContent(array $params): ?string
    {
        if (isset($params['text']) && is_string($params['text'])) {
            return $params['text'];
        }

        if (isset($params['contents']) && is_array($params['contents']) && $params['contents']) {
            $first = $params['contents'][0];
            if (is_array($first) && isset($first['text']) && is_string($first['text'])) {
                return $first['text'];
            }
        }

        return null;
    }

    private function truncateDescription(string $value): string
    {
        $trimmed = trim($value);
        if (strlen($trimmed) <= 80) {
            return $trimmed;
        }

        return substr($trimmed, 0, 77) . '...';
    }

    private function sanitizeResourceId(string $value): string
    {
        $trimmed = trim($value);
        if ($trimmed === '') {
            throw new InvalidArgumentException('resource_id is required');
        }
        if (!preg_match('/^[A-Za-z0-9._:-]+$/', $trimmed)) {
            throw new InvalidArgumentException('resource_id may only contain letters, numbers, dots, underscores, hyphens, and colons');
        }
        return $trimmed;
    }

    private function requireProjectSlug(array $params): string
    {
        $slug = $this->normalizeString($params['slug'] ?? ($params['project'] ?? null));
        if ($slug === null) {
            throw new InvalidArgumentException('slug is required');
        }

        if (!$this->projectsEnabled()) {
            throw new InvalidArgumentException('Project coordination is disabled');
        }

        return $slug;
    }

    private function projectsEnabled(): bool
    {
        return $this->projects !== null && (($this->projects->adminState()['enabled'] ?? false) === true);
    }

    private function normalizeString(mixed $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }
        $trimmed = trim($value);
        return $trimmed === '' ? null : $trimmed;
    }
}
