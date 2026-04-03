<?php

declare(strict_types=1);

namespace App\Mcp;

use App\Services\ProjectCoordinationService;

class McpToolDefinitions
{
    private readonly ?ProjectCoordinationService $projects;

    public function __construct(?ProjectCoordinationService $projects = null)
    {
        $this->projects = $projects;
    }

    /**
     * @return array<string, array{description:string,inputSchema:array}>
     */
    public function definitions(string $capability = McpServer::CAPABILITY_OPERATOR): array
    {
        $definitions = [
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
                'description' => 'Read a text file from the coordinator filesystem. For skill manifests, prefer resource_read with skill://{slug} URIs.',
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
                'description' => 'Read a resource URI (memory://*, skill://*, project://*)',
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

        if ($this->projectsEnabled()) {
            $definitions['project_list'] = [
                'description' => 'List available shared projects',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => new \stdClass(),
                ],
            ];
            $definitions['project_create'] = [
                'description' => 'Create a shared project',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'slug' => ['type' => 'string'],
                        'about' => ['type' => 'object'],
                        'roster_markdown' => ['type' => 'string'],
                        'agents_markdown' => ['type' => 'string'],
                    ],
                    'required' => ['slug'],
                ],
            ];
            $definitions['project_detail'] = [
                'description' => 'Read full shared project state',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'slug' => ['type' => 'string'],
                    ],
                    'required' => ['slug'],
                ],
            ];
            $definitions['project_bootstrap'] = [
                'description' => 'Read compact shared project bootstrap context',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'slug' => ['type' => 'string'],
                    ],
                    'required' => ['slug'],
                ],
            ];
            $definitions['project_changes'] = [
                'description' => 'List project changes since a sequence number',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'slug' => ['type' => 'string'],
                        'since' => ['type' => 'integer'],
                    ],
                    'required' => ['slug'],
                ],
            ];
            $definitions['project_note_upsert'] = [
                'description' => 'Create or update a project note',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'slug' => ['type' => 'string'],
                        'id' => ['type' => 'integer'],
                        'header' => ['type' => 'string'],
                        'body' => ['type' => 'string'],
                    ],
                    'required' => ['slug', 'header', 'body'],
                ],
            ];
            $definitions['project_todo_create'] = [
                'description' => 'Create a project todo item',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'slug' => ['type' => 'string'],
                        'title' => ['type' => 'string'],
                        'detail' => ['type' => 'string'],
                    ],
                    'required' => ['slug', 'title'],
                ],
            ];
            $definitions['project_todo_update'] = [
                'description' => 'Update a project todo item',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'slug' => ['type' => 'string'],
                        'id' => ['type' => 'integer'],
                        'title' => ['type' => 'string'],
                        'detail' => ['type' => 'string'],
                    ],
                    'required' => ['slug', 'id', 'title'],
                ],
            ];
            $definitions['project_todo_done'] = [
                'description' => 'Mark a project todo as done',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'slug' => ['type' => 'string'],
                        'id' => ['type' => 'integer'],
                    ],
                    'required' => ['slug', 'id'],
                ],
            ];
            $definitions['project_todo_undone'] = [
                'description' => 'Mark a project todo as not done',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'slug' => ['type' => 'string'],
                        'id' => ['type' => 'integer'],
                    ],
                    'required' => ['slug', 'id'],
                ],
            ];
            $definitions['project_file_upsert'] = [
                'description' => 'Create or update a shared project file/artifact',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'slug' => ['type' => 'string'],
                        'stored_name' => ['type' => 'string'],
                        'description' => ['type' => 'string'],
                        'content' => ['type' => 'string'],
                        'mime_type' => ['type' => 'string'],
                    ],
                    'required' => ['slug', 'stored_name', 'content'],
                ],
            ];
            $definitions['project_feedback_create'] = [
                'description' => 'Create a project feedback entry for later triage',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'slug' => ['type' => 'string'],
                        'type' => ['type' => 'string'],
                        'title' => ['type' => 'string'],
                        'body' => ['type' => 'string'],
                    ],
                    'required' => ['slug', 'type', 'title', 'body'],
                ],
            ];
        }

        $definitions['joplin_search'] = [
            'description' => 'Search Joplin notes by keyword. Returns matching notes with id, title, and body excerpt.',
            'inputSchema' => [
                'type' => 'object',
                'properties' => [
                    'query' => ['type' => 'string', 'description' => 'Search query'],
                    'notebook_id' => ['type' => 'string', 'description' => 'Optional notebook ID to filter results'],
                    'limit' => ['type' => 'integer', 'description' => 'Max results to return (default 20)'],
                ],
                'required' => ['query'],
            ],
        ];
        $definitions['joplin_get_note'] = [
            'description' => 'Get the full content of a Joplin note by its ID.',
            'inputSchema' => [
                'type' => 'object',
                'properties' => [
                    'note_id' => ['type' => 'string', 'description' => 'Joplin note ID'],
                ],
                'required' => ['note_id'],
            ],
        ];
        $definitions['joplin_create_note'] = [
            'description' => 'Create a new note in Joplin.',
            'inputSchema' => [
                'type' => 'object',
                'properties' => [
                    'title' => ['type' => 'string', 'description' => 'Note title'],
                    'body' => ['type' => 'string', 'description' => 'Note content in Markdown'],
                    'notebook_id' => ['type' => 'string', 'description' => 'Optional notebook ID'],
                    'tags' => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => 'Optional tag names'],
                ],
                'required' => ['title', 'body'],
            ],
        ];
        $definitions['joplin_update_note'] = [
            'description' => 'Update an existing Joplin note. Only provided fields will be changed.',
            'inputSchema' => [
                'type' => 'object',
                'properties' => [
                    'note_id' => ['type' => 'string', 'description' => 'Joplin note ID to update'],
                    'title' => ['type' => 'string', 'description' => 'New title'],
                    'body' => ['type' => 'string', 'description' => 'New content in Markdown'],
                    'notebook_id' => ['type' => 'string', 'description' => 'New notebook ID'],
                    'tags' => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => 'New tag names'],
                ],
                'required' => ['note_id'],
            ],
        ];
        $definitions['joplin_delete_note'] = [
            'description' => 'Permanently delete a Joplin note.',
            'inputSchema' => [
                'type' => 'object',
                'properties' => [
                    'note_id' => ['type' => 'string', 'description' => 'Joplin note ID to delete'],
                ],
                'required' => ['note_id'],
            ],
        ];
        $definitions['joplin_list_notebooks'] = [
            'description' => 'List all Joplin notebooks. Returns notebook IDs, titles, and parent IDs.',
            'inputSchema' => [
                'type' => 'object',
                'properties' => [],
            ],
        ];

        if ($capability === McpServer::CAPABILITY_HOST) {
            $definitions = array_filter(
                $definitions,
                fn (string $name): bool => $this->capabilityAllowsTool($capability, $name),
                ARRAY_FILTER_USE_KEY
            );
        }

        return $definitions;
    }

    public function capabilityAllowsTool(string $capability, string $toolName): bool
    {
        if ($capability === McpServer::CAPABILITY_HOST && str_starts_with($toolName, 'fs_')) {
            return false;
        }

        return true;
    }

    private function projectsEnabled(): bool
    {
        return $this->projects !== null && (($this->projects->adminState()['enabled'] ?? false) === true);
    }
}
