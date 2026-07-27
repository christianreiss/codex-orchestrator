import { describe, it, expect } from 'vitest';
import { McpResourcesService } from '../../../src/services/mcp-resources.js';
import { McpToolsRegistry } from '../../../src/services/mcp-tools.js';
import { McpServer, type DispatchContext } from '../../../src/services/mcp-server.js';
import type { McpMemoriesService } from '../../../src/services/mcp-memories.js';
import type { HostProjectsService } from '../../../src/services/host-projects.js';
import type { HostSkillsService } from '../../../src/services/host-skills.js';
import type { SharedMemoriesService } from '../../../src/services/shared-memories.js';
import type { McpAccessLogService } from '../../../src/services/mcp-access-log.js';
import type { Host } from '../../../src/db/schema.js';

const noopAccess = { log: async () => undefined } as unknown as McpAccessLogService;

interface SeededFile {
  id: number;
  project_id: number;
  stored_name: string;
  description: string | null;
  content: string;
  content_sha256: string;
  mime_type: string | null;
  size_bytes: number;
  source_host_id: number | null;
  created_at: string | null;
  updated_at: string | null;
}

interface SeededMemory {
  id: number;
  key: string;
  content: string;
  tags: string[];
}

function makeStubProjects(): {
  service: HostProjectsService;
  seedFile: (slug: string, file: Partial<SeededFile> & { stored_name: string }) => void;
  seedMemory: (slug: string, memory: Partial<SeededMemory> & { key: string }) => void;
} {
  const byProject = new Map<string, SeededFile[]>();
  const memsByProject = new Map<string, SeededMemory[]>();
  let nextId = 1;
  let nextMemId = 1;

  const seedMemory = (slug: string, memory: Partial<SeededMemory> & { key: string }) => {
    const list = memsByProject.get(slug) ?? [];
    list.push({
      id: memory.id ?? nextMemId++,
      key: memory.key,
      content: memory.content ?? '',
      tags: memory.tags ?? [],
    });
    memsByProject.set(slug, list);
    if (!byProject.has(slug)) byProject.set(slug, []);
  };

  const seedFile = (slug: string, file: Partial<SeededFile> & { stored_name: string }) => {
    const list = byProject.get(slug) ?? [];
    const row: SeededFile = {
      id: file.id ?? nextId++,
      project_id: 1,
      stored_name: file.stored_name,
      description: file.description ?? null,
      content: file.content ?? '',
      content_sha256: file.content_sha256 ?? 'sha',
      mime_type: file.mime_type ?? 'text/plain',
      size_bytes: file.size_bytes ?? (file.content ?? '').length,
      source_host_id: null,
      created_at: null,
      updated_at: null,
    };
    list.push(row);
    byProject.set(slug, list);
  };

  const service = {
    listProjects: async () => ({
      projects: Array.from(byProject.keys()).map((slug) => ({
        slug,
        title: slug,
        name: slug,
        description: '',
        about: null,
        latest_seq: 0,
        created_at: null,
        updated_at: null,
      })),
    }),
    bootstrap: async (slug: string) => ({ project: slug, recent_files: byProject.get(slug) ?? [] }),
    projectDetail: async (slug: string) => ({ project: { slug } }),
    listChanges: async (slug: string) => ({ project: slug, changes: [] }),
    createProject: async () => ({ project: { slug: 'x' } }),
    upsertNote: async () => ({ note: {} }),
    createTodo: async () => ({ todo: {} }),
    createFeedback: async () => ({ feedback: {} }),
    listFiles: async (slug: string) => ({ project: slug, files: byProject.get(slug) ?? [] }),
    readFile: async (
      slug: string,
      locator: { storedName?: string | null; id?: number | null },
    ) => {
      const files = byProject.get(slug) ?? [];
      let file: SeededFile | undefined;
      if (typeof locator.id === 'number' && locator.id > 0) {
        file = files.find((f) => f.id === locator.id);
      } else if (typeof locator.storedName === 'string' && locator.storedName !== '') {
        file = files.find((f) => f.stored_name === locator.storedName);
      }
      if (!file) {
        const err = new Error('Project file not found');
        throw err;
      }
      return { project: slug, file };
    },
    upsertFile: async (slug: string, payload: Record<string, unknown>) => {
      const list = byProject.get(slug) ?? [];
      const storedName = String(payload['stored_name'] ?? '');
      const existing = list.find((f) => f.stored_name === storedName);
      if (existing) {
        existing.content = String(payload['content'] ?? '');
      } else {
        const row: SeededFile = {
          id: nextId++,
          project_id: 1,
          stored_name: storedName,
          description: (payload['description'] as string | undefined) ?? null,
          content: String(payload['content'] ?? ''),
          content_sha256: 'sha',
          mime_type: (payload['mime_type'] as string | undefined) ?? null,
          size_bytes: 0,
          source_host_id: null,
          created_at: null,
          updated_at: null,
        };
        list.push(row);
        byProject.set(slug, list);
      }
      const saved = (byProject.get(slug) ?? []).find((f) => f.stored_name === storedName)!;
      return { project: slug, file: saved };
    },
    deleteFile: async (slug: string, id: number) => {
      const list = byProject.get(slug) ?? [];
      const idx = list.findIndex((f) => f.id === id);
      if (idx >= 0) list.splice(idx, 1);
      return { project: slug, deleted: id };
    },
    listMemories: async (slug: string, payload: Record<string, unknown>) => {
      const list = memsByProject.get(slug) ?? [];
      const includeContent = payload['include_content'] === true;
      return {
        project: slug,
        count: list.length,
        truncated: false,
        memories: list.map((m) =>
          includeContent
            ? { id: m.id, key: m.key, content: m.content, tags: m.tags }
            : { id: m.id, key: m.key, tags: m.tags, content_length: m.content.length, preview: m.content.slice(0, 280) },
        ),
      };
    },
    getMemory: async (slug: string, key: string) => {
      const found = (memsByProject.get(slug) ?? []).find((m) => m.key === key) ?? null;
      return { project: slug, status: found ? 'found' : 'missing', id: key, memory: found };
    },
    upsertMemory: async (slug: string, payload: Record<string, unknown>) => {
      const key = String(payload['key'] ?? '');
      const list = memsByProject.get(slug) ?? [];
      const existing = list.find((m) => m.key === key);
      if (existing) {
        existing.content = String(payload['content'] ?? '');
        memsByProject.set(slug, list);
        return { project: slug, status: 'updated', id: key, memory: existing };
      }
      const row: SeededMemory = { id: nextMemId++, key, content: String(payload['content'] ?? ''), tags: [] };
      list.push(row);
      memsByProject.set(slug, list);
      return { project: slug, status: 'created', id: key, memory: row };
    },
    deleteMemory: async (slug: string, key: string) => {
      const list = memsByProject.get(slug) ?? [];
      const idx = list.findIndex((m) => m.key === key);
      if (idx >= 0) list.splice(idx, 1);
      return { project: slug, status: idx >= 0 ? 'deleted' : 'missing', id: key };
    },
    searchMemories: async (slug: string) => ({ project: slug, query: '', count: 0, degraded: false, matches: [] }),
  } as unknown as HostProjectsService;

  return { service, seedFile, seedMemory };
}

const stubMemories = {
  store: async () => ({}),
  retrieve: async () => ({}),
  search: async () => ({}),
  delete: async () => ({}),
} as unknown as McpMemoriesService;

const stubSkills = {
  listSkills: async () => ({ engine: 'codex', skills: [] }),
  retrieve: async () => ({}),
} as unknown as HostSkillsService;

const host: Host = { id: 1, fqdn: 'h.example' } as unknown as Host;
const ctx: DispatchContext = { host, clientIp: '127.0.0.1', serverVersion: 'test' };

describe('McpResourcesService project:// scheme', () => {
  it('templates list includes project file template', () => {
    const { service } = makeStubProjects();
    const res = new McpResourcesService({
      memories: stubMemories,
      projects: service,
      skills: stubSkills,
    });
    const templates = res.listTemplates();
    expect(templates.some((t) => t['uriTemplate'] === 'project://{slug}/files/{stored_name}')).toBe(
      true,
    );
  });

  it('list() enumerates per-project files after the project entry', async () => {
    const { service, seedFile } = makeStubProjects();
    seedFile('demo', { stored_name: 'README.md', content: 'hello', mime_type: 'text/markdown' });
    seedFile('demo', { stored_name: 'spec.json', content: '{}', mime_type: 'application/json' });
    const res = new McpResourcesService({
      memories: stubMemories,
      projects: service,
      skills: stubSkills,
    });
    const list = await res.list(host);
    const uris = list.map((r) => r.uri);
    expect(uris).toContain('project://demo');
    expect(uris).toContain('project://demo/files/README.md');
    expect(uris).toContain('project://demo/files/spec.json');
    const readme = list.find((r) => r.uri === 'project://demo/files/README.md');
    expect(readme?.mimeType).toBe('text/markdown');
    expect(readme?.name).toBe('README.md');
  });

  it('templates list includes the project memory template', () => {
    const { service } = makeStubProjects();
    const res = new McpResourcesService({ memories: stubMemories, projects: service, skills: stubSkills });
    const templates = res.listTemplates();
    expect(templates.some((t) => t['uriTemplate'] === 'project://{slug}/memory/{key}')).toBe(true);
  });

  it('list() enumerates per-project memories with previews as descriptions', async () => {
    const { service, seedMemory } = makeStubProjects();
    seedMemory('demo', { key: 'deploy.crane', content: 'ship via FQDN' });
    seedMemory('demo', { key: 'auth.bootstrap', content: 'serve canonical' });
    const res = new McpResourcesService({ memories: stubMemories, projects: service, skills: stubSkills });

    const list = await res.list(host);
    const uris = list.map((r) => r.uri);
    expect(uris).toContain('project://demo/memory/deploy.crane');
    expect(uris).toContain('project://demo/memory/auth.bootstrap');
    const deploy = list.find((r) => r.uri === 'project://demo/memory/deploy.crane');
    expect(deploy?.description).toBe('ship via FQDN');
    expect(deploy?.mimeType).toBe('application/json');
  });

  it('list() keeps the project entry when memory listing throws', async () => {
    const { service, seedMemory } = makeStubProjects();
    seedMemory('demo', { key: 'k', content: 'v' });
    (service as unknown as { listMemories: () => Promise<never> }).listMemories = async () => {
      throw new Error('boom');
    };
    const res = new McpResourcesService({ memories: stubMemories, projects: service, skills: stubSkills });

    const list = await res.list(host);
    expect(list.map((r) => r.uri)).toContain('project://demo');
  });

  it('read() resolves a single memory by key', async () => {
    const { service, seedMemory } = makeStubProjects();
    seedMemory('demo', { key: 'deploy.crane', content: 'ship via FQDN' });
    const res = new McpResourcesService({ memories: stubMemories, projects: service, skills: stubSkills });

    const out = await res.read('project://demo/memory/deploy.crane', host);
    expect(out.contents[0]!.name).toBe('deploy.crane');
    expect(out.contents[0]!.mimeType).toBe('application/json');
    expect(out.contents[0]!.text).toContain('ship via FQDN');
  });

  it('read() round-trips a url-encoded memory key', async () => {
    const { service, seedMemory } = makeStubProjects();
    seedMemory('demo', { key: 'a:b', content: 'colon key' });
    const res = new McpResourcesService({ memories: stubMemories, projects: service, skills: stubSkills });

    const out = await res.read('project://demo/memory/a%3Ab', host);
    expect(out.contents[0]!.name).toBe('a:b');
    expect(out.contents[0]!.text).toContain('colon key');
  });

  it('create() and delete() operate on project memories', async () => {
    const { service } = makeStubProjects();
    const res = new McpResourcesService({ memories: stubMemories, projects: service, skills: stubSkills });

    const created = await res.create('project://demo/memory/new.key', { text: 'body' }, host);
    expect(created).toMatchObject({ status: 'created', id: 'new.key' });

    const read = await res.read('project://demo/memory/new.key', host);
    expect(read.contents[0]!.text).toContain('body');

    const deleted = await res.delete('project://demo/memory/new.key', host);
    expect(deleted).toMatchObject({ status: 'deleted' });
  });

  it('read() returns project bootstrap when no sub-path is given', async () => {
    const { service, seedFile } = makeStubProjects();
    seedFile('demo', { stored_name: 'README.md', content: 'hello' });
    const res = new McpResourcesService({
      memories: stubMemories,
      projects: service,
      skills: stubSkills,
    });
    const out = await res.read('project://demo', host);
    expect(out.contents[0]!.mimeType).toBe('application/json');
    expect(out.contents[0]!.text).toContain('demo');
  });

  it('read() resolves a single file by stored_name', async () => {
    const { service, seedFile } = makeStubProjects();
    seedFile('demo', {
      stored_name: 'README.md',
      content: 'hello-readme',
      mime_type: 'text/markdown',
    });
    const res = new McpResourcesService({
      memories: stubMemories,
      projects: service,
      skills: stubSkills,
    });
    const out = await res.read('project://demo/files/README.md', host);
    expect(out.contents).toHaveLength(1);
    expect(out.contents[0]!.mimeType).toBe('text/markdown');
    expect(out.contents[0]!.text).toBe('hello-readme');
    expect(out.contents[0]!.name).toBe('README.md');
  });

  it('read() falls back to application/octet-stream for binary mime types', async () => {
    const { service, seedFile } = makeStubProjects();
    seedFile('demo', {
      stored_name: 'logo.png',
      content: 'binary-bytes',
      mime_type: 'image/png',
    });
    const res = new McpResourcesService({
      memories: stubMemories,
      projects: service,
      skills: stubSkills,
    });
    const out = await res.read('project://demo/files/logo.png', host);
    expect(out.contents[0]!.mimeType).toBe('application/octet-stream');
  });

  it('read() handles stored_name with nested slashes', async () => {
    const { service, seedFile } = makeStubProjects();
    seedFile('demo', { stored_name: 'docs/api/openapi.yaml', content: 'paths: {}' });
    const res = new McpResourcesService({
      memories: stubMemories,
      projects: service,
      skills: stubSkills,
    });
    const out = await res.read('project://demo/files/docs/api/openapi.yaml', host);
    expect(out.contents[0]!.text).toBe('paths: {}');
    expect(out.contents[0]!.name).toBe('docs/api/openapi.yaml');
  });

  it('read() throws when the file does not exist', async () => {
    const { service } = makeStubProjects();
    const res = new McpResourcesService({
      memories: stubMemories,
      projects: service,
      skills: stubSkills,
    });
    await expect(res.read('project://demo/files/missing.txt', host)).rejects.toThrow();
  });
});

describe('McpServer integration with project_file_* tools', () => {
  it('tools/call project_file_read returns the file content', async () => {
    const { service, seedFile } = makeStubProjects();
    seedFile('demo', { stored_name: 'README.md', content: 'integration-content' });
    const tools = new McpToolsRegistry({
      memories: stubMemories,
      projects: service,
      skills: stubSkills,
    });
    const resources = new McpResourcesService({
      memories: stubMemories,
      projects: service,
      skills: stubSkills,
    });
    const server = new McpServer(tools, resources, noopAccess);
    const r = await server.handlePayload(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'project_file_read', arguments: { slug: 'demo', stored_name: 'README.md' } },
      },
      ctx,
    );
    const result = (r as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain('integration-content');
  });

  it('resources/read project://demo/files/README.md returns content via the server', async () => {
    const { service, seedFile } = makeStubProjects();
    seedFile('demo', {
      stored_name: 'README.md',
      content: 'served-via-resource',
      mime_type: 'text/markdown',
    });
    const tools = new McpToolsRegistry({
      memories: stubMemories,
      projects: service,
      skills: stubSkills,
    });
    const resources = new McpResourcesService({
      memories: stubMemories,
      projects: service,
      skills: stubSkills,
    });
    const server = new McpServer(tools, resources, noopAccess);
    const r = await server.handlePayload(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: { uri: 'project://demo/files/README.md' },
      },
      ctx,
    );
    const result = (r as { result: { contents: Array<{ text: string; mimeType: string }> } })
      .result;
    expect(result.contents[0]!.text).toBe('served-via-resource');
    expect(result.contents[0]!.mimeType).toBe('text/markdown');
  });

  it('tools/call project_file_upsert + project_file_list round-trips a new file', async () => {
    const { service } = makeStubProjects();
    const tools = new McpToolsRegistry({
      memories: stubMemories,
      projects: service,
      skills: stubSkills,
    });
    const resources = new McpResourcesService({
      memories: stubMemories,
      projects: service,
      skills: stubSkills,
    });
    const server = new McpServer(tools, resources, noopAccess);

    const upsert = await server.handlePayload(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'project_file_upsert',
          arguments: { slug: 'demo', stored_name: 'NEW.md', content: 'fresh' },
        },
      },
      ctx,
    );
    expect(
      (upsert as { result: { isError: boolean } }).result.isError,
    ).toBe(false);

    const list = await server.handlePayload(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'project_file_list', arguments: { slug: 'demo' } },
      },
      ctx,
    );
    const text = (list as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    expect(text).toContain('NEW.md');
    expect(text).toContain('fresh');
  });
});

describe('McpResourcesService shared:// scheme', () => {
  interface SharedDoc {
    slug: string;
    title: string;
    summary: string | null;
    content: string;
  }

  function makeStubSharedMemories(docs: SharedDoc[] = []) {
    const store = new Map(docs.map((d) => [d.slug, d]));
    const writes: Array<{ slug: string; content: string }> = [];
    const deletes: string[] = [];
    const service = {
      listRecent: async (limit = 20) =>
        Array.from(store.values())
          .slice(0, limit)
          .map((d) => ({
            slug: d.slug,
            title: d.title,
            summary: d.summary,
            preview: d.content.slice(0, 40),
            uri: `shared://${encodeURIComponent(d.slug)}`,
            tags: [],
            metadata: null,
            content_length: d.content.length,
            chunk_count: 1,
            revision: 1,
            sha256: 'sha',
            source_host_id: null,
            source_engine: null,
            created_at: null,
            updated_at: null,
          })),
      readForResource: async (slug: string) => {
        const found = store.get(slug);
        return found ? { summary: { title: found.title }, content: found.content } : null;
      },
      write: async (args: Record<string, unknown>) => {
        writes.push({ slug: String(args['slug']), content: String(args['content']) });
        return { status: 'created', slug: args['slug'] };
      },
      delete: async (args: Record<string, unknown>) => {
        deletes.push(String(args['slug']));
        return { status: 'deleted', slug: args['slug'] };
      },
    } as unknown as SharedMemoriesService;
    return { service, writes, deletes };
  }

  it('advertises the shared://{slug} template only when the service is wired', () => {
    const { service: projects } = makeStubProjects();
    const without = new McpResourcesService({ memories: stubMemories, projects, skills: stubSkills });
    expect(without.listTemplates().some((t) => t['uriTemplate'] === 'shared://{slug}')).toBe(false);

    const { service: shared } = makeStubSharedMemories();
    const withShared = new McpResourcesService({ memories: stubMemories, sharedMemories: shared, projects, skills: stubSkills });
    expect(withShared.listTemplates().some((t) => t['uriTemplate'] === 'shared://{slug}')).toBe(true);
  });

  it('list() enumerates shared memories with no project or host scoping', async () => {
    const { service: projects } = makeStubProjects();
    const { service: shared } = makeStubSharedMemories([
      { slug: 'ops.crane', title: 'Crane deploys', summary: 'how crane ships', content: '# Crane' },
      { slug: 'auth.bootstrap', title: 'Auth bootstrap', summary: null, content: 'bootstrap notes' },
    ]);
    const res = new McpResourcesService({ memories: stubMemories, sharedMemories: shared, projects, skills: stubSkills });

    const list = await res.list(host);
    const uris = list.map((r) => r.uri);
    expect(uris).toContain('shared://ops.crane');
    expect(uris).toContain('shared://auth.bootstrap');
    expect(list.find((r) => r.uri === 'shared://ops.crane')).toMatchObject({
      name: 'Crane deploys',
      description: 'how crane ships',
      mimeType: 'text/markdown',
    });
  });

  it('read() returns the document body as markdown', async () => {
    const { service: projects } = makeStubProjects();
    const { service: shared } = makeStubSharedMemories([
      { slug: 'ops.crane', title: 'Crane deploys', summary: null, content: '# Crane\n\nmanual' },
    ]);
    const res = new McpResourcesService({ memories: stubMemories, sharedMemories: shared, projects, skills: stubSkills });

    const out = await res.read('shared://ops.crane', host);
    expect(out.contents[0]).toMatchObject({ mimeType: 'text/markdown', text: '# Crane\n\nmanual', name: 'Crane deploys' });
  });

  it('read() round-trips a URL-encoded slug', async () => {
    const { service: projects } = makeStubProjects();
    const { service: shared } = makeStubSharedMemories([{ slug: 'ops:crane', title: 'T', summary: null, content: 'body' }]);
    const res = new McpResourcesService({ memories: stubMemories, sharedMemories: shared, projects, skills: stubSkills });

    const out = await res.read('shared://ops%3Acrane', host);
    expect(out.contents[0]!.text).toBe('body');
  });

  it('read() reports a missing document rather than returning empty content', async () => {
    const { service: projects } = makeStubProjects();
    const { service: shared } = makeStubSharedMemories();
    const res = new McpResourcesService({ memories: stubMemories, sharedMemories: shared, projects, skills: stubSkills });
    await expect(res.read('shared://nope', host)).rejects.toThrow(/not found/i);
  });

  it('create()/update() write and delete() removes', async () => {
    const { service: projects } = makeStubProjects();
    const { service: shared, writes, deletes } = makeStubSharedMemories();
    const res = new McpResourcesService({ memories: stubMemories, sharedMemories: shared, projects, skills: stubSkills });

    await res.create('shared://notes', { text: 'first' }, host);
    await res.update('shared://notes', { text: 'second' }, host);
    await res.delete('shared://notes', host);

    expect(writes).toEqual([
      { slug: 'notes', content: 'first' },
      { slug: 'notes', content: 'second' },
    ]);
    expect(deletes).toEqual(['notes']);
  });

  it('fails clearly when shared:// is used on a server without the service', async () => {
    const { service: projects } = makeStubProjects();
    const res = new McpResourcesService({ memories: stubMemories, projects, skills: stubSkills });
    await expect(res.read('shared://x', host)).rejects.toThrow(/not available/i);
    await expect(res.create('shared://x', { text: 'y' }, host)).rejects.toThrow(/not available/i);
    await expect(res.delete('shared://x', host)).rejects.toThrow(/not available/i);
  });
});
