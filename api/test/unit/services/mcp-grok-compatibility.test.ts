import { describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { createRequire } from 'node:module';
import { McpToolsRegistry, type ToolDeps } from '../../../src/services/mcp-tools.js';
import { McpServer } from '../../../src/services/mcp-server.js';
import type { Host } from '../../../src/db/schema.js';

// Exercise every registered handler through JSON-RPC without touching a fleet,
// database, filesystem, credential, schedule or another agent. These service
// doubles test the transport contract, not each service's business semantics.
const groups = ['memories', 'sharedMemories', 'projects', 'skills', 'resources',
  'fs', 'secrets', 'gitDirector', 'transfers', 'board', 'schedules', 'taskMessaging'];
function harness(fail = false) {
  const calls: Array<{ group: string; method: string; args: unknown[] }> = [];
  const deps = Object.fromEntries(groups.map(group => [group, new Proxy({}, {
    get: (_target, method: string) => async (...args: unknown[]) => {
      calls.push({ group, method, args });
      if (fail) throw new Error('fixture service failure');
      if (method === 'getEnabled') return true;
      return { fixture: 'Grüße 🛠\nJSON "content"', group, method };
    },
  })])) as unknown as ToolDeps;
  const registry = new McpToolsRegistry(deps);
  const server = new McpServer(registry, deps.resources!, { log: async () => {} } as never);
  return { registry, server, calls };
}

type Schema = { type?: string | string[]; properties?: Record<string, Schema>;
  required?: string[]; enum?: unknown[]; minimum?: number; format?: string; items?: Schema };
function sample(schema: Schema): unknown {
  if (schema.enum) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'object') return Object.fromEntries((schema.required ?? []).map(key => [key, sample(schema.properties![key]!)]));
  if (type === 'array') return [sample(schema.items!)];
  if (type === 'integer' || type === 'number') return schema.minimum ?? 1;
  if (type === 'boolean') return true;
  if (schema.format === 'uuid') return '11111111-1111-4111-8111-111111111111';
  return 'fixture';
}
const all = harness().registry.list('operator');
const ajv = new Ajv({ strict: false, allErrors: true });
const addFormats = createRequire(import.meta.url)('ajv-formats') as (instance: Ajv) => void;
addFormats(ajv);
const context = { host: { id: 7 } as Host, engine: 'grok' as const,
  capability: 'operator' as const, clientIp: null, serverVersion: 'test' };

describe('Grok MCP full server catalogue', () => {
  it('includes all host tools and the optional operator filesystem tools', () => {
    expect(harness().registry.list('host')).toHaveLength(78);
    expect(all).toHaveLength(84);
  });

  for (const tool of all) {
    it(`${tool.name}: JSON Schema compiles and success/error results survive JSON-RPC`, async () => {
      expect(`cgx__${tool.name}`).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      const validate = ajv.compile(tool.inputSchema);
      const args = sample(tool.inputSchema as Schema);
      expect(validate(args), JSON.stringify(validate.errors)).toBe(true);
      for (const fail of [false, true]) {
        const { server, calls } = harness(fail);
        const raw = await server.handlePayload(JSON.stringify({ jsonrpc: '2.0', id: 1,
          method: 'tools/call', params: { name: tool.name, arguments: args } }), context);
        const response = JSON.parse(JSON.stringify(raw));
        expect(response.error).toBeUndefined();
        expect(response.result.isError).toBe(fail);
        expect(calls.length).toBeGreaterThan(0);
        expect(response.result.content).toHaveLength(1);
        expect(response.result.content[0].type).toBe('text');
        expect(typeof response.result.content[0].text).toBe('string');
        if (fail) expect(response.result.content[0].text).toBe('fixture service failure');
        else expect(() => JSON.parse(response.result.content[0].text)).not.toThrow();
      }
    });
  }

  it('passes Grok identity to engine-scoped reads instead of using Codex defaults', async () => {
    const cases = ['secret_get',
      'skill_list', 'skill_retrieve', 'resource_list', 'resource_read'];
    for (const name of cases) {
      const { registry, calls } = harness();
      const tool = all.find(t => t.name === name)!;
      await registry.dispatch(name, sample(tool.inputSchema as Schema), context.host, 'host', 'grok');
      expect(calls.some(call => call.args.includes('grok')), name).toBe(true);
    }
  });
});
