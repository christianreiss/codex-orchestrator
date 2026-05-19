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
import { ENGINE_CODEX, isEngine, type Engine } from '../util/engine.js';

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
    handler: async (args, host) => deps.projects.createFeedback(String(args['slug'] ?? ''), args, host),
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

  // Operator-capability tools are registered by separate setup steps (e.g.,
  // McpFsTools is wired in by the MCP route when MCP_FS_ROOT is configured).

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
