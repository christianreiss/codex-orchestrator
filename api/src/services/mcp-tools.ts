/**
 * MCP tool registry + dispatcher (host capability).
 */
import type { Host } from '../db/schema.js';
import type { McpMemoriesService } from './mcp-memories.js';
import type { HostProjectsService } from './host-projects.js';
import type { HostSkillsService } from './host-skills.js';
import { ENGINE_CODEX, isEngine, type Engine } from '../util/engine.js';

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolDeps {
  memories: McpMemoriesService;
  projects: HostProjectsService;
  skills: HostSkillsService;
}

export type ToolResult =
  | { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
  | Record<string, unknown>;

type ToolHandler = (args: Record<string, unknown>, host: Host) => Promise<unknown>;

export class McpToolsRegistry {
  private definitions: ToolDefinition[];
  private handlers: Map<string, ToolHandler>;

  constructor(deps: ToolDeps) {
    this.definitions = buildDefinitions();
    this.handlers = buildHandlers(deps);
  }

  list(): ToolDefinition[] {
    return this.definitions.slice();
  }

  has(name: string): boolean {
    return this.handlers.has(this.normalizeName(name));
  }

  async dispatch(name: string, args: unknown, host: Host): Promise<ToolResult> {
    const normalized = this.normalizeName(name);
    const handler = this.handlers.get(normalized);
    if (!handler) {
      return wrapContent('Method not found: ' + name, true);
    }
    const argsObj = normalizeArgs(normalized, args);
    try {
      const result = await handler(argsObj, host);
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
      return { slug: scalar };
    case 'skill_retrieve':
      return { slug: scalar };
    default:
      return { value: scalar };
  }
}

function buildHandlers(deps: ToolDeps): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  handlers.set('memory_store', async (args, host) => deps.memories.store(args, host));
  handlers.set('memory_retrieve', async (args, host) => deps.memories.retrieve(args, host));
  handlers.set('memory_search', async (args, host) => deps.memories.search(args, host));
  handlers.set('memory_delete', async (args, host) => deps.memories.delete(args, host));

  handlers.set('project_list', async (_args, host) => deps.projects.listProjects(host));
  handlers.set('project_bootstrap', async (args, host) => deps.projects.bootstrap(String(args['slug'] ?? ''), host));
  handlers.set('project_detail', async (args, host) => deps.projects.projectDetail(String(args['slug'] ?? ''), host));
  handlers.set('project_changes', async (args, host) =>
    deps.projects.listChanges(String(args['slug'] ?? ''), Number(args['since'] ?? 0), host),
  );
  handlers.set('project_create', async (args, host) => deps.projects.createProject(args, host));
  handlers.set('project_note_create', async (args, host) =>
    deps.projects.upsertNote(String(args['slug'] ?? ''), null, args, host),
  );
  handlers.set('project_todo_create', async (args, host) =>
    deps.projects.createTodo(String(args['slug'] ?? ''), args, host),
  );
  handlers.set('project_feedback_create', async (args, host) =>
    deps.projects.createFeedback(String(args['slug'] ?? ''), args, host),
  );

  handlers.set('skill_list', async (args, host) => {
    const engine = isEngine(args['engine']) ? (args['engine'] as Engine) : ENGINE_CODEX;
    return deps.skills.listSkills(host, engine);
  });
  handlers.set('skill_retrieve', async (args, host) => {
    const slug = String(args['slug'] ?? '');
    const sha = typeof args['sha256'] === 'string' ? args['sha256'] : null;
    return deps.skills.retrieve(slug, sha, host);
  });

  return handlers;
}

function buildDefinitions(): ToolDefinition[] {
  return [
    {
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
    {
      name: 'memory_retrieve',
      description: 'Retrieve a stored memory by id',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
    {
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
    {
      name: 'memory_delete',
      description: 'Delete a stored memory by id (soft delete)',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
    {
      name: 'project_list',
      description: 'List shared projects available to this host',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'project_bootstrap',
      description: 'Read compact shared project bootstrap context',
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string' } },
        required: ['slug'],
      },
    },
    {
      name: 'project_detail',
      description: 'Read full shared project state',
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string' } },
        required: ['slug'],
      },
    },
    {
      name: 'project_changes',
      description: 'List project changes since a sequence number',
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string' }, since: { type: 'integer' } },
        required: ['slug'],
      },
    },
    {
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
    {
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
    {
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
    {
      name: 'project_feedback_create',
      description: 'Create a project feedback entry for later triage',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          type: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['slug', 'type', 'title', 'body'],
      },
    },
    {
      name: 'skill_list',
      description: 'List skills available to this host',
      inputSchema: {
        type: 'object',
        properties: { engine: { type: 'string', enum: ['codex', 'claude'] } },
      },
    },
    {
      name: 'skill_retrieve',
      description: 'Retrieve a skill manifest by slug (optionally with sha256 for cache check)',
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string' }, sha256: { type: 'string' } },
        required: ['slug'],
      },
    },
  ];
}
