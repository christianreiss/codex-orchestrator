<?php

declare(strict_types=1);

namespace App\Mcp;

use App\Services\SkillService;
use App\Services\MemoryService;
use App\Services\ProjectCoordinationService;
use InvalidArgumentException;

class McpServer
{
    public const TOOL_NAME_PATTERN = '/^[a-zA-Z0-9_-]+$/';
    public const CAPABILITY_HOST = 'host';
    public const CAPABILITY_OPERATOR = 'operator';

    private readonly MemoryService $memories;
    private readonly McpToolDefinitions $toolDefinitions;
    private readonly McpFileOperations $fileOperations;
    private readonly McpResourceHandler $resourceHandler;

    public function __construct(
        MemoryService $memories,
        ProjectCoordinationService|string|null $projectsOrRoot = null,
        SkillService|string|null $skillsOrRoot = null,
        ?string $root = null
    ) {
        $this->memories = $memories;

        // Resolve the overloaded constructor arguments.
        if (is_string($projectsOrRoot) && $skillsOrRoot === null && $root === null) {
            $projects = null;
            $skills = null;
            $resolvedRoot = $projectsOrRoot;
        } else {
            $projects = $projectsOrRoot instanceof ProjectCoordinationService ? $projectsOrRoot : null;
            $skills = $skillsOrRoot instanceof SkillService ? $skillsOrRoot : null;
            $resolvedRoot = is_string($skillsOrRoot) && $root === null ? $skillsOrRoot : $root;
        }

        $this->toolDefinitions = new McpToolDefinitions($projects);
        $this->fileOperations = new McpFileOperations($resolvedRoot, $skills);
        $this->resourceHandler = new McpResourceHandler($memories, $projects, $skills);
    }

    /**
     * List MCP tools with names that satisfy the OpenAI/MCP tool-name pattern.
     *
     * @return array<int, array{name:string,description:string,inputSchema:array}>
     */
    public function listTools(string $capability = self::CAPABILITY_OPERATOR): array
    {
        $this->assertCapability($capability);

        $tools = [];
        foreach ($this->toolDefinitions->definitions($capability) as $name => $definition) {
            if (!preg_match(self::TOOL_NAME_PATTERN, $name)) {
                throw new InvalidArgumentException('MCP tool name violates pattern: ' . $name);
            }

            $tools[] = [
                'name' => $name,
                'description' => $definition['description'],
                'inputSchema' => $definition['inputSchema'],
            ];
        }

        return $tools;
    }

    /**
     * Dispatch a tool call to the underlying service.
     *
     * @param array<string,mixed> $args
     * @param array<string,mixed> $host
     * @return array<string,mixed>
     */
    public function dispatch(string $name, mixed $args, array $host, string $capability = self::CAPABILITY_OPERATOR): array
    {
        $this->assertCapability($capability);
        $normalized = $this->normalizeName($name);
        if (!$this->toolDefinitions->capabilityAllowsTool($capability, $normalized)) {
            throw new McpToolNotFoundException($name);
        }

        // Allow shorthand string payloads per tool for convenience.
        if (!is_array($args)) {
            $scalar = (string) $args;
            $args = match ($normalized) {
                'memory_store' => ['content' => $scalar],
                'memory_retrieve' => ['id' => $scalar],
                'memory_search' => ['query' => $scalar],
                'fs_read_file' => ['path' => $scalar],
                'fs_write_file' => ['path' => $scalar, 'content' => ''],
                'fs_list_dir' => ['path' => $scalar],
                'fs_file_exists' => ['path' => $scalar],
                'fs_stat' => ['path' => $scalar],
                'fs_search_in_files' => ['root' => $scalar, 'pattern' => ''],
                'memory_append' => ['resource_id' => $scalar, 'text' => ''],
                'memory_query' => ['resource_id' => $scalar, 'query' => ''],
                'memory_list' => ['resource_id' => $scalar],
                'project_create' => ['slug' => $scalar],
                'project_detail' => ['slug' => $scalar],
                'project_bootstrap' => ['slug' => $scalar],
                'project_changes' => ['slug' => $scalar],
                'resource_read' => ['uri' => $scalar],
                'resource_create' => ['uri' => $scalar],
                'resource_update' => ['uri' => $scalar],
                'resource_delete' => ['uri' => $scalar],
                'resource_list' => ['root' => $scalar],
                default => ['value' => $scalar],
            };
        }

        $result = match ($normalized) {
            'memory_store' => $this->memories->store($args, $host),
            'memory_retrieve' => $this->memories->retrieve($args, $host),
            'memory_search' => $this->memories->search($args, $host),
            'fs_read_file' => $this->fileOperations->readFile($args),
            'fs_write_file' => $this->fileOperations->writeFile($args),
            'fs_list_dir' => $this->fileOperations->listDir($args),
            'fs_file_exists' => $this->fileOperations->statPath($args, false),
            'fs_stat' => $this->fileOperations->statPath($args, true),
            'fs_search_in_files' => $this->fileOperations->searchInFiles($args),
            'memory_append' => $this->resourceHandler->memoryAppend($args, $host),
            'memory_query' => $this->resourceHandler->memoryQuery($args, $host),
            'memory_list' => $this->resourceHandler->memoryList($args, $host),
            'project_list' => $this->resourceHandler->projectList($host),
            'project_create' => $this->resourceHandler->projectCreateTool($args, $host),
            'project_detail' => $this->resourceHandler->projectDetailTool($args, $host),
            'project_bootstrap' => $this->resourceHandler->projectBootstrapTool($args, $host),
            'project_changes' => $this->resourceHandler->projectChangesTool($args, $host),
            'project_note_upsert' => $this->resourceHandler->projectNoteUpsertTool($args, $host),
            'project_todo_create' => $this->resourceHandler->projectTodoCreateTool($args, $host),
            'project_todo_update' => $this->resourceHandler->projectTodoUpdateTool($args, $host),
            'project_todo_done' => $this->resourceHandler->projectTodoDoneTool($args, $host, true),
            'project_todo_undone' => $this->resourceHandler->projectTodoDoneTool($args, $host, false),
            'project_file_upsert' => $this->resourceHandler->projectFileUpsertTool($args, $host),
            'project_feedback_create' => $this->resourceHandler->projectFeedbackCreateTool($args, $host),
            'resource_read' => $this->resourceHandler->readResourceTool($args, $host),
            'resource_create' => $this->resourceHandler->createResourceTool($args, $host),
            'resource_update' => $this->resourceHandler->updateResourceTool($args, $host),
            'resource_delete' => $this->resourceHandler->deleteResourceTool($args, $host),
            'resource_list' => $this->resourceHandler->listResourcesTool($host),
            default => throw new McpToolNotFoundException($name),
        };

        if (
            str_starts_with($normalized, 'memory_')
            || str_starts_with($normalized, 'fs_')
            || str_starts_with($normalized, 'resource_')
            || str_starts_with($normalized, 'project_')
        ) {
            return $this->wrapContent($result);
        }

        return $result;
    }

    /**
     * Normalize tool names for dispatch while enforcing the MCP pattern.
     */
    public function normalizeName(string $name): string
    {
        $normalized = str_replace('.', '_', trim($name));
        if ($normalized === '') {
            throw new InvalidArgumentException('Tool name is required');
        }

        if (!preg_match(self::TOOL_NAME_PATTERN, $normalized)) {
            throw new InvalidArgumentException('Tool name must match ' . self::TOOL_NAME_PATTERN);
        }

        return $normalized;
    }

    public function wrapContent(mixed $data, bool $isError = false): array
    {
        if (is_array($data) && array_key_exists('content', $data) && is_array($data['content'])) {
            if (!array_key_exists('isError', $data)) {
                $data['isError'] = $isError;
            } elseif ($isError) {
                $data['isError'] = true;
            }

            return $data;
        }

        $text = is_string($data)
            ? $data
            : json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        if ($text === false) {
            $text = '{}';
        }

        return [
            'isError' => $isError,
            'content' => [
                [
                    'type' => 'text',
                    'text' => $text ?? '',
                ],
            ],
        ];
    }

    /**
     * List resource templates (parameterized resources) available from this server.
     *
     * @return array<int, array<string,mixed>>
     */
    public function listResourceTemplates(): array
    {
        return $this->resourceHandler->listResourceTemplates();
    }

    /**
     * List concrete resources to help clients browse without arguments.
     *
     * @param array<string,mixed> $host
     * @return array<int, array<string,mixed>>
     */
    public function listResources(array $host): array
    {
        return $this->resourceHandler->listResources($host);
    }

    /**
     * Read a resource URI and return contents.
     *
     * @param array<string,mixed> $host
     * @return array<string,mixed>
     */
    public function readResource(string $uri, array $host): array
    {
        return $this->resourceHandler->readResource($uri, $host);
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
        return $this->resourceHandler->createResource($uri, $params, $host);
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
        return $this->resourceHandler->updateResource($uri, $params, $host);
    }

    /**
     * Delete a resource (memory) by URI.
     *
     * @param array<string,mixed> $host
     * @return array<string,mixed>
     */
    public function deleteResource(string $uri, array $host): array
    {
        return $this->resourceHandler->deleteResource($uri, $host);
    }

    private function assertCapability(string $capability): void
    {
        if (!in_array($capability, [self::CAPABILITY_HOST, self::CAPABILITY_OPERATOR], true)) {
            throw new InvalidArgumentException('Unknown MCP capability: ' . $capability);
        }
    }
}
