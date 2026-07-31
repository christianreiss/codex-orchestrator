import { describe, it, expect } from 'vitest';
import { McpServer, type DispatchContext, type JsonRpcResponse } from '../../../src/services/mcp-server.js';
import { McpToolsRegistry } from '../../../src/services/mcp-tools.js';
import { McpResourcesService } from '../../../src/services/mcp-resources.js';
import type { McpFsTools } from '../../../src/services/mcp-fs.js';
import type { McpMemoriesService } from '../../../src/services/mcp-memories.js';
import type { HostProjectsService } from '../../../src/services/host-projects.js';
import type { HostSkillsService } from '../../../src/services/host-skills.js';
import type { McpAccessLogEntry, McpAccessLogService } from '../../../src/services/mcp-access-log.js';
import type { Host } from '../../../src/db/schema.js';

const noopAccess = { log: async () => undefined } as unknown as McpAccessLogService;

/** Access-log stub that keeps the entries the dispatcher wrote. */
function recordingAccess(entries: McpAccessLogEntry[]): McpAccessLogService {
  return {
    log: async (entry: McpAccessLogEntry) => {
      entries.push(entry);
    },
  } as unknown as McpAccessLogService;
}
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

/**
 * Registry with the operator-only fs_* tools registered; `reads` collects the
 * arguments fs_read_file was dispatched with (stays empty when the capability
 * gate rejected the call before dispatch).
 */
function operatorToolsRegistry(reads: Record<string, unknown>[]): McpToolsRegistry {
  const fs = {
    readFile: async (args: Record<string, unknown>) => {
      reads.push(args);
      return { path: args['path'], content: 'file body' };
    },
  } as unknown as McpFsTools;
  return new McpToolsRegistry({ memories: stubMemories, projects: stubProjects, skills: stubSkills, fs });
}

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
    expect(result.tools.some((t) => t.name === 'skill_store')).toBe(true);
    expect(result.tools.some((t) => t.name === 'skill_delete')).toBe(true);
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

  it('threads the caller engine through direct and tool-based skill resource access', async () => {
    const calls: Array<{ operation: string; engine: unknown }> = [];
    const scopedSkills = {
      listSkills: async (_host: Host, engine: unknown) => {
        calls.push({ operation: 'list', engine });
        return { engine, skills: [] };
      },
      retrieve: async (_slug: string, _sha: string | null, _host: Host, engine: unknown) => {
        calls.push({ operation: 'retrieve', engine });
        return { slug: 'engine-scope', source_type: null, manifest: '# scoped' };
      },
    } as unknown as HostSkillsService;
    const scopedResources = new McpResourcesService({
      memories: stubMemories,
      projects: stubProjects,
      skills: scopedSkills,
    });
    const scopedTools = new McpToolsRegistry({
      memories: stubMemories,
      projects: stubProjects,
      skills: scopedSkills,
      resources: scopedResources,
    });
    const scopedServer = new McpServer(scopedTools, scopedResources, noopAccess);
    const claude = { ...ctx, engine: 'claude' as const };

    await scopedServer.handlePayload({ jsonrpc: '2.0', id: 1, method: 'resources/list' }, claude);
    await scopedServer.handlePayload({
      jsonrpc: '2.0',
      id: 2,
      method: 'resources/read',
      params: { uri: 'skill://engine-scope' },
    }, claude);
    await scopedServer.handlePayload({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'resource_list', arguments: {} },
    }, claude);
    await scopedServer.handlePayload({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'skill_retrieve', arguments: { slug: 'engine-scope' } },
    }, claude);
    await scopedServer.handlePayload({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      // An argument cannot cross the engine boundary; the authenticated
      // request engine is authoritative for every Skill access surface.
      params: { name: 'skill_list', arguments: { engine: 'codex' } },
    }, claude);

    expect(calls).toEqual([
      { operation: 'list', engine: 'claude' },
      { operation: 'retrieve', engine: 'claude' },
      { operation: 'list', engine: 'claude' },
      { operation: 'retrieve', engine: 'claude' },
      { operation: 'list', engine: 'claude' },
    ]);
  });
});

describe('McpServer access logging', () => {
  const call = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'memory_store', arguments: { content: 'note' } },
  };

  it('logs the engine the caller dispatched with', async () => {
    const entries: McpAccessLogEntry[] = [];
    const logging = new McpServer(tools, resources, recordingAccess(entries));

    await logging.handlePayload(call, { ...ctx, engine: 'claude' });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ hostId: 1, method: 'tools/call', name: 'memory_store', engine: 'claude' });
  });

  it('logs a null engine when the caller announced none', async () => {
    const entries: McpAccessLogEntry[] = [];
    const logging = new McpServer(tools, resources, recordingAccess(entries));

    await logging.handlePayload(call, { ...ctx, engine: null });

    expect(entries[0]!.engine).toBeNull();
  });

  it('resolves an id:null request to null but still writes one log entry', async () => {
    const entries: McpAccessLogEntry[] = [];
    const logging = new McpServer(tools, resources, recordingAccess(entries));

    const r = await logging.handlePayload({ jsonrpc: '2.0', id: null, method: 'tools/list' }, ctx);

    expect(r).toBeNull();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ method: 'tools/list', name: null, success: true, errorCode: null });
  });

  it('keeps the response when the access log rejects', async () => {
    const failingAccess = {
      log: async () => {
        throw new Error('access log unavailable');
      },
    } as unknown as McpAccessLogService;
    const logging = new McpServer(tools, resources, failingAccess);

    const r = await logging.handlePayload({ jsonrpc: '2.0', id: 12, method: 'prompts/list' }, ctx);

    expect(r).toEqual({ jsonrpc: '2.0', id: 12, result: { prompts: [] } });
  });
});

describe('McpServer capability gate', () => {
  const fsCall = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'fs_read_file', arguments: { path: 'notes.txt' } },
  };

  it('answers -32601 without dispatching when a host caller invokes an operator-only tool', async () => {
    const reads: Record<string, unknown>[] = [];
    const entries: McpAccessLogEntry[] = [];
    const gated = new McpServer(operatorToolsRegistry(reads), resources, recordingAccess(entries));

    // ctx omits `capability`, so the dispatcher falls back to 'host'.
    const r = await gated.handlePayload(fsCall, ctx);

    expect((r as { error: JsonRpcResponse['error'] }).error).toMatchObject({
      code: -32601,
      message: 'Method not found',
      data: { tool: 'fs_read_file' },
    });
    expect(reads).toEqual([]);
    expect(entries[0]).toMatchObject({ name: 'fs_read_file', success: false, errorCode: -32601 });
  });

  it('reaches the registry when the caller carries the operator capability', async () => {
    const reads: Record<string, unknown>[] = [];
    const gated = new McpServer(operatorToolsRegistry(reads), resources, noopAccess);

    const r = await gated.handlePayload(fsCall, { ...ctx, capability: 'operator' });

    expect((r as { error?: unknown }).error).toBeUndefined();
    expect((r as { result: { isError: boolean } }).result.isError).toBe(false);
    expect(reads).toEqual([{ path: 'notes.txt' }]);
  });

  it('hides operator-only tools from tools/list unless the caller is an operator', async () => {
    const gated = new McpServer(operatorToolsRegistry([]), resources, noopAccess);
    const listNames = async (c: DispatchContext): Promise<string[]> => {
      const r = await gated.handlePayload({ jsonrpc: '2.0', id: 'l', method: 'tools/list' }, c);
      return (r as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    };

    const hostNames = await listNames(ctx);
    const operatorNames = await listNames({ ...ctx, capability: 'operator' });

    expect(hostNames.filter((n) => n.startsWith('fs_'))).toEqual([]);
    expect(hostNames).toContain('memory_store');
    expect(operatorNames).toContain('fs_read_file');
  });
});

describe('McpServer batch handling', () => {
  it('returns one response per id-bearing request, in request order', async () => {
    const r = await server.handlePayload(
      [
        { jsonrpc: '2.0', id: 'first', method: 'initialize' },
        { jsonrpc: '2.0', id: 'second', method: 'prompts/list' },
      ],
      ctx,
    );

    const responses = r as JsonRpcResponse[];
    expect(responses).toHaveLength(2);
    expect(responses.map((res) => res.id)).toEqual(['first', 'second']);
    expect(responses[1]!.result).toEqual({ prompts: [] });
  });

  it('drops notification entries from a mixed batch', async () => {
    const r = await server.handlePayload(
      [
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 7, method: 'prompts/list' },
        { jsonrpc: '2.0', id: null, method: 'tools/list' },
      ],
      ctx,
    );

    const responses = r as JsonRpcResponse[];
    expect(responses).toHaveLength(1);
    expect(responses[0]!.id).toBe(7);
  });
});

describe('McpServer error mapping', () => {
  it('maps a throwing registry to -32603 with the thrown message as data', async () => {
    const entries: McpAccessLogEntry[] = [];
    const throwingTools = {
      list: () => [],
      has: () => true,
      dispatch: async () => {
        throw new Error('registry exploded');
      },
    } as unknown as McpToolsRegistry;
    const failing = new McpServer(throwingTools, resources, recordingAccess(entries));

    const r = await failing.handlePayload(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_store' } },
      ctx,
    );

    expect((r as { error: JsonRpcResponse['error'] }).error).toEqual({
      code: -32603,
      message: 'Internal error',
      data: 'registry exploded',
    });
    expect(entries[0]).toMatchObject({ success: false, errorCode: -32603, errorMessage: 'registry exploded' });
  });

  it('returns a result but logs failure when the tool reports isError', async () => {
    const entries: McpAccessLogEntry[] = [];
    const logging = new McpServer(tools, resources, recordingAccess(entries));

    // memory_store requires `content`, so the registry answers isError.
    const r = await logging.handlePayload(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'memory_store', arguments: {} } },
      ctx,
    );

    expect((r as { error?: unknown }).error).toBeUndefined();
    expect((r as { result: { isError: boolean } }).result.isError).toBe(true);
    expect(entries[0]).toMatchObject({ name: 'memory_store', success: false, errorCode: null });
  });

  it.each([
    ['missing', {}],
    ['blank', { name: '' }],
  ])('answers a tools/call with a %s name with an ok isError result', async (_label, params) => {
    const entries: McpAccessLogEntry[] = [];
    const logging = new McpServer(tools, resources, recordingAccess(entries));

    const r = await logging.handlePayload({ jsonrpc: '2.0', id: 8, method: 'tools/call', params }, ctx);

    expect((r as { error?: unknown }).error).toBeUndefined();
    expect((r as { result: { isError: boolean; content: Array<{ text: string }> } }).result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Tool name is required' }],
    });
    expect(entries[0]).toMatchObject({ name: '', success: false, errorCode: null });
  });

  it.each(['resources/create', 'resources/update', 'resources/delete'])(
    'returns -32602 when %s receives an empty uri',
    async (method) => {
      const r = await server.handlePayload({ jsonrpc: '2.0', id: 4, method, params: {} }, ctx);

      expect((r as { error: JsonRpcResponse['error'] }).error).toEqual({
        code: -32602,
        message: 'Invalid params',
        data: 'uri is required',
      });
    },
  );
});
