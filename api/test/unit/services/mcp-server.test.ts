import { describe, it, expect } from 'vitest';
import { McpServer, type DispatchContext } from '../../../src/services/mcp-server.js';
import { McpToolsRegistry } from '../../../src/services/mcp-tools.js';
import { McpResourcesService } from '../../../src/services/mcp-resources.js';
import type { McpMemoriesService } from '../../../src/services/mcp-memories.js';
import type { HostProjectsService } from '../../../src/services/host-projects.js';
import type { HostSkillsService } from '../../../src/services/host-skills.js';
import type { McpAccessLogService } from '../../../src/services/mcp-access-log.js';
import type { Host } from '../../../src/db/schema.js';

const noopAccess = { log: async () => undefined } as unknown as McpAccessLogService;
const stubMemories = {
  store: async () => ({}),
  retrieve: async () => ({}),
  search: async () => ({}),
  delete: async () => ({}),
} as unknown as McpMemoriesService;
const stubProjects = {
  listProjects: async () => ({ projects: [] }),
  bootstrap: async () => ({}),
  projectDetail: async () => ({}),
  listChanges: async () => ({}),
  createProject: async () => ({}),
  upsertNote: async () => ({}),
  createTodo: async () => ({}),
  updateTodo: async () => ({}),
  setTodoDone: async () => ({}),
  createFeedback: async () => ({}),
  listFiles: async () => ({ files: [] }),
  readFile: async () => ({ project: 'x', file: { stored_name: 'f', content: '', mime_type: null } }),
  upsertFile: async () => ({ file: {} }),
  deleteFile: async () => ({ deleted: 0 }),
} as unknown as HostProjectsService;
const stubSkills = {
  listSkills: async () => ({ engine: 'codex', skills: [] }),
  retrieve: async () => ({}),
} as unknown as HostSkillsService;

const tools = new McpToolsRegistry({ memories: stubMemories, projects: stubProjects, skills: stubSkills });
const resources = new McpResourcesService({ memories: stubMemories, projects: stubProjects, skills: stubSkills });
const server = new McpServer(tools, resources, noopAccess);

const ctx: DispatchContext = {
  host: { id: 1, fqdn: 'a.example' } as unknown as Host,
  clientIp: '127.0.0.1',
  serverVersion: 'test',
};

describe('McpServer.handlePayload', () => {
  it('returns initialize result', async () => {
    const r = await server.handlePayload({ jsonrpc: '2.0', id: 1, method: 'initialize' }, ctx);
    expect(r).toMatchObject({ jsonrpc: '2.0', id: 1 });
    expect((r as { result: { protocolVersion: string } }).result.protocolVersion).toMatch(/2025/);
  });

  it('returns tools/list catalog', async () => {
    const r = await server.handlePayload({ jsonrpc: '2.0', id: 'a', method: 'tools/list' }, ctx);
    const result = (r as { result: { tools: Array<{ name: string }> } }).result;
    expect(result.tools.some((t) => t.name === 'memory_store')).toBe(true);
  });

  it('returns -32601 for unknown method', async () => {
    const r = await server.handlePayload({ jsonrpc: '2.0', id: 9, method: 'frobnicate' }, ctx);
    expect((r as { error: { code: number } }).error.code).toBe(-32601);
  });

  it('returns -32600 for malformed request', async () => {
    const r = await server.handlePayload({ jsonrpc: 'wrong' }, ctx);
    expect((r as { error: { code: number } }).error.code).toBe(-32600);
  });

  it('returns -32700 for parse error when given an invalid JSON string', async () => {
    const r = await server.handlePayload('{not-json', ctx);
    expect((r as { error: { code: number } }).error.code).toBe(-32700);
  });

  it('handles tools/call for unknown tool with -32601 method-not-found', async () => {
    const r = await server.handlePayload({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } }, ctx);
    expect((r as { error: { code: number } }).error.code).toBe(-32601);
  });

  it('returns null for notifications batch (no responses)', async () => {
    const r = await server.handlePayload([{ jsonrpc: '2.0', method: 'notifications/initialized' }], ctx);
    expect(r).toBeNull();
  });

  it('returns -32602 when resources/read receives empty uri', async () => {
    const r = await server.handlePayload({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: {} }, ctx);
    expect((r as { error: { code: number } }).error.code).toBe(-32602);
  });

  it('returns empty prompts/list', async () => {
    const r = await server.handlePayload({ jsonrpc: '2.0', id: 5, method: 'prompts/list' }, ctx);
    expect((r as { result: { prompts: unknown[] } }).result.prompts).toEqual([]);
  });
});
