import { describe, it, expect } from 'vitest';
import { McpToolsRegistry, wrapContent } from '../../../src/services/mcp-tools.js';
import type { McpMemoriesService } from '../../../src/services/mcp-memories.js';
import type { HostProjectsService } from '../../../src/services/host-projects.js';
import type { HostSkillsService } from '../../../src/services/host-skills.js';
import type { Host } from '../../../src/db/schema.js';

const stubMemories = {
  store: async (args: Record<string, unknown>) => ({ status: 'created', id: args['id'] ?? 'k', memory: null }),
  retrieve: async (args: Record<string, unknown>) => ({ status: 'found', id: args['id'], memory: { content: 'x' } }),
  search: async () => ({ status: 'ok', matches: [] }),
  delete: async (args: Record<string, unknown>) => ({ status: 'deleted', id: args['id'] }),
} as unknown as McpMemoriesService;

const stubProjects = {
  listProjects: async () => ({ projects: [] }),
  bootstrap: async (slug: string) => ({ project: slug }),
  projectDetail: async (slug: string) => ({ project: { slug } }),
  listChanges: async (slug: string) => ({ project: slug, changes: [] }),
  createProject: async () => ({ project: { slug: 'x' } }),
  upsertNote: async () => ({ note: {} }),
  createTodo: async () => ({ todo: {} }),
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
} as unknown as HostProjectsService;

const stubSkills = {
  listSkills: async () => ({ engine: 'codex' as const, skills: [] }),
  retrieve: async (slug: string) => ({ slug, status: 'missing' }),
} as unknown as HostSkillsService;

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

  it('registers the project_file_* CRUD tools', () => {
    const list = registry.list().map((t) => t.name);
    expect(list).toContain('project_file_list');
    expect(list).toContain('project_file_read');
    expect(list).toContain('project_file_upsert');
    expect(list).toContain('project_file_delete');
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
});
