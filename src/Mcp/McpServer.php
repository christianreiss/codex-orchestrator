<?php

declare(strict_types=1);

namespace App\Mcp;

use App\Services\MemoryService;
use InvalidArgumentException;

class McpServer
{
    public const TOOL_NAME_PATTERN = '/^[a-zA-Z0-9_-]+$/';

    public function __construct(
        private readonly MemoryService $memories,
        private readonly ?string $root = null
    ) {
    }

    /**
     * List MCP tools with names that satisfy the OpenAI/MCP tool-name pattern.
     *
     * @return array<int, array{name:string,description:string,inputSchema:array}>
     */
    public function listTools(): array
    {
        $tools = [];
        foreach ($this->definitions() as $name => $definition) {
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
    public function dispatch(string $name, mixed $args, array $host): array
    {
        $normalized = $this->normalizeName($name);

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
            'fs_read_file' => $this->readFile($args),
            'fs_write_file' => $this->writeFile($args),
            'fs_list_dir' => $this->listDir($args),
            'fs_file_exists' => $this->statPath($args, false),
            'fs_stat' => $this->statPath($args, true),
            'fs_search_in_files' => $this->searchInFiles($args),
            'memory_append' => $this->memoryAppend($args, $host),
            'memory_query' => $this->memoryQuery($args, $host),
            'memory_list' => $this->memoryList($args, $host),
            'resource_read' => $this->readResourceTool($args, $host),
            'resource_create' => $this->createResourceTool($args, $host),
            'resource_update' => $this->updateResourceTool($args, $host),
            'resource_delete' => $this->deleteResourceTool($args, $host),
            'resource_list' => $this->listResourcesTool($host),
            default => throw new McpToolNotFoundException($name),
        };

        if (str_starts_with($normalized, 'memory_') || str_starts_with($normalized, 'fs_') || str_starts_with($normalized, 'resource_')) {
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

    /**
     * @return array<string, array{description:string,inputSchema:array}>
     */
    private function definitions(): array
    {
        return [
            'memory_store' => [
                'description' => 'Store MCP memory content with optional tags and metadata',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'content' => ['type' => 'string'],
                        'tags' => ['type' => 'array', 'items' => ['type' => 'string']],
                        'metadata' => ['type' => 'object'],
                    ],
                    'required' => ['content'],
                ],
            ],
            'memory_retrieve' => [
                'description' => 'Retrieve a stored memory by id',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'id' => ['type' => 'string'],
                    ],
                    'required' => ['id'],
                ],
            ],
            'memory_search' => [
                'description' => 'Search stored memories by full-text query and optional tags',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'query' => ['type' => 'string'],
                        'tags' => ['type' => 'array', 'items' => ['type' => 'string']],
                        'limit' => ['type' => 'integer'],
                    ],
                    'required' => ['query'],
                ],
            ],
            'fs_read_file' => [
                'description' => 'Read a text file from the coordinator filesystem (paths are rooted to the app directory)',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'path' => ['type' => 'string'],
                    ],
                    'required' => ['path'],
                ],
            ],
            'fs_write_file' => [
                'description' => 'Write a text file within the coordinator filesystem (rooted to the app directory)',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'path' => ['type' => 'string'],
                        'content' => ['type' => 'string'],
                        'create_if_missing' => ['type' => 'boolean'],
                        'overwrite' => ['type' => 'boolean'],
                    ],
                    'required' => ['path', 'content'],
                ],
            ],
            'fs_list_dir' => [
                'description' => 'List directory entries rooted to the app directory (optional glob filter)',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'path' => ['type' => 'string'],
                        'glob' => ['type' => 'string'],
                    ],
                    'required' => ['path'],
                ],
            ],
            'fs_file_exists' => [
                'description' => 'Check whether a path exists under the app root and return basic metadata',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'path' => ['type' => 'string'],
                    ],
                    'required' => ['path'],
                ],
            ],
            'fs_stat' => [
                'description' => 'Stat a path under the app root and return type/size/mtime (requires existence)',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'path' => ['type' => 'string'],
                    ],
                    'required' => ['path'],
                ],
            ],
            'fs_search_in_files' => [
                'description' => 'Search for a string within files under a root path (optional glob filters)',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'root' => ['type' => 'string'],
                        'pattern' => ['type' => 'string'],
                        'file_glob' => ['type' => 'array', 'items' => ['type' => 'string']],
                        'max_results' => ['type' => 'integer'],
                    ],
                    'required' => ['root', 'pattern'],
                ],
            ],
            'resource_read' => [
                'description' => 'Read a resource URI (memory://*)',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'uri' => ['type' => 'string'],
                    ],
                    'required' => ['uri'],
                ],
            ],
            'resource_create' => [
                'description' => 'Create a resource (memory) at a URI with text content',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'uri' => ['type' => 'string'],
                        'text' => ['type' => 'string'],
                    ],
                    'required' => ['uri', 'text'],
                ],
            ],
            'resource_update' => [
                'description' => 'Update a resource (memory) at a URI with text content',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'uri' => ['type' => 'string'],
                        'text' => ['type' => 'string'],
                    ],
                    'required' => ['uri', 'text'],
                ],
            ],
            'resource_delete' => [
                'description' => 'Delete a resource (memory) at a URI',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'uri' => ['type' => 'string'],
                    ],
                    'required' => ['uri'],
                ],
            ],
            'resource_list' => [
                'description' => 'List recent resources for the host',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'root' => ['type' => 'string'],
                    ],
                ],
            ],
            'memory_append' => [
                'description' => 'Append a note to a resource-scoped memory',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'resource_id' => ['type' => 'string'],
                        'text' => ['type' => 'string'],
                        'tags' => ['type' => 'array', 'items' => ['type' => 'string']],
                    ],
                    'required' => ['resource_id', 'text'],
                ],
            ],
            'memory_query' => [
                'description' => 'Query notes for a resource id',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'resource_id' => ['type' => 'string'],
                        'query' => ['type' => 'string'],
                        'top_k' => ['type' => 'integer'],
                    ],
                    'required' => ['resource_id', 'query'],
                ],
            ],
            'memory_list' => [
                'description' => 'List recent notes for a resource id',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'resource_id' => ['type' => 'string'],
                        'top_k' => ['type' => 'integer'],
                    ],
                    'required' => ['resource_id'],
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
        return [
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
                'uriTemplate' => 'memory://{scope}/{name}',
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
        ];
    }

    /**
     * List concrete resources (currently recent memories) to help clients browse without arguments.
     *
     * @param array<string,mixed> $host
     * @return array<int, array<string,mixed>>
     */
    public function listResources(array $host): array
    {
        // Reuse memory search with empty query to surface recent entries; capped to 20 to avoid noisy payloads.
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

        return $resources;
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
     * Accepts text via params['text'] or params['contents'][0]['text'].
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

        // Soft-delete via store with empty content? Instead, mark deleted at repository level would be ideal;
        // for now, overwrite with empty content to signal removal while keeping audit trail.
        $result = $this->memories->store(['id' => $id, 'content' => ''], $host);

        return [
            'resource' => [
                'uri' => $this->memoryUri($id),
                'name' => $id,
                'deleted' => true,
                'result' => $result,
            ],
        ];
    }

    /**
     * Read a resource URI and return contents (currently memory://{id}).
     *
     * @param array<string,mixed> $host
     * @return array<string,mixed>
     */
    public function readResource(string $uri, array $host): array
    {
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

    private function memoryUri(string $id): string
    {
        return 'memory://' . rawurlencode($id);
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

    /**
     * Read a file within the allowed root and return its text content + metadata.
     *
     * @param array{path?:mixed} $args
     * @return array<string,mixed>
     */
    private function readFile(array $args): array
    {
        $pathRaw = $args['path'] ?? null;
        if (!is_string($pathRaw)) {
            throw new InvalidArgumentException('path is required');
        }

        $root = $this->root ?? dirname(__DIR__, 2);
        $path = trim($pathRaw);
        if ($path === '') {
            throw new InvalidArgumentException('path is required');
        }

        // Resolve path against root and block traversal outside it.
        $candidate = str_starts_with($path, '/') ? $path : $root . '/' . $path;
        $real = realpath($candidate);
        if ($real === false) {
            throw new InvalidArgumentException('file not found');
        }

        $realRoot = realpath($root) ?: $root;
        if ($real !== $realRoot && !str_starts_with($real, rtrim($realRoot, '/') . '/')) {
            throw new InvalidArgumentException('path is outside allowed root');
        }

        if (!is_file($real) || !is_readable($real)) {
            throw new InvalidArgumentException('file not readable');
        }

        $contents = file_get_contents($real);
        if ($contents === false) {
            throw new InvalidArgumentException('failed to read file');
        }

        $stat = stat($real);
        $size = $stat['size'] ?? strlen($contents);
        $mtime = isset($stat['mtime']) ? gmdate(DATE_ATOM, (int) $stat['mtime']) : null;

        return [
            'path' => $this->relativePath($realRoot, $real),
            'size_bytes' => $size,
            'modified_at' => $mtime,
            'mimeType' => 'text/plain',
            'content' => $contents,
        ];
    }

    /**
     * List directory entries with optional glob filter.
     *
     * @param array{path?:mixed,glob?:mixed} $args
     * @return array<string,mixed>
     */
    private function listDir(array $args): array
    {
        $pathRaw = $args['path'] ?? null;
        $glob = isset($args['glob']) && is_string($args['glob']) ? $args['glob'] : null;
        if (!is_string($pathRaw) || trim($pathRaw) === '') {
            throw new InvalidArgumentException('path is required');
        }

        $root = $this->root ?? dirname(__DIR__, 2);
        $realRoot = realpath($root) ?: $root;
        $candidate = str_starts_with($pathRaw, '/') ? $pathRaw : $realRoot . '/' . $pathRaw;
        $dirReal = realpath($candidate);
        if ($dirReal === false || !is_dir($dirReal)) {
            throw new InvalidArgumentException('directory not found');
        }
        if ($dirReal !== $realRoot && !str_starts_with($dirReal, rtrim($realRoot, '/') . '/')) {
            throw new InvalidArgumentException('path is outside allowed root');
        }

        $entries = [];
        $iterator = scandir($dirReal);
        if ($iterator === false) {
            throw new InvalidArgumentException('failed to read directory');
        }

        foreach ($iterator as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            if ($glob !== null && !fnmatch($glob, $entry, FNM_PATHNAME)) {
                continue;
            }

            $full = $dirReal . '/' . $entry;
            $stat = @stat($full);
            $mtime = isset($stat['mtime']) ? gmdate(DATE_ATOM, (int) $stat['mtime']) : null;
            $size = $stat['size'] ?? null;

            $entries[] = [
                'name' => $entry,
                'path' => $this->relativePath($realRoot, $full),
                'type' => is_dir($full) ? 'dir' : 'file',
                'size_bytes' => is_dir($full) ? null : $size,
                'modified_at' => $mtime,
            ];
        }

        return ['entries' => $entries];
    }

    /**
     * Stat a path under root; when requireExisting=false returns exists=false for missing.
     *
     * @param array{path?:mixed} $args
     * @return array<string,mixed>
     */
    private function statPath(array $args, bool $requireExisting): array
    {
        $pathRaw = $args['path'] ?? null;
        if (!is_string($pathRaw) || trim($pathRaw) === '') {
            throw new InvalidArgumentException('path is required');
        }

        $root = $this->root ?? dirname(__DIR__, 2);
        $realRoot = realpath($root) ?: $root;
        $candidate = str_starts_with($pathRaw, '/') ? $pathRaw : $realRoot . '/' . $pathRaw;
        $real = realpath($candidate);

        if ($real === false) {
            if ($requireExisting) {
                throw new InvalidArgumentException('path not found');
            }
            return [
                'exists' => false,
                'path' => $this->relativePath($realRoot, $candidate),
            ];
        }

        if ($real !== $realRoot && !str_starts_with($real, rtrim($realRoot, '/') . '/')) {
            throw new InvalidArgumentException('path is outside allowed root');
        }

        $stat = @stat($real);
        $mtime = isset($stat['mtime']) ? gmdate(DATE_ATOM, (int) $stat['mtime']) : null;
        $size = $stat['size'] ?? null;
        $isDir = is_dir($real);

        return [
            'exists' => true,
            'path' => $this->relativePath($realRoot, $real),
            'type' => $isDir ? 'dir' : 'file',
            'size_bytes' => $isDir ? null : $size,
            'modified_at' => $mtime,
        ];
    }

    /**
     * Search within files under a root with optional glob filters.
     *
     * @param array{root?:mixed,pattern?:mixed,file_glob?:mixed,max_results?:mixed} $args
     * @return array<string,mixed>
     */
    private function searchInFiles(array $args): array
    {
        $rootRaw = $args['root'] ?? null;
        $patternRaw = $args['pattern'] ?? null;
        if (!is_string($rootRaw) || trim($rootRaw) === '') {
            throw new InvalidArgumentException('root is required');
        }
        if (!is_string($patternRaw) || $patternRaw === '') {
            throw new InvalidArgumentException('pattern is required');
        }

        $globs = [];
        if (isset($args['file_glob']) && is_array($args['file_glob'])) {
            foreach ($args['file_glob'] as $g) {
                if (is_string($g) && $g !== '') {
                    $globs[] = $g;
                }
            }
        }

        $max = 200;
        if (isset($args['max_results']) && is_numeric($args['max_results'])) {
            $max = max(1, min(1000, (int) $args['max_results']));
        }

        $rootBase = $this->root ?? dirname(__DIR__, 2);
        $realBase = realpath($rootBase) ?: $rootBase;
        $candidate = str_starts_with($rootRaw, '/') ? $rootRaw : $realBase . '/' . $rootRaw;
        $realRoot = realpath($candidate);
        if ($realRoot === false || !is_dir($realRoot)) {
            throw new InvalidArgumentException('root directory not found');
        }
        if ($realRoot !== $realBase && !str_starts_with($realRoot, rtrim($realBase, '/') . '/')) {
            throw new InvalidArgumentException('root is outside allowed base');
        }

        $regex = '/' . preg_quote($patternRaw, '/') . '/i';

        $matches = [];
        $rii = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($realRoot, \FilesystemIterator::SKIP_DOTS));
        foreach ($rii as $fileInfo) {
            if ($fileInfo->isDir()) {
                continue;
            }

            $relativePath = $this->relativePath($realBase, $fileInfo->getPathname());
            $filename = $fileInfo->getFilename();

            if ($globs) {
                $keep = false;
                foreach ($globs as $g) {
                    if (fnmatch($g, $filename, FNM_PATHNAME) || fnmatch($g, $relativePath, FNM_PATHNAME)) {
                        $keep = true;
                        break;
                    }
                }
                if (!$keep) {
                    continue;
                }
            }

            $content = @file($fileInfo->getPathname(), FILE_IGNORE_NEW_LINES);
            if ($content === false) {
                continue;
            }

            foreach ($content as $idx => $line) {
                if (preg_match($regex, $line) === 1) {
                    $matches[] = [
                        'file' => $relativePath,
                        'line' => $idx + 1,
                        'snippet' => $this->truncateLine($line),
                    ];
                    if (count($matches) >= $max) {
                        break 2;
                    }
                }
            }
        }

        return [
            'pattern' => $patternRaw,
            'root' => $this->relativePath($realBase, $realRoot),
            'count' => count($matches),
            'matches' => $matches,
        ];
    }

    /**
     * Resource tool helpers.
     */
    private function readResourceTool(array $params, array $host): array
    {
        $uri = $this->normalizeString($params['uri'] ?? null);
        if ($uri === null || $uri === '') {
            throw new InvalidArgumentException('uri is required');
        }

        return $this->readResource($uri, $host);
    }

    private function createResourceTool(array $params, array $host): array
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

    private function updateResourceTool(array $params, array $host): array
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

    private function deleteResourceTool(array $params, array $host): array
    {
        $uri = $this->normalizeString($params['uri'] ?? null);
        if ($uri === null || $uri === '') {
            throw new InvalidArgumentException('uri is required');
        }

        return $this->deleteResource($uri, $host);
    }

    private function listResourcesTool(array $host): array
    {
        return $this->listResources($host);
    }

    /**
     * Write a text file respecting root and overwrite flags.
     *
     * @param array{path?:mixed,content?:mixed,create_if_missing?:mixed,overwrite?:mixed} $args
     * @return array<string,mixed>
     */
    private function writeFile(array $args): array
    {
        $pathRaw = $args['path'] ?? null;
        $content = $args['content'] ?? null;
        if (!is_string($pathRaw) || trim($pathRaw) === '') {
            throw new InvalidArgumentException('path is required');
        }
        if (!is_string($content)) {
            throw new InvalidArgumentException('content is required');
        }

        $create = array_key_exists('create_if_missing', $args) ? (bool) $args['create_if_missing'] : true;
        $overwrite = array_key_exists('overwrite', $args) ? (bool) $args['overwrite'] : true;

        $root = $this->root ?? dirname(__DIR__, 2);
        $realRoot = realpath($root) ?: $root;

        $candidate = str_starts_with($pathRaw, '/') ? $pathRaw : $realRoot . '/' . $pathRaw;
        $dir = dirname($candidate);
        $dirReal = realpath($dir);
        if ($dirReal === false) {
            throw new InvalidArgumentException('directory not found');
        }

        if ($dirReal !== $realRoot && !str_starts_with($dirReal, rtrim($realRoot, '/') . '/')) {
            throw new InvalidArgumentException('path is outside allowed root');
        }

        $target = $dirReal . '/' . basename($candidate);
        $exists = file_exists($target);
        if ($exists && !$overwrite) {
            throw new InvalidArgumentException('file exists and overwrite is false');
        }
        if (!$exists && !$create) {
            throw new InvalidArgumentException('file missing and create_if_missing is false');
        }

        $bytes = file_put_contents($target, $content, LOCK_EX);
        if ($bytes === false) {
            throw new InvalidArgumentException('failed to write file');
        }

        $stat = stat($target);
        $size = $stat['size'] ?? strlen($content);
        $mtime = isset($stat['mtime']) ? gmdate(DATE_ATOM, (int) $stat['mtime']) : null;

        return [
            'path' => $this->relativePath($realRoot, $target),
            'size_bytes' => $size,
            'modified_at' => $mtime,
            'written_bytes' => $bytes,
        ];
    }

    private function relativePath(string $root, string $full): string
    {
        $root = rtrim($root, '/') . '/';
        return str_starts_with($full, $root) ? substr($full, strlen($root)) : $full;
    }

    private function truncateLine(string $value): string
    {
        $trimmed = rtrim($value, "\r\n");
        if (strlen($trimmed) <= 200) {
            return $trimmed;
        }

        return substr($trimmed, 0, 197) . '...';
    }

    private function wrapContent(mixed $data): array
    {
        if (is_array($data) && array_key_exists('content', $data) && is_array($data['content'])) {
            return $data;
        }

        $text = is_string($data)
            ? $data
            : json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($text === false) {
            $text = '{}';
        }

        return [
            'content' => [
                [
                    'type' => 'text',
                    'text' => $text ?? '',
                ],
            ],
        ];
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

    /**
     * Append a memory entry under a resource id (namespaced by a generated key).
     *
     * @param array<string,mixed> $params
     * @param array<string,mixed> $host
     */
    private function memoryAppend(array $params, array $host): array
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
     */
    private function memoryQuery(array $params, array $host): array
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
     */
    private function memoryList(array $params, array $host): array
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
    private function normalizeString(mixed $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }
        $trimmed = trim($value);
        return $trimmed === '' ? null : $trimmed;
    }
}
