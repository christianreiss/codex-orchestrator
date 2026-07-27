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
import type { SharedMemoriesService } from './shared-memories.js';
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
  /**
   * Fleet-wide shared memory. Optional so callers that build a registry for a
   * narrower surface (tests, operator tooling) can leave it out; when omitted
   * the shared_memory_* tools are neither listed nor callable.
   */
  sharedMemories?: SharedMemoriesService;
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

type ToolHandler = (args: Record<string, unknown>, host: Host, engine?: Engine | null) => Promise<unknown>;

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

  async dispatch(name: string, args: unknown, host: Host, capability: Capability = 'host', engine: Engine | null = null): Promise<ToolResult> {
    const normalized = this.normalizeName(name);
    const entry = this.entries.get(normalized);
    if (!entry || !canAccess(capability, entry.capability)) {
      return wrapContent('Method not found: ' + name, true);
    }
    const argsObj = normalizeArgs(normalized, args);
    const validationError = validateAgainstSchema(entry.definition.inputSchema, argsObj);
    if (validationError) {
      return wrapContent('Invalid params: ' + validationError, true);
    }
    try {
      const result = await entry.handler(argsObj, host, engine);
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
    case 'shared_memory_search':
      return { query: scalar };
    case 'shared_memory_read':
    case 'shared_memory_delete':
      return { slug: scalar };
    case 'shared_memory_list':
      // The only useful scalar for a listing is a slug prefix — a bare string
      // is far more likely to be "show me everything under ops." than a tag.
      return { prefix: scalar };
    case 'project_create':
    case 'project_detail':
    case 'project_bootstrap':
    case 'project_changes':
    case 'project_file_list':
    case 'project_memory_list':
      return { slug: scalar };
    case 'project_memory_search':
      // Unlike memory_search, the scalar is the slug, not the query: query is
      // optional here, so `project_memory_search("myproject")` usefully lists
      // that project's memories.
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

/**
 * Minimal validation of `args` against a tool's declared JSON-schema-like
 * `inputSchema`: checks that every `required` property is present (and, for
 * `integer`/`number` properties, coercible to a finite number). This is not a
 * full JSON-schema implementation — just enough to turn missing/malformed
 * required fields into a clear error instead of a NaN or undefined silently
 * flowing into the handler. Returns a human-readable message, or null when
 * `args` satisfies the schema.
 */
function validateAgainstSchema(schema: Record<string, unknown>, args: Record<string, unknown>): string | null {
  const required = Array.isArray(schema['required']) ? (schema['required'] as unknown[]) : [];
  const properties =
    schema['properties'] && typeof schema['properties'] === 'object'
      ? (schema['properties'] as Record<string, { type?: unknown }>)
      : {};
  for (const key of required) {
    if (typeof key !== 'string') continue;
    const value = args[key];
    if (value === undefined || value === null || value === '') {
      return "'" + key + "' is required";
    }
    const propType = properties[key]?.type;
    if ((propType === 'integer' || propType === 'number') && !isFiniteNumeric(value)) {
      return "'" + key + "' must be a number";
    }
  }
  return null;
}

function isFiniteNumeric(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string' && value.trim() !== '') return Number.isFinite(Number(value));
  return false;
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
      description:
        'Store HOST-LOCAL scratch memory on this machine only. Not visible to any other host and cannot be listed, so nobody else can discover it. For anything another agent or host should see, use shared_memory_write instead.',
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
    handler: async (args, host, engine) => deps.memories.store(args, host, engine ?? null),
  });
  inputs.push({
    definition: {
      name: 'memory_retrieve',
      description: 'Retrieve a host-local scratch memory by exact id. Only sees memories written on THIS host.',
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
      description:
        'Search HOST-LOCAL scratch memories written on this machine only. This is NOT the place to look things up about the fleet, other hosts, or past decisions — use shared_memory_search for that.',
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
      description: 'Delete a host-local scratch memory by id (soft delete).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
    handler: async (args, host) => deps.memories.delete(args, host),
  });
  // Fleet-wide shared memory. Unlike memory_* (host-scoped) and project_memory_*
  // (project-scoped), these documents are visible to every host and both
  // engines. `shared_memory_list` is the discovery entry point — it needs no
  // query, so a fresh agent can see what the fleet knows before guessing search
  // terms.
  if (deps.sharedMemories) {
    const shared = deps.sharedMemories;
    inputs.push({
      definition: {
        name: 'shared_memory_list',
        description:
          'THE place to look up what this fleet knows: hosts, conventions, runbooks, past decisions. Lists every shared document — no query or arguments needed, so call it first when you are asked about something you do not already know, BEFORE searching the filesystem. Returns slug, title, summary, tags, size and a preview. Visible from every host and either engine, unlike memory_*.',
        inputSchema: {
          type: 'object',
          properties: {
            tags: { type: 'array', items: { type: 'string' } },
            prefix: { type: 'string' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
            include_content: { type: 'boolean' },
          },
        },
      },
      handler: async (args, host) => shared.list(args, host),
    });
    inputs.push({
      definition: {
        name: 'shared_memory_search',
        description:
          'Search everything this fleet has written down — runbooks, host facts, architecture notes, past decisions — across every host. Use this, not memory_search, to look something up. Returns ranked passages with their heading and chunk number; pass mode="documents" for one entry per document. If it returns nothing, try shared_memory_list to see what exists.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            mode: { type: 'string', enum: ['chunks', 'documents'] },
            limit: { type: 'integer' },
          },
          required: ['query'],
        },
      },
      handler: async (args, host) => shared.search(args, host),
    });
    inputs.push({
      definition: {
        name: 'shared_memory_read',
        description:
          'Read a shared memory document by slug, after finding it with shared_memory_list or shared_memory_search. Returns a bounded window (max_chars, default 32000) — use chunk/from_chunk/to_chunk or the returned next_offset to walk a large document.',
        inputSchema: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            chunk: { type: 'integer' },
            from_chunk: { type: 'integer' },
            to_chunk: { type: 'integer' },
            offset: { type: 'integer' },
            max_chars: { type: 'integer' },
          },
          required: ['slug'],
        },
      },
      handler: async (args, host) => shared.read(args, host),
    });
    inputs.push({
      definition: {
        name: 'shared_memory_write',
        description:
          'Record something the whole fleet should know, in a document every host and both engines can find. Use this instead of writing a local notes file. Up to 1 MiB; pass expected_sha256 from a prior read to fail instead of clobbering a concurrent write. To add to an existing document prefer shared_memory_append.',
        inputSchema: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            content: { type: 'string' },
            title: { type: 'string' },
            summary: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            metadata: { type: 'object' },
            expected_sha256: { type: 'string' },
          },
          required: ['slug', 'content'],
        },
      },
      handler: async (args, host, engine) => shared.write(args, host, engine ?? null),
    });
    inputs.push({
      definition: {
        name: 'shared_memory_append',
        description:
          'Append to a shared memory document, creating it when absent. Safe for concurrent writers, unlike read-modify-write with shared_memory_write.',
        inputSchema: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            content: { type: 'string' },
            heading: { type: 'string' },
            separator: { type: 'string' },
            title: { type: 'string' },
            summary: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            metadata: { type: 'object' },
          },
          required: ['slug', 'content'],
        },
      },
      handler: async (args, host, engine) => shared.append(args, host, engine ?? null),
    });
    inputs.push({
      definition: {
        name: 'shared_memory_delete',
        description: 'Delete a shared memory document by slug (soft delete; the slug stays reserved).',
        inputSchema: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
      },
      handler: async (args, host, engine) => shared.delete(args, host, engine ?? null),
    });
  }
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
      name: 'project_memory_list',
      description:
        'List all durable memories bound to a project (visible from every host, across sessions). Returns keys, tags, and truncated previews; set include_content=true for full content. Use this to enumerate project memory without guessing search terms.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          include_content: { type: 'boolean' },
          limit: { type: 'integer' },
        },
        required: ['slug'],
      },
    },
    handler: async (args, host) => deps.projects.listMemories(String(args['slug'] ?? ''), args, host),
  });
  inputs.push({
    definition: {
      name: 'project_memory_get',
      description: 'Read one project memory by key (returns full content, tags, and metadata)',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          key: { type: 'string' },
        },
        required: ['slug', 'key'],
      },
    },
    handler: async (args, host) =>
      deps.projects.getMemory(String(args['slug'] ?? ''), String(args['key'] ?? ''), host),
  });
  inputs.push({
    definition: {
      name: 'project_memory_upsert',
      description:
        'Create or update a durable project memory by key (add + update). Idempotent: returns status created, updated, or unchanged.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          key: { type: 'string' },
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          metadata: { type: 'object' },
        },
        required: ['slug', 'key', 'content'],
      },
    },
    handler: async (args, host) => deps.projects.upsertMemory(String(args['slug'] ?? ''), args, host),
  });
  inputs.push({
    definition: {
      name: 'project_memory_delete',
      description: 'Delete a project memory by key',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          key: { type: 'string' },
        },
        required: ['slug', 'key'],
      },
    },
    handler: async (args, host) =>
      deps.projects.deleteMemory(String(args['slug'] ?? ''), String(args['key'] ?? ''), host),
  });
  inputs.push({
    definition: {
      name: 'project_memory_search',
      description:
        "Search a project's memories by full-text query and optional tags. Omit query to list the most recently updated memories.",
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          query: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          limit: { type: 'integer' },
        },
        // `query` is deliberately NOT required: validateAgainstSchema rejects '',
        // which is exactly what makes memory_search unable to enumerate and forces
        // callers to guess search terms. Omitting query here degrades to a
        // recency-ordered listing instead.
        required: ['slug'],
      },
    },
    handler: async (args, host) => deps.projects.searchMemories(String(args['slug'] ?? ''), args, host),
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
