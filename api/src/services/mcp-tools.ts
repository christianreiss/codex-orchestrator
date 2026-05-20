/**
 * MCP tool registry + dispatcher.
 *
 * Tools are tagged with a capability: `host` (default) for normal wrapper
 * clients, `operator` for trusted callers who present the operator bearer
 * token. The registry exposes only the subset matching the caller's
 * capability — operator-only tools are invisible to host callers (not just
 * blocked) so their existence does not leak.
 */
import type { Host } from '../db/schema.js';
import type { McpMemoriesService } from './mcp-memories.js';
import type { HostProjectsService } from './host-projects.js';
import type { HostSkillsService } from './host-skills.js';
import type { McpFsTools } from './mcp-fs.js';
import type { McpResourcesService } from './mcp-resources.js';
import { ENGINE_CODEX, isEngine, type Engine } from '../util/engine.js';
import { PROJECT_FEEDBACK_TYPES } from './project-feedback-types.js';

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export type Capability = 'host' | 'operator';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Defaults to 'host' when omitted. */
  capability?: Capability;
}

export interface ToolDeps {
  memories: McpMemoriesService;
  projects: HostProjectsService;
  skills: HostSkillsService;
  resources?: McpResourcesService;
  /**
   * Optional filesystem tools. When omitted, fs_* tools are not registered
   * (neither listed nor callable). Activated by setting MCP_FS_ROOT.
   */
  fs?: McpFsTools;
}

export type ToolResult =
  | { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
  | Record<string, unknown>;

type ToolHandler = (args: Record<string, unknown>, host: Host) => Promise<unknown>;

interface ToolEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
  capability: Capability;
}

export class McpToolsRegistry {
  private entries: Map<string, ToolEntry>;

  constructor(deps: ToolDeps) {
    this.entries = buildEntries(deps);
  }

  /**
   * Return tool definitions visible to the given capability. Operator-only
   * tools are filtered out for host callers. Defaults to 'host' so accidental
   * omission stays safe.
   */
  list(capability: Capability = 'host'): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const entry of this.entries.values()) {
      if (!canAccess(capability, entry.capability)) continue;
      out.push(entry.definition);
    }
    return out;
  }

  /**
   * Check whether `name` is callable at `capability`. Operator tools return
   * false for host callers (so the dispatcher can answer method-not-found
   * without leaking existence).
   */
  has(name: string, capability: Capability = 'host'): boolean {
    let normalized: string;
    try {
      normalized = this.normalizeName(name);
    } catch {
      return false;
    }
    const entry = this.entries.get(normalized);
    if (!entry) return false;
    return canAccess(capability, entry.capability);
  }

  async dispatch(name: string, args: unknown, host: Host, capability: Capability = 'host'): Promise<ToolResult> {
    const normalized = this.normalizeName(name);
    const entry = this.entries.get(normalized);
    if (!entry || !canAccess(capability, entry.capability)) {
      return wrapContent('Method not found: ' + name, true);
    }
    const argsObj = normalizeArgs(normalized, args);
    try {
      const result = await entry.handler(argsObj, host);
      return wrapContent(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return wrapContent(message, true);
    }
  }

  normalizeName(name: string): string {
    const normalized = String(name ?? '').trim().replaceAll('.', '_');
    if (!normalized) throw new Error('Tool name is required');
    if (!TOOL_NAME_RE.test(normalized)) throw new Error('Tool name must match ' + String(TOOL_NAME_RE));
    return normalized;
  }
}

function canAccess(caller: Capability, required: Capability): boolean {
  if (required === 'host') return true; // host tools are visible to operators too
  return caller === 'operator';
}

export function wrapContent(data: unknown, isError = false): ToolResult {
  if (
    data !== null &&
    typeof data === 'object' &&
    Array.isArray((data as { content?: unknown }).content)
  ) {
    const obj = data as Record<string, unknown>;
    if (!('isError' in obj)) obj['isError'] = isError;
    else if (isError) obj['isError'] = true;
    return obj as ToolResult;
  }
  const text = typeof data === 'string' ? data : safeStringify(data);
  return { isError, content: [{ type: 'text', text }] };
}

function safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data ?? null);
  } catch {
    return '{}';
  }
}

function normalizeArgs(toolName: string, args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
  if (args === null || args === undefined) return {};
  const scalar = String(args);
  switch (toolName) {
    case 'memory_store':
      return { content: scalar };
    case 'memory_retrieve':
    case 'memory_delete':
      return { id: scalar };
    case 'memory_search':
      return { query: scalar };
    case 'project_create':
    case 'project_detail':
    case 'project_bootstrap':
    case 'project_changes':
    case 'project_file_list':
      return { slug: scalar };
    case 'project_file_read':
      // Scalar form is ambiguous between slug-only and stored-name; default to slug.
      return { slug: scalar };
    case 'skill_retrieve':
      return { slug: scalar };
    default:
      return { value: scalar };
  }
}

interface RegistrationInput {
  definition: ToolDefinition;
  handler: ToolHandler;
}

function buildEntries(deps: ToolDeps): Map<string, ToolEntry> {
  const inputs: RegistrationInput[] = [];

  // Host-capability tools (memory_*, project_*, skill_*).
  inputs.push({
    definition: {
      name: 'memory_store',
      description: 'Store MCP memory content with optional tags and metadata',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          metadata: { type: 'object' },
        },
        required: ['content'],
      },
    },
    handler: async (args, host) => deps.memories.store(args, host),
  });
  inputs.push({
    definition: {
      name: 'memory_retrieve',
      description: 'Retrieve a stored memory by id',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
    handler: async (args, host) => deps.memories.retrieve(args, host),
  });
  inputs.push({
    definition: {
      name: 'memory_search',
      description: 'Search stored memories by full-text query and optional tags',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          limit: { type: 'integer' },
        },
        required: ['query'],
      },
    },
    handler: async (args, host) => deps.memories.search(args, host),
  });
  inputs.push({
    definition: {
      name: 'memory_delete',
      description: 'Delete a stored memory by id (soft delete)',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
    handler: async (args, host) => deps.memories.delete(args, host),
  });
  inputs.push({
    definition: {
      name: 'project_list',
      description: 'List shared projects available to this host',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: async (_args, host) => deps.projects.listProjects(host),
  });
  inputs.push({
    definition: {
      name: 'project_bootstrap',
      description: 'Read compact shared project bootstrap context',
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string' } },
        required: ['slug'],
      },
    },
    handler: async (args, host) => deps.projects.bootstrap(String(args['slug'] ?? ''), host),
  });
  inputs.push({
    definition: {
      name: 'project_detail',
      description: 'Read full shared project state',
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string' } },
        required: ['slug'],
      },
    },
    handler: async (args, host) => deps.projects.projectDetail(String(args['slug'] ?? ''), host),
  });
  inputs.push({
    definition: {
      name: 'project_changes',
      description: 'List project changes since a sequence number',
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string' }, since: { type: 'integer' } },
        required: ['slug'],
      },
    },
    handler: async (args, host) =>
      deps.projects.listChanges(String(args['slug'] ?? ''), Number(args['since'] ?? 0), host),
  });
  inputs.push({
    definition: {
      name: 'project_create',
      description: 'Create a shared project',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          about: { type: 'object' },
          roster_markdown: { type: 'string' },
        },
        required: ['slug'],
      },
    },
    handler: async (args, host) => deps.projects.createProject(args, host),
  });
  inputs.push({
    definition: {
      name: 'project_note_create',
      description: 'Create a project note',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          header: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['slug', 'header', 'body'],
      },
    },
    handler: async (args, host) =>
      deps.projects.upsertNote(String(args['slug'] ?? ''), null, args, host),
  });
  inputs.push({
    definition: {
      name: 'project_note_upsert',
      description: 'Create or update a project note (update when id is provided, create otherwise)',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          id: { type: 'integer' },
          header: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['slug', 'header', 'body'],
      },
    },
    handler: async (args, host) => {
      const idRaw = args['id'];
      const noteId =
        idRaw === null || idRaw === undefined || idRaw === '' ? null : Number(idRaw);
      return deps.projects.upsertNote(String(args['slug'] ?? ''), noteId, args, host);
    },
  });
  inputs.push({
    definition: {
      name: 'project_todo_create',
      description: 'Create a project todo item',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          title: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['slug', 'title'],
      },
    },
    handler: async (args, host) => deps.projects.createTodo(String(args['slug'] ?? ''), args, host),
  });
  inputs.push({
    definition: {
      name: 'project_todo_update',
      description: 'Update an existing project todo (title/detail)',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          id: { type: 'integer' },
          title: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['slug', 'id', 'title'],
      },
    },
    handler: async (args, host) =>
      deps.projects.updateTodo(String(args['slug'] ?? ''), Number(args['id']), args, host),
  });
  inputs.push({
    definition: {
      name: 'project_todo_done',
      description: 'Mark a project todo as done',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          id: { type: 'integer' },
        },
        required: ['slug', 'id'],
      },
    },
    handler: async (args, host) =>
      deps.projects.setTodoDone(String(args['slug'] ?? ''), Number(args['id']), true, host),
  });
  inputs.push({
    definition: {
      name: 'project_todo_undone',
      description: 'Reopen a project todo (clear the done flag)',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          id: { type: 'integer' },
        },
        required: ['slug', 'id'],
      },
    },
    handler: async (args, host) =>
      deps.projects.setTodoDone(String(args['slug'] ?? ''), Number(args['id']), false, host),
  });
  inputs.push({
    definition: {
      name: 'project_feedback_create',
      description: 'Create a project feedback entry for later triage',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          type: { type: 'string', enum: PROJECT_FEEDBACK_TYPES },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['slug', 'type', 'title', 'body'],
      },
    },
    handler: async (args, host) => deps.projects.createFeedback(String(args['slug'] ?? ''), args, host),
  });
  inputs.push({
    definition: {
      name: 'project_file_list',
      description: 'List all files attached to a project (returns full file rows with content)',
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string' } },
        required: ['slug'],
      },
    },
    handler: async (args, host) => deps.projects.listFiles(String(args['slug'] ?? ''), host),
  });
  inputs.push({
    definition: {
      name: 'project_file_read',
      description:
        'Read a single project file by stored_name or numeric id (returns the full file row including content)',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          stored_name: { type: 'string' },
          id: { type: 'integer' },
        },
        required: ['slug'],
      },
    },
    handler: async (args, host) => {
      const slug = String(args['slug'] ?? '');
      const storedNameRaw = args['stored_name'];
      const idRaw = args['id'];
      const storedName =
        typeof storedNameRaw === 'string' && storedNameRaw.trim() !== '' ? storedNameRaw : null;
      const idNum =
        typeof idRaw === 'number'
          ? idRaw
          : typeof idRaw === 'string' && idRaw.trim() !== ''
            ? Number(idRaw)
            : null;
      return deps.projects.readFile(
        slug,
        { storedName, id: idNum !== null && Number.isFinite(idNum) ? idNum : null },
        host,
      );
    },
  });
  inputs.push({
    definition: {
      name: 'project_file_upsert',
      description:
        'Create or replace a project file by stored_name. Content is required; description and mime_type are optional.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          stored_name: { type: 'string' },
          content: { type: 'string' },
          description: { type: 'string' },
          mime_type: { type: 'string' },
        },
        required: ['slug', 'stored_name', 'content'],
      },
    },
    handler: async (args, host) => deps.projects.upsertFile(String(args['slug'] ?? ''), args, host),
  });
  inputs.push({
    definition: {
      name: 'project_file_delete',
      description: 'Delete a project file by numeric id',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          id: { type: 'integer' },
        },
        required: ['slug', 'id'],
      },
    },
    handler: async (args, host) =>
      deps.projects.deleteFile(String(args['slug'] ?? ''), Number(args['id'] ?? 0), host),
  });
  inputs.push({
    definition: {
      name: 'skill_list',
      description: 'List skills available to this host',
      inputSchema: {
        type: 'object',
        properties: { engine: { type: 'string', enum: ['codex', 'claude'] } },
      },
    },
    handler: async (args, host) => {
      const engine = isEngine(args['engine']) ? (args['engine'] as Engine) : ENGINE_CODEX;
      return deps.skills.listSkills(host, engine);
    },
  });
  inputs.push({
    definition: {
      name: 'skill_retrieve',
      description: 'Retrieve a skill manifest by slug (optionally with sha256 for cache check)',
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string' }, sha256: { type: 'string' } },
        required: ['slug'],
      },
    },
    handler: async (args, host) => {
      const slug = String(args['slug'] ?? '');
      const sha = typeof args['sha256'] === 'string' ? args['sha256'] : null;
      return deps.skills.retrieve(slug, sha, host);
    },
  });

  if (deps.resources) {
    inputs.push({
      definition: {
        name: 'resource_list',
        description: 'List MCP resources available to this host',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async (_args, host) => ({ resources: await deps.resources!.list(host) }),
    });
    inputs.push({
      definition: {
        name: 'resource_read',
        description: 'Read an MCP resource by URI, including skill://{slug} manifests',
        inputSchema: {
          type: 'object',
          properties: { uri: { type: 'string' } },
          required: ['uri'],
        },
      },
      handler: async (args, host) => deps.resources!.read(String(args['uri'] ?? ''), host),
    });
    inputs.push({
      definition: {
        name: 'resource_create',
        description: 'Create a writable MCP resource (memory:// only)',
        inputSchema: {
          type: 'object',
          properties: { uri: { type: 'string' }, text: { type: 'string' } },
          required: ['uri', 'text'],
        },
      },
      handler: async (args, host) => deps.resources!.create(String(args['uri'] ?? ''), args, host),
    });
    inputs.push({
      definition: {
        name: 'resource_update',
        description: 'Update a writable MCP resource (memory:// only)',
        inputSchema: {
          type: 'object',
          properties: { uri: { type: 'string' }, text: { type: 'string' } },
          required: ['uri', 'text'],
        },
      },
      handler: async (args, host) => deps.resources!.update(String(args['uri'] ?? ''), args, host),
    });
    inputs.push({
      definition: {
        name: 'resource_delete',
        description: 'Delete a writable MCP resource (memory:// only)',
        inputSchema: {
          type: 'object',
          properties: { uri: { type: 'string' } },
          required: ['uri'],
        },
      },
      handler: async (args, host) => deps.resources!.delete(String(args['uri'] ?? ''), host),
    });
  }

  // Operator-capability tools — only registered when their dependency is
  // present. fs_* requires MCP_FS_ROOT to be set (caller wires in McpFsTools).
  if (deps.fs) {
    const fs = deps.fs;
    inputs.push({
      definition: {
        name: 'fs_read_file',
        description: 'Read a file under the configured filesystem root (operator only).',
        capability: 'operator',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            max_bytes: { type: 'integer' },
          },
          required: ['path'],
        },
      },
      handler: async (args) => fs.readFile(args),
    });
    inputs.push({
      definition: {
        name: 'fs_write_file',
        description: 'Write a file under the configured filesystem root (operator only).',
        capability: 'operator',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
            mode: { type: 'integer' },
          },
          required: ['path', 'content'],
        },
      },
      handler: async (args) => fs.writeFile(args),
    });
    inputs.push({
      definition: {
        name: 'fs_list_dir',
        description: 'List directory entries under the filesystem root (operator only).',
        capability: 'operator',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            recursive: { type: 'boolean' },
            max_entries: { type: 'integer' },
          },
          required: ['path'],
        },
      },
      handler: async (args) => fs.listDir(args),
    });
    inputs.push({
      definition: {
        name: 'fs_file_exists',
        description: 'Check whether a path exists under the filesystem root (operator only).',
        capability: 'operator',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      handler: async (args) => fs.fileExists(args),
    });
    inputs.push({
      definition: {
        name: 'fs_stat',
        description: 'Stat a path under the filesystem root (operator only).',
        capability: 'operator',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      handler: async (args) => fs.stat(args),
    });
    inputs.push({
      definition: {
        name: 'fs_search_in_files',
        description: 'Search file contents under the filesystem root by regex (operator only).',
        capability: 'operator',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            pattern: { type: 'string' },
            glob: { type: 'string' },
            max_hits: { type: 'integer' },
          },
          required: ['path', 'pattern'],
        },
      },
      handler: async (args) => fs.searchInFiles(args),
    });
  }

  const entries = new Map<string, ToolEntry>();
  for (const input of inputs) {
    const capability: Capability = input.definition.capability ?? 'host';
    // Normalize: ensure capability is reflected in the definition we expose
    // so list() consumers don't need to re-derive it.
    const def: ToolDefinition =
      input.definition.capability === undefined
        ? { ...input.definition, capability }
        : input.definition;
    entries.set(def.name, {
      definition: def,
      handler: input.handler,
      capability,
    });
  }
  return entries;
}
