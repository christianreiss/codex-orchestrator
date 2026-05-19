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

const upsertNoteCalls: UpsertNoteCall[] = [];
const todoUpdateCalls: TodoUpdateCall[] = [];
const todoDoneCalls: TodoDoneCall[] = [];

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
});
