import { beforeEach, describe, it, expect } from 'vitest';
import { McpToolsRegistry, wrapContent } from '../../../src/services/mcp-tools.js';
import type { McpMemoriesService } from '../../../src/services/mcp-memories.js';
import type { HostProjectsService } from '../../../src/services/host-projects.js';
import type { HostSkillsService } from '../../../src/services/host-skills.js';
import type { McpFsTools } from '../../../src/services/mcp-fs.js';
import type { McpResourcesService } from '../../../src/services/mcp-resources.js';
import type { SharedMemoriesService } from '../../../src/services/shared-memories.js';
import type { SecretsService } from '../../../src/services/secrets.js';
import type { Host } from '../../../src/db/schema.js';

const stubMemories = {
  store: async (args: Record<string, unknown>) => ({ status: 'created', id: args['id'] ?? 'k', memory: null }),
  retrieve: async (args: Record<string, unknown>) => ({ status: 'found', id: args['id'], memory: { content: 'x' } }),
  search: async () => ({ status: 'ok', matches: [] }),
  delete: async (args: Record<string, unknown>) => ({ status: 'deleted', id: args['id'] }),
} as unknown as McpMemoriesService;

interface UpsertNoteCall {
  slug: string;
  id: number | null;
  args: Record<string, unknown>;
}

interface TodoUpdateCall {
  slug: string;
  id: number;
  args?: Record<string, unknown>;
}

interface TodoDoneCall {
  slug: string;
  id: number;
  done: boolean;
}

interface MemoryCall {
  slug: string;
  payload: Record<string, unknown>;
}

const upsertNoteCalls: UpsertNoteCall[] = [];
const todoUpdateCalls: TodoUpdateCall[] = [];
const todoDoneCalls: TodoDoneCall[] = [];
const memoryListCalls: MemoryCall[] = [];
const memorySearchCalls: MemoryCall[] = [];
const skillStoreCalls: Array<{ payload: Record<string, unknown>; host: Host }> = [];
const skillDeleteCalls: Array<{ slug: string; host: Host }> = [];

const stubProjects = {
  listProjects: async () => ({ projects: [] }),
  bootstrap: async (slug: string) => ({ project: slug }),
  projectDetail: async (slug: string) => ({ project: { slug } }),
  listChanges: async (slug: string) => ({ project: slug, changes: [] }),
  createProject: async () => ({ project: { slug: 'x' } }),
  upsertNote: async (slug: string, id: number | null, args: Record<string, unknown>) => {
    upsertNoteCalls.push({ slug, id, args });
    return { project: slug, note: { id: id ?? 99, header: args['header'] ?? '', body: args['body'] ?? '' } };
  },
  createTodo: async () => ({ todo: {} }),
  updateTodo: async (slug: string, id: number, args: Record<string, unknown>) => {
    todoUpdateCalls.push({ slug, id, args });
    return { project: slug, todo: { id, title: args['title'] ?? '', detail: args['detail'] ?? '' } };
  },
  setTodoDone: async (slug: string, id: number, done: boolean) => {
    todoDoneCalls.push({ slug, id, done });
    return { project: slug, todo: { id, done } };
  },
  createFeedback: async () => ({ feedback: {} }),
  listFiles: async (slug: string) => ({ project: slug, files: [] }),
  readFile: async (slug: string, locator: { storedName?: string | null; id?: number | null }) => ({
    project: slug,
    file: {
      id: 1,
      project_id: 1,
      stored_name: locator.storedName ?? 'file.txt',
      description: null,
      content: 'hello-world',
      content_sha256: 'sha',
      mime_type: 'text/plain',
      size_bytes: 11,
      source_host_id: null,
      created_at: null,
      updated_at: null,
    },
  }),
  upsertFile: async (slug: string, payload: Record<string, unknown>) => ({
    project: slug,
    file: { id: 1, stored_name: payload['stored_name'] ?? 'a.txt', content: payload['content'] ?? '' },
  }),
  deleteFile: async (slug: string, id: number) => ({ project: slug, deleted: id }),
  listMemories: async (slug: string, payload: Record<string, unknown>) => {
    memoryListCalls.push({ slug, payload });
    return { project: slug, count: 0, truncated: false, memories: [] };
  },
  getMemory: async (slug: string, key: string) => ({ project: slug, status: 'found', id: key, memory: null }),
  upsertMemory: async (slug: string, payload: Record<string, unknown>) => ({
    project: slug,
    status: 'created',
    id: payload['key'],
    memory: null,
  }),
  deleteMemory: async (slug: string, key: string) => ({ project: slug, status: 'deleted', id: key }),
  searchMemories: async (slug: string, payload: Record<string, unknown>) => {
    memorySearchCalls.push({ slug, payload });
    return { project: slug, query: payload['query'] ?? '', count: 0, degraded: false, matches: [] };
  },
} as unknown as HostProjectsService;

const stubSkills = {
  listSkills: async () => ({ engine: 'codex' as const, skills: [] }),
  retrieve: async (slug: string) => ({ slug, status: 'missing' }),
  store: async (payload: Record<string, unknown>, host: Host) => {
    skillStoreCalls.push({ payload, host });
    return { status: 'created', slug: payload['slug'] };
  },
  deleteSkill: async (slug: string, host: Host) => {
    skillDeleteCalls.push({ slug, host });
    return { status: 'deleted', slug };
  },
} as unknown as HostSkillsService;

const stubResources = {
  list: async () => [{ uri: 'skill://agentic', name: 'agentic', mimeType: 'text/markdown' }],
  read: async (uri: string) => ({ contents: [{ uri, mimeType: 'text/markdown', text: '# Skill' }] }),
  create: async (uri: string) => ({ status: 'created', uri }),
  update: async (uri: string) => ({ status: 'updated', uri }),
  delete: async (uri: string) => ({ status: 'deleted', uri }),
} as unknown as McpResourcesService;

interface SharedCall {
  method: string;
  args: Record<string, unknown>;
  engine: unknown;
}

const sharedCalls: SharedCall[] = [];
const stubSharedMemories = {
  list: async (args: Record<string, unknown>) => {
    sharedCalls.push({ method: 'list', args, engine: undefined });
    return { status: 'ok', count: 0, memories: [] };
  },
  search: async (args: Record<string, unknown>) => {
    sharedCalls.push({ method: 'search', args, engine: undefined });
    return { status: 'ok', count: 0, degraded: false, matches: [] };
  },
  read: async (args: Record<string, unknown>) => {
    sharedCalls.push({ method: 'read', args, engine: undefined });
    return { status: 'found', slug: args['slug'], content: '# doc' };
  },
  write: async (args: Record<string, unknown>, _host: Host, engine: unknown) => {
    sharedCalls.push({ method: 'write', args, engine });
    return { status: 'created', slug: args['slug'] };
  },
  append: async (args: Record<string, unknown>, _host: Host, engine: unknown) => {
    sharedCalls.push({ method: 'append', args, engine });
    return { status: 'appended', slug: args['slug'] };
  },
  delete: async (args: Record<string, unknown>, _host: Host, engine: unknown) => {
    sharedCalls.push({ method: 'delete', args, engine });
    return { status: 'deleted', slug: args['slug'] };
  },
} as unknown as SharedMemoriesService;

const host: Host = { id: 1, fqdn: 'example.com' } as unknown as Host;

describe('McpToolsRegistry', () => {
  const registry = new McpToolsRegistry({ memories: stubMemories, projects: stubProjects, skills: stubSkills });

  it('lists tools including the memory_* set', () => {
    const list = registry.list().map((t) => t.name);
    expect(list).toContain('memory_store');
    expect(list).toContain('memory_retrieve');
    expect(list).toContain('memory_search');
    expect(list).toContain('memory_delete');
    expect(list).toContain('skill_list');
    expect(list).toContain('project_bootstrap');
  });

  it('does not expose an engine override on skill_list', () => {
    const definition = registry.list().find((tool) => tool.name === 'skill_list');
    expect(definition?.inputSchema['properties']).toEqual({});
    expect(definition?.description).toMatch(/authoritative first step/i);
    expect(definition?.description).toMatch(/before consulting local Skill files/i);
  });

  it('registers and dispatches the host Skill mutation tools', async () => {
    const tools = registry.list();
    const store = tools.find((tool) => tool.name === 'skill_store');
    const remove = tools.find((tool) => tool.name === 'skill_delete');
    expect(store?.inputSchema).toMatchObject({
      properties: {
        slug: { type: 'string' },
        manifest: { type: 'string' },
        display_name: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['slug', 'manifest'],
    });
    expect(remove?.inputSchema).toMatchObject({
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    });
    expect(store?.inputSchema['properties']).not.toHaveProperty('engine');
    expect(remove?.inputSchema['properties']).not.toHaveProperty('engine');

    const payload = {
      slug: 'release-check',
      manifest: '---\nname: release-check\ndescription: Check\n---\n\nCheck\n',
      display_name: 'Release Check',
    };
    await expect(registry.dispatch('skill_store', payload, host, 'host', 'claude')).resolves.toMatchObject({
      isError: false,
    });
    expect(skillStoreCalls.at(-1)).toEqual({ payload, host });

    await expect(
      registry.dispatch('skill_delete', 'release-check' as unknown as Record<string, unknown>, host),
    ).resolves.toMatchObject({ isError: false });
    expect(skillDeleteCalls.at(-1)).toEqual({ slug: 'release-check', host });
  });

  it('requires the complete Skill mutation payload', async () => {
    await expect(registry.dispatch('skill_store', { slug: 'release-check' }, host)).resolves.toMatchObject({
      isError: true,
    });
    await expect(registry.dispatch('skill_delete', {}, host)).resolves.toMatchObject({
      isError: true,
    });
  });

  it('rejects malformed or extra Skill mutation fields before dispatch', async () => {
    const beforeStore = skillStoreCalls.length;
    const beforeDelete = skillDeleteCalls.length;

    await expect(
      registry.dispatch('skill_store', { slug: 'bad', manifest: { body: 'no' } }, host),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      registry.dispatch('skill_store', { slug: 'bad', manifest: 'Body', display_name: 7 }, host),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      registry.dispatch('skill_store', { slug: 'bad', manifest: 'Body', engine: 'codex' }, host),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      registry.dispatch('skill_delete', { slug: ['bad'] }, host),
    ).resolves.toMatchObject({ isError: true });

    expect(skillStoreCalls).toHaveLength(beforeStore);
    expect(skillDeleteCalls).toHaveLength(beforeDelete);
  });

  it('registers the project_file_* CRUD tools', () => {
    const list = registry.list().map((t) => t.name);
    expect(list).toContain('project_file_list');
    expect(list).toContain('project_file_read');
    expect(list).toContain('project_file_upsert');
    expect(list).toContain('project_file_delete');
  });

  it('omits the shared_memory_* tools when no shared memory service is wired', () => {
    const list = registry.list().map((t) => t.name);
    expect(list).not.toContain('shared_memory_list');
    expect(registry.has('shared_memory_list')).toBe(false);
  });

  it('omits the secret_* tools when no secrets service is wired', () => {
    // A registry built for a narrower surface must not be able to hand out
    // credentials — absent, not merely refused.
    const list = registry.list().map((t) => t.name);
    for (const name of ['secret_list', 'secret_search', 'secret_get']) {
      expect(list).not.toContain(name);
      expect(registry.has(name)).toBe(false);
    }
  });

  it('registers the project_memory_* CRUD tools', () => {
    const list = registry.list().map((t) => t.name);
    expect(list).toContain('project_memory_list');
    expect(list).toContain('project_memory_get');
    expect(list).toContain('project_memory_upsert');
    expect(list).toContain('project_memory_delete');
    expect(list).toContain('project_memory_search');
  });

  // The reason project_memory_* exists at all. memory_search marks `query`
  // required, and validateAgainstSchema rejects '', so host memories cannot be
  // enumerated over MCP -- a fresh agent can only guess search terms. Project
  // memory must never inherit that.
  it('lets project_memory_search run without a query so memories stay enumerable', async () => {
    const search = registry.list().find((t) => t.name === 'project_memory_search');
    expect(search?.inputSchema['required']).toEqual(['slug']);
    expect(search?.inputSchema['required']).not.toContain('query');

    const res = await registry.dispatch('project_memory_search', { slug: 'demo' }, host);
    expect(res).toMatchObject({ isError: false });
  });

  it('dispatches project_memory_list without requiring anything but a slug', async () => {
    const res = await registry.dispatch('project_memory_list', { slug: 'demo' }, host);
    expect(res).toMatchObject({ isError: false });
    expect(memoryListCalls.at(-1)).toMatchObject({ slug: 'demo' });
  });

  it('resolves a bare scalar to the slug for the memory listing tools', async () => {
    await registry.dispatch('project_memory_list', 'demo' as unknown as Record<string, unknown>, host);
    expect(memoryListCalls.at(-1)).toMatchObject({ slug: 'demo' });

    await registry.dispatch('project_memory_search', 'demo' as unknown as Record<string, unknown>, host);
    expect(memorySearchCalls.at(-1)).toMatchObject({ slug: 'demo' });
  });

  it('rejects a bare scalar for project_memory_get, which needs two args', async () => {
    const res = await registry.dispatch('project_memory_get', 'demo' as unknown as Record<string, unknown>, host);
    expect(res).toMatchObject({ isError: true });
    expect((res as { content: Array<{ text: string }> }).content[0]!.text).toContain('slug');
  });

  it('resolves dot aliases for the memory tools', async () => {
    const res = await registry.dispatch('project.memory.upsert', { slug: 'demo', key: 'k', content: 'c' }, host);
    expect(res).toMatchObject({ isError: false });
  });

  it('requires key and content on project_memory_upsert', async () => {
    const res = await registry.dispatch('project_memory_upsert', { slug: 'demo' }, host);
    expect(res).toMatchObject({ isError: true });
  });

  it('advertises all accepted project feedback types', () => {
    const feedback = registry.list().find((t) => t.name === 'project_feedback_create');
    expect(feedback?.inputSchema).toMatchObject({
      properties: {
        type: { enum: ['bug', 'feature', 'note', 'issue', 'test'] },
      },
    });
  });

  it('registers resource_* tools when a resource service is wired', async () => {
    const reg = new McpToolsRegistry({
      memories: stubMemories,
      projects: stubProjects,
      skills: stubSkills,
      resources: stubResources,
    });
    const list = reg.list().map((t) => t.name);
    expect(list).toContain('resource_list');
    expect(list).toContain('resource_read');
    expect(list).toContain('resource_create');
    expect(list).toContain('resource_update');
    expect(list).toContain('resource_delete');

    const read = await reg.dispatch('resource_read', { uri: 'skill://agentic' }, host);
    expect(read).toMatchObject({ isError: false });
    expect((read as { content: Array<{ text: string }> }).content[0]!.text).toContain('Skill');
  });

  it('dispatch project_file_read returns the file content', async () => {
    const r = await registry.dispatch(
      'project_file_read',
      { slug: 'demo', stored_name: 'README.md' },
      host,
    );
    expect(r).toMatchObject({ isError: false });
    const text = (r as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain('hello-world');
    expect(text).toContain('README.md');
  });

  it('dispatch project_file_upsert echoes stored_name + content', async () => {
    const r = await registry.dispatch(
      'project_file_upsert',
      { slug: 'demo', stored_name: 'NOTES.md', content: 'new body' },
      host,
    );
    expect(r).toMatchObject({ isError: false });
    const text = (r as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain('NOTES.md');
    expect(text).toContain('new body');
  });

  it('dispatch project_file_delete returns the deleted id', async () => {
    const r = await registry.dispatch('project_file_delete', { slug: 'demo', id: 42 }, host);
    expect(r).toMatchObject({ isError: false });
    expect((r as { content: Array<{ text: string }> }).content[0]!.text).toContain('42');
  });

  it('reports has() correctly for known + unknown tools', () => {
    expect(registry.has('memory_store')).toBe(true);
    expect(registry.has('memory.store')).toBe(true); // dotted alias normalizes
    expect(registry.has('nope_tool')).toBe(false);
  });

  it('dispatch wraps successful result in content envelope', async () => {
    const r = await registry.dispatch('memory_retrieve', { id: 'foo' }, host);
    expect(r).toMatchObject({ isError: false });
    expect((r as { content: Array<{ text: string }> }).content[0]!.text).toContain('foo');
  });

  it('dispatch normalizes scalar args per tool', async () => {
    const r = await registry.dispatch('memory_retrieve', 'bar', host);
    expect((r as { content: Array<{ text: string }> }).content[0]!.text).toContain('bar');
  });

  it('dispatch returns isError for unknown tool name', async () => {
    const r = await registry.dispatch('nope_tool', {}, host);
    expect((r as { isError: boolean }).isError).toBe(true);
    expect((r as { content: Array<{ text: string }> }).content[0]!.text).toMatch(/not found/i);
  });

  it('normalizeName rejects empty + bad characters', () => {
    expect(() => registry.normalizeName('')).toThrow(/required/);
    expect(() => registry.normalizeName('bad name!')).toThrow(/match/);
  });

  it('wrapContent preserves an already-wrapped content envelope', () => {
    const x = wrapContent({ content: [{ type: 'text', text: 'hi' }] });
    expect(x).toMatchObject({ isError: false });
  });

  it('exposes project_note_upsert + project_todo update/done/undone in the catalog', () => {
    const list = registry.list().map((t) => t.name);
    expect(list).toContain('project_note_upsert');
    expect(list).toContain('project_todo_update');
    expect(list).toContain('project_todo_done');
    expect(list).toContain('project_todo_undone');
  });

  it('project_note_upsert forwards id=null when id is missing', async () => {
    upsertNoteCalls.length = 0;
    const r = await registry.dispatch(
      'project_note_upsert',
      { slug: 'demo', header: 'h', body: 'b' },
      host,
    );
    expect((r as { isError: boolean }).isError).toBe(false);
    expect(upsertNoteCalls.at(-1)).toMatchObject({ slug: 'demo', id: null });
    expect(upsertNoteCalls.at(-1)!.args).toMatchObject({ header: 'h', body: 'b' });
  });

  it('project_note_upsert forwards numeric id when provided', async () => {
    upsertNoteCalls.length = 0;
    await registry.dispatch(
      'project_note_upsert',
      { slug: 'demo', id: 42, header: 'h', body: 'b' },
      host,
    );
    expect(upsertNoteCalls.at(-1)).toMatchObject({ slug: 'demo', id: 42 });
  });

  it('project_todo_update routes to updateTodo with numeric id', async () => {
    todoUpdateCalls.length = 0;
    await registry.dispatch(
      'project_todo_update',
      { slug: 'demo', id: 7, title: 'new', detail: 'd' },
      host,
    );
    expect(todoUpdateCalls.at(-1)).toMatchObject({ slug: 'demo', id: 7 });
    expect(todoUpdateCalls.at(-1)!.args).toMatchObject({ title: 'new', detail: 'd' });
  });

  it('project_todo_done calls setTodoDone with done=true', async () => {
    todoDoneCalls.length = 0;
    await registry.dispatch('project_todo_done', { slug: 'demo', id: 5 }, host);
    expect(todoDoneCalls.at(-1)).toEqual({ slug: 'demo', id: 5, done: true });
  });

  it('project_todo_undone calls setTodoDone with done=false', async () => {
    todoDoneCalls.length = 0;
    await registry.dispatch('project_todo_undone', { slug: 'demo', id: 5 }, host);
    expect(todoDoneCalls.at(-1)).toEqual({ slug: 'demo', id: 5, done: false });
  });

  describe('capability gating', () => {
    const stubFs = {
      readFile: async () => ({ path: 'a.txt', content: 'x', size: 1, sha256: 'h', truncated: false }),
      writeFile: async () => ({ path: 'a.txt', bytes_written: 1 }),
      listDir: async () => ({ path: '.', entries: [], truncated: false }),
      fileExists: async () => ({ path: 'a.txt', exists: false }),
      stat: async () => ({ path: 'a.txt', type: 'file' as const, size: 0, mode: 0, mtime: '', ctime: '', uid: 0, gid: 0 }),
      searchInFiles: async () => ({ path: '.', matches: [], truncated: false }),
    } as unknown as McpFsTools;

    const reg = new McpToolsRegistry({
      memories: stubMemories,
      projects: stubProjects,
      skills: stubSkills,
      fs: stubFs,
    });

    it('exposes only host tools to a host caller', () => {
      const hostNames = reg.list('host').map((t) => t.name);
      expect(hostNames).toContain('memory_store');
      expect(hostNames).toContain('skill_list');
      // Operator-only fs_* tools must be invisible.
      expect(hostNames).not.toContain('fs_read_file');
      expect(hostNames).not.toContain('fs_write_file');
      expect(hostNames).not.toContain('fs_list_dir');
      expect(hostNames).not.toContain('fs_stat');
      expect(hostNames).not.toContain('fs_file_exists');
      expect(hostNames).not.toContain('fs_search_in_files');
    });

    it('exposes operator + host tools to an operator caller', () => {
      const names = reg.list('operator').map((t) => t.name);
      expect(names).toContain('memory_store');
      expect(names).toContain('fs_read_file');
      expect(names).toContain('fs_write_file');
      expect(names).toContain('fs_list_dir');
      expect(names).toContain('fs_stat');
      expect(names).toContain('fs_file_exists');
      expect(names).toContain('fs_search_in_files');
    });

    it('has() respects capability', () => {
      expect(reg.has('fs_read_file', 'host')).toBe(false);
      expect(reg.has('fs_read_file', 'operator')).toBe(true);
      expect(reg.has('memory_store', 'host')).toBe(true);
      expect(reg.has('memory_store', 'operator')).toBe(true);
    });

    it('dispatch rejects operator tools from a host caller as method-not-found', async () => {
      const r = await reg.dispatch('fs_read_file', { path: 'x' }, host, 'host');
      expect((r as { isError: boolean }).isError).toBe(true);
      expect((r as { content: Array<{ text: string }> }).content[0]!.text).toMatch(/not found/i);
    });

    it('dispatch allows operator callers to invoke operator tools', async () => {
      const r = await reg.dispatch('fs_read_file', { path: 'x' }, host, 'operator');
      expect((r as { isError: boolean }).isError).toBe(false);
    });

    it('registry built without fs deps does not expose fs_* at all', () => {
      const noFs = new McpToolsRegistry({ memories: stubMemories, projects: stubProjects, skills: stubSkills });
      const opNames = noFs.list('operator').map((t) => t.name);
      expect(opNames).not.toContain('fs_read_file');
    });
  });
});

describe('shared_memory_* tools', () => {
  const reg = new McpToolsRegistry({
    memories: stubMemories,
    sharedMemories: stubSharedMemories,
    projects: stubProjects,
    skills: stubSkills,
  });

  it('registers the full shared memory surface', () => {
    const names = reg.list().map((t) => t.name);
    expect(names).toContain('shared_memory_list');
    expect(names).toContain('shared_memory_search');
    expect(names).toContain('shared_memory_read');
    expect(names).toContain('shared_memory_write');
    expect(names).toContain('shared_memory_append');
    expect(names).toContain('shared_memory_delete');
  });

  // The whole point of the substrate: a zero-knowledge agent must be able to
  // enumerate it. `memory_search` requires a query and therefore cannot be
  // listed at all -- shared_memory_list must never inherit that.
  it('lets shared_memory_list run with no arguments at all', async () => {
    const list = reg.list().find((t) => t.name === 'shared_memory_list');
    expect(list?.inputSchema['required']).toBeUndefined();

    const res = await reg.dispatch('shared_memory_list', {}, host);
    expect(res).toMatchObject({ isError: false });
    expect(sharedCalls.at(-1)).toMatchObject({ method: 'list' });
  });

  it('requires a query for search and a slug for read/write/append/delete', () => {
    const required = (name: string) => reg.list().find((t) => t.name === name)?.inputSchema['required'];
    expect(required('shared_memory_search')).toEqual(['query']);
    expect(required('shared_memory_read')).toEqual(['slug']);
    expect(required('shared_memory_write')).toEqual(['slug', 'content']);
    expect(required('shared_memory_append')).toEqual(['slug', 'content']);
    expect(required('shared_memory_delete')).toEqual(['slug']);
  });

  it('reports a missing required field instead of dispatching', async () => {
    const res = await reg.dispatch('shared_memory_write', { slug: 'x' }, host);
    expect((res as { isError: boolean }).isError).toBe(true);
    expect((res as { content: Array<{ text: string }> }).content[0]!.text).toMatch(/content/);
  });

  it('normalizes bare scalars per tool', async () => {
    await reg.dispatch('shared_memory_read', 'ops.crane' as unknown as Record<string, unknown>, host);
    expect(sharedCalls.at(-1)).toMatchObject({ method: 'read', args: { slug: 'ops.crane' } });

    await reg.dispatch('shared_memory_search', 'crane' as unknown as Record<string, unknown>, host);
    expect(sharedCalls.at(-1)).toMatchObject({ method: 'search', args: { query: 'crane' } });

    await reg.dispatch('shared_memory_delete', 'ops.crane' as unknown as Record<string, unknown>, host);
    expect(sharedCalls.at(-1)).toMatchObject({ method: 'delete', args: { slug: 'ops.crane' } });

    await reg.dispatch('shared_memory_list', 'ops.' as unknown as Record<string, unknown>, host);
    expect(sharedCalls.at(-1)).toMatchObject({ method: 'list', args: { prefix: 'ops.' } });
  });

  it('accepts dot aliases like the rest of the surface', async () => {
    const res = await reg.dispatch('shared.memory.read', { slug: 'a' }, host);
    expect(res).toMatchObject({ isError: false });
  });

  it('threads the engine into writes as provenance', async () => {
    await reg.dispatch('shared_memory_write', { slug: 'a', content: 'b' }, host, 'host', 'claude');
    expect(sharedCalls.at(-1)).toMatchObject({ method: 'write', engine: 'claude' });

    await reg.dispatch('shared_memory_append', { slug: 'a', content: 'b' }, host, 'host', 'codex');
    expect(sharedCalls.at(-1)).toMatchObject({ method: 'append', engine: 'codex' });

    // No X-Engine header on the request means null provenance, not a Codex default.
    await reg.dispatch('shared_memory_write', { slug: 'a', content: 'b' }, host);
    expect(sharedCalls.at(-1)).toMatchObject({ method: 'write', engine: null });
  });

  it('is visible to host callers, not operator-only', () => {
    expect(reg.has('shared_memory_list', 'host')).toBe(true);
    expect(reg.has('shared_memory_write', 'host')).toBe(true);
  });
});

describe('secret_* tools', () => {
  interface SecretCall {
    method: string;
    arg: string;
    engine: string | null;
  }
  let secretCalls: SecretCall[] = [];
  const stubSecrets = {
    listForHost: async (engine: string | null) => {
      secretCalls.push({ method: 'list', arg: '', engine });
      return [{ slug: 'gh-pat' }];
    },
    searchForHost: async (query: string, engine: string | null) => {
      secretCalls.push({ method: 'search', arg: query, engine });
      return [];
    },
    getForHost: async (slug: string, _host: Host, engine: string | null) => {
      secretCalls.push({ method: 'get', arg: slug, engine });
      return { slug, value: 'ghp_x' };
    },
  } as unknown as SecretsService;

  const reg = new McpToolsRegistry({
    memories: stubMemories,
    projects: stubProjects,
    skills: stubSkills,
    secrets: stubSecrets,
  });

  beforeEach(() => {
    secretCalls = [];
  });

  it('registers the read-only secrets surface and nothing that writes', () => {
    const names = reg.list().map((t) => t.name);
    expect(names).toContain('secret_list');
    expect(names).toContain('secret_search');
    expect(names).toContain('secret_get');
    // There is no MCP write path: secrets are authored through the admin API.
    expect(names.filter((n) => n.startsWith('secret_'))).toHaveLength(3);
  });

  // The discovery premise: an agent that knows nothing must be able to find out
  // what credentials exist without already knowing a slug.
  it('lets secret_list run with no arguments at all', async () => {
    const res = await reg.dispatch('secret_list', {}, host);
    expect(res).toMatchObject({ isError: false });
    expect(secretCalls.at(-1)).toMatchObject({ method: 'list' });
  });

  it('lets secret_search run without a query, degrading to a listing', async () => {
    const res = await reg.dispatch('secret_search', {}, host);
    expect(res).toMatchObject({ isError: false });
    expect(secretCalls.at(-1)).toMatchObject({ method: 'search', arg: '' });
  });

  it('rejects secret_get without a slug', async () => {
    const res = await reg.dispatch('secret_get', {}, host);
    expect(res).toMatchObject({ isError: true });
  });

  it('normalizes a bare scalar into the useful field', async () => {
    await reg.dispatch('secret_get', 'gh-pat' as unknown as Record<string, unknown>, host);
    expect(secretCalls.at(-1)).toMatchObject({ method: 'get', arg: 'gh-pat' });

    await reg.dispatch('secret_search', 'github' as unknown as Record<string, unknown>, host);
    expect(secretCalls.at(-1)).toMatchObject({ method: 'search', arg: 'github' });
  });

  it('threads the engine through so engine-scoped secrets stay scoped', async () => {
    await reg.dispatch('secret_list', {}, host, 'host', 'claude');
    expect(secretCalls.at(-1)).toMatchObject({ engine: 'claude' });

    // An absent X-Engine header keeps the legacy codex default, as everywhere else.
    await reg.dispatch('secret_get', { slug: 'a' }, host);
    expect(secretCalls.at(-1)).toMatchObject({ engine: 'codex' });
  });

  it('is visible to host callers, not operator-only', () => {
    // The user's call: any enrolled host agent may read. If these were operator
    // tools the store would be invisible to the agents it exists for.
    expect(reg.has('secret_list', 'host')).toBe(true);
    expect(reg.has('secret_get', 'host')).toBe(true);
  });

  it('accepts dot aliases like the rest of the surface', async () => {
    const res = await reg.dispatch('secret.get', { slug: 'a' }, host);
    expect(res).toMatchObject({ isError: false });
  });
});
