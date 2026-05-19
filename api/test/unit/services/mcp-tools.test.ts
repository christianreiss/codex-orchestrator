import { describe, it, expect } from 'vitest';
import { McpToolsRegistry, wrapContent } from '../../../src/services/mcp-tools.js';
import type { McpMemoriesService } from '../../../src/services/mcp-memories.js';
import type { HostProjectsService } from '../../../src/services/host-projects.js';
import type { HostSkillsService } from '../../../src/services/host-skills.js';
import type { McpFsTools } from '../../../src/services/mcp-fs.js';
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
