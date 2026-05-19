import { describe, it, expect } from 'vitest';
import { McpResourcesService } from '../../../src/services/mcp-resources.js';
import { McpToolsRegistry } from '../../../src/services/mcp-tools.js';
import { McpServer, type DispatchContext } from '../../../src/services/mcp-server.js';
import type { McpMemoriesService } from '../../../src/services/mcp-memories.js';
import type { HostProjectsService } from '../../../src/services/host-projects.js';
import type { HostSkillsService } from '../../../src/services/host-skills.js';
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

function makeStubProjects(): {
  service: HostProjectsService;
  seedFile: (slug: string, file: Partial<SeededFile> & { stored_name: string }) => void;
} {
  const byProject = new Map<string, SeededFile[]>();
  let nextId = 1;

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
  } as unknown as HostProjectsService;

  return { service, seedFile };
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
