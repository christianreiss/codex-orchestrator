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
import type { SecretsService } from './secrets.js';
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
  /**
   * Fleet credential store. Optional like `sharedMemories`: when omitted the
   * secret_* tools are neither listed nor callable, so a registry built for a
   * narrower surface cannot hand out credentials by accident. Note the runtime
   * switch is separate — `secrets_module_enabled` gates what the service will
   * serve, while this only decides whether the tools exist at all.
   */
  secrets?: SecretsService;
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

function secretCapabilities(enabled: boolean): Record<string, boolean> {
  return {
    list: enabled,
    search: enabled,
    get: enabled,
    create: enabled,
    rotate_owned: enabled,
    delete_owned: enabled,
    mutate_operator_owned: false,
    mutate_other_host_owned: false,
  };
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
    case 'secret_search':
      return { query: scalar };
    case 'shared_memory_read':
    case 'shared_memory_delete':
    case 'secret_get':
    case 'secret_delete':
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
    case 'skill_delete':
      return { slug: scalar };
    default:
      return { value: scalar };
  }
}

/**
 * Minimal validation of `args` against a tool's declared JSON-schema-like
 * `inputSchema`: checks that every `required` property is present (and, for
 * `integer`/`number` properties, coercible to a finite number). Closed schemas
 * also reject undeclared fields and enforce their declared string types. This
 * is not a full JSON-schema implementation — just enough to turn
 * missing/malformed fields into a clear error instead of silently coercing
 * them in a handler. Returns a human-readable message, or null when `args`
 * satisfies the schema.
 */
function validateAgainstSchema(schema: Record<string, unknown>, args: Record<string, unknown>): string | null {
  const required = Array.isArray(schema['required']) ? (schema['required'] as unknown[]) : [];
  const properties =
    schema['properties'] && typeof schema['properties'] === 'object'
      ? (schema['properties'] as Record<string, { type?: unknown }>)
      : {};
  if (schema['additionalProperties'] === false) {
    for (const key of Object.keys(args)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        return "'" + key + "' is not allowed";
      }
    }
    for (const [key, property] of Object.entries(properties)) {
      const value = args[key];
      if (value === undefined) continue;
      if (property.type === 'string' && typeof value !== 'string') {
        return "'" + key + "' must be a string";
      }
    }
  }
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
          'Record something the whole fleet should know, in a document every host and both engines can find. Use this instead of writing a local notes file. Writing an EXISTING slug replaces it — that is how you correct a record whose facts have changed, and it is preferred over creating a near-duplicate slug beside it, so search before you create. Pass expected_sha256 from your prior read so a concurrent writer fails loudly instead of losing text. To add new material to a document that is still accurate, prefer shared_memory_append. Up to 1 MiB.',
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
        description:
          'Retire a shared memory document whose content is superseded, was proven wrong, or has been replaced by another record. Deleting is part of curating the corpus: a document that states something untrue is worse than no document, because the next agent cannot tell it is stale. Soft delete — the slug stays reserved and a later write revives it, so this is recoverable.',
        inputSchema: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
      },
      handler: async (args, host, engine) => shared.delete(args, host, engine ?? null),
    });
  }
  // Fleet credential store. Available to any enrolled host agent, because an
  // agent that cannot reach its credentials falls back to
  // scraping them off the filesystem or pestering the operator — which is the
  // failure mode this store exists to remove. Nothing here writes to disk, so
  // revocation takes effect on the next call.
  if (deps.secrets) {
    const store = deps.secrets;
    inputs.push({
      definition: {
        name: 'secret_list',
        description:
          'THE fleet credential store and its read-only capability probe. Call this FIRST whenever a task needs a credential OR asks whether the store is available or can save secrets. Never infer absence from a partial or deferred client tool list. Takes no arguments. Returns live status, capabilities, and metadata for visible secrets — never values. status=available means secret_store can create a new slug and rotate only credentials owned by this host; secret_delete has the same ownership limit. status=disabled means those operations are unavailable. Pick a matching slug, then call secret_get. Values are never written to this machine.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'integer' },
          },
        },
      },
      handler: async (_args, host, engine) => {
        const enabled = await store.getEnabled();
        return {
          status: enabled ? 'available' : 'disabled',
          capabilities: secretCapabilities(enabled),
          secrets: enabled ? await store.listForHost(engine ?? ENGINE_CODEX, host.id) : [],
        };
      },
    });
    inputs.push({
      definition: {
        name: 'secret_search',
        description:
          'Find a fleet credential by what it is for, when you do not already know its slug — "github", "bookstack token", "production database", "checkmk". Matches the slug, name, description and tags, and returns the same metadata as secret_list and NEVER a value. Omit query to get the full list instead. Use this rather than guessing a slug, and follow up with secret_get on the one you picked. If it finds nothing, call secret_list to see everything the fleet holds before concluding the credential does not exist.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'integer' },
          },
          // `query` is deliberately not required: validateAgainstSchema rejects
          // an empty string, and a search surface that cannot enumerate forces
          // callers to guess. Omitting it degrades to a listing.
        },
      },
      handler: async (args, host, engine) => {
        const enabled = await store.getEnabled();
        return {
          status: enabled ? 'available' : 'disabled',
          capabilities: secretCapabilities(enabled),
          secrets: enabled
            ? await store.searchForHost(String(args['query'] ?? ''), engine ?? ENGINE_CODEX, host.id)
            : [],
        };
      },
    });
    inputs.push({
      definition: {
        name: 'secret_get',
        description:
          'Fetch the plaintext of one fleet credential by slug, after finding it with secret_list or secret_search. Returns a live credential — handle it as one: use it for the call you are making right now and nothing else, and never echo it into a shell command you print, a log line, a commit, a file on disk, a memory, a project note, a comment, or any other tool output. Do not cache it or copy it anywhere: revocation in this store is instant, so a copy you kept is a credential that has stopped working, and a credential you wrote down is one nobody can revoke. Call this again if you need it later. Every call is recorded in the fleet MCP audit log against this host and this slug, whether or not it succeeds.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
      },
      handler: async (args, host, engine) =>
        store.getForHost(String(args['slug'] ?? ''), host, engine ?? ENGINE_CODEX),
    });
    inputs.push({
      definition: {
        name: 'secret_store',
        description:
          'Save a credential of your own into the fleet store, or rotate one you already saved. Use this instead of writing a token into a config file, a .env, a memory, or a note — this is the only place a credential belongs. Creating: pass slug, name, value, and a description saying what the credential opens and when to reach for it, because that description is all any agent (including you, later) has to go on. Rotating: pass the same slug with the new value; everything else you omit is left alone, and the response says whether the value actually changed. You may only change secrets this host created. A slug an operator created, or one another host owns, is refused — read those with secret_get and ask an operator to change them. Slugs are permanent: pick a descriptive one, because renaming means deleting and recreating, which breaks every agent that learned the old name.',
        inputSchema: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            name: { type: 'string' },
            value: { type: 'string' },
            description: { type: 'string' },
            engine: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['slug', 'value'],
        },
      },
      handler: async (args, host, engine) =>
        store.storeForHost(
          {
            slug: String(args['slug'] ?? ''),
            name: String(args['name'] ?? args['slug'] ?? ''),
            value: String(args['value'] ?? ''),
            description: args['description'] === undefined ? undefined : String(args['description']),
            engine: isEngine(args['engine']) ? args['engine'] : null,
            tags: Array.isArray(args['tags']) ? (args['tags'] as string[]) : undefined,
          },
          host,
          engine ?? ENGINE_CODEX,
        ),
    });
    inputs.push({
      definition: {
        name: 'secret_delete',
        description:
          'Retire a credential this host created, by slug. Revocation is immediate: nothing is cached on any machine, so the next secret_get for it fails everywhere at once. Use this when a credential is rotated away upstream, or when the thing it opened is gone. You may only delete secrets this host created — operator-created ones and other hosts’ are refused. The slug stays reserved and secret_store can revive it later with a fresh value.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
      },
      handler: async (args, host, engine) =>
        store.deleteForHost(String(args['slug'] ?? ''), host, engine ?? ENGINE_CODEX),
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
        'Create or update a durable project memory by key (add + update). Upserting an existing key is how you correct a fact whose reality has moved — prefer that over inventing a near-duplicate key beside it. Idempotent: returns status created, updated, or unchanged.',
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
      description:
        'Retire a project memory whose fact is superseded or was proven wrong. Deleting is part of curating a workstream: a stale fact the next agent cannot identify as stale is worse than a missing one. To correct a fact that still belongs, use project_memory_upsert on the same key instead.',
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
      description:
        'Authoritative first step for any Skill-related request: list fleet Skills available to this host before consulting local Skill files.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    handler: async (_args, host, requestEngine) =>
      deps.skills.listSkills(host, requestEngine ?? ENGINE_CODEX),
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
    handler: async (args, host, engine) => {
      const slug = String(args['slug'] ?? '');
      const sha = typeof args['sha256'] === 'string' ? args['sha256'] : null;
      return deps.skills.retrieve(slug, sha, host, engine ?? ENGINE_CODEX);
    },
  });
  inputs.push({
    definition: {
      name: 'skill_store',
      description:
        'Create, replace, or revive one shared canonical Skill manifest. Last-writer-wins; code-managed and source-managed Skills are read-only.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slug: { type: 'string' },
          manifest: { type: 'string' },
          display_name: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['slug', 'manifest'],
      },
    },
    handler: async (args, host) => deps.skills.store(args, host),
  });
  inputs.push({
    definition: {
      name: 'skill_delete',
      description:
        'Soft-delete one shared canonical Skill by slug. A later skill_store can revive it; code-managed and source-managed Skills are read-only.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { slug: { type: 'string' } },
        required: ['slug'],
      },
    },
    handler: async (args, host) => deps.skills.deleteSkill(String(args['slug'] ?? ''), host),
  });

  if (deps.resources) {
    inputs.push({
      definition: {
        name: 'resource_list',
        description: 'List MCP resources available to this host',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async (_args, host, engine) => ({
        resources: await deps.resources!.list(host, engine ?? ENGINE_CODEX),
      }),
    });
    inputs.push({
      definition: {
        name: 'resource_read',
        description: 'Read an MCP resource by URI, including skill://{slug} manifests and skill://{slug}/{path} support files',
        inputSchema: {
          type: 'object',
          properties: { uri: { type: 'string' } },
          required: ['uri'],
        },
      },
      handler: async (args, host, engine) => deps.resources!.read(
        String(args['uri'] ?? ''),
        host,
        engine ?? ENGINE_CODEX,
      ),
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
