/**
 * MCP JSON-RPC 2.0 dispatcher.
 */
import type { Host } from '../db/schema.js';
import type { Capability, McpToolsRegistry } from './mcp-tools.js';
import type { McpResourcesService } from './mcp-resources.js';
import { ENGINE_CODEX, type Engine } from '../util/engine.js';

/**
 * Served in every `initialize` response, so it is the one policy channel with
 * no file, no digest compare, and no launch-lock skip.
 *
 * It used to restate the secrets rule in its own words — and more permissively
 * than the served document ("Secret values may be persisted or relayed when an
 * explicitly requested task requires it"). That made it a second, looser voice
 * on the one axis where disagreement is most expensive, and it would have
 * silently overridden a tightened `secrets_exposure` level. It now defers to
 * the served document instead of competing with it.
 */
export const MCP_SERVER_INSTRUCTIONS =
  'This is the authoritative fleet MCP. Do not infer that a capability is absent from a partial or deferred client tool list: inspect this server\'s tools or call the safe discovery tool named in AGENTS.md or CLAUDE.md. For secrets, call secret_list before answering whether the store is available or can save credentials; its status and capabilities report live state. Whether you may use secret_store or secret_delete, and what may be done with a secret value once retrieved, is set by the Hard Stop Lines and Standing Authorizations of your served AGENTS.md or CLAUDE.md; follow that, and do not infer a broader permission from this handshake.';

export interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface DispatchContext {
  host: Host;
  clientIp: string | null;
  serverVersion: string;
  /**
   * Caller capability. Defaults to 'host' when omitted so tests + callers
   * that pre-date the split stay restrictive. The MCP route resolves this
   * from the bearer token (matches MCP_OPERATOR_TOKEN → 'operator').
   */
  capability?: Capability;
  engine?: Engine | null;
}

export class McpServer {
  constructor(
    private readonly tools: McpToolsRegistry,
    private readonly resources: McpResourcesService,
  ) {}

  async handlePayload(rawBody: unknown, ctx: DispatchContext): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    let body: unknown = rawBody;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        return errorResponse(null, -32700, 'Parse error');
      }
    }

    if (Array.isArray(body)) {
      const responses: JsonRpcResponse[] = [];
      for (const item of body) {
        const res = await this.handleOne(item, ctx);
        if (res) responses.push(res);
      }
      return responses.length === 0 ? null : responses;
    }
    return this.handleOne(body, ctx);
  }

  async handleOne(req: unknown, ctx: DispatchContext): Promise<JsonRpcResponse | null> {
    if (req === null || typeof req !== 'object' || Array.isArray(req)) {
      return errorResponse(null, -32600, 'Invalid Request');
    }
    const raw = req as JsonRpcRequest;
    if (raw.jsonrpc !== '2.0' || typeof raw.method !== 'string') {
      return errorResponse(raw.id ?? null, -32600, 'Invalid Request');
    }

    const id = (raw.id === undefined ? null : raw.id) as unknown;
    const method = raw.method;
    const isNotification = raw.id === undefined || raw.id === null;
    const params =
      raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)
        ? (raw.params as Record<string, unknown>)
        : {};
    const capability: Capability = ctx.capability ?? 'host';
    let response: JsonRpcResponse | null = null;

    try {
      switch (method) {
        case 'initialize': {
          response = okResponse(id, {
            protocolVersion: '2025-03-26',
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
              prompts: { listChanged: false },
            },
            serverInfo: { name: 'codex-orchestrator', version: ctx.serverVersion },
            instructions: MCP_SERVER_INSTRUCTIONS,
          });
          break;
        }
        case 'notifications/initialized':
        case 'notifications.initialized': {
          response = okResponse(id, { ok: true });
          break;
        }
        case 'tools/list':
        case 'tools.list':
        case 'list_tools': {
          response = okResponse(id, { tools: await this.tools.listAvailable(capability) });
          break;
        }
        case 'tools/call':
        case 'tools.call':
        case 'call_tool': {
          const name = typeof params['name'] === 'string' ? (params['name'] as string) : '';
          const args = params['arguments'] ?? {};

          if (!name) {
            response = okResponse(id, { isError: true, content: [{ type: 'text', text: 'Tool name is required' }] });
            break;
          }
          // has() applies capability filtering so operator-only tools look
          // like method-not-found to host callers (no leak of existence).
          if (!this.tools.has(name, capability)) {
            response = errorResponse(id, -32601, 'Method not found', { tool: name });
            break;
          }
          const result = await this.tools.dispatch(name, args, ctx.host, capability, ctx.engine ?? null);
          response = okResponse(id, result);
          break;
        }
        case 'resources/templates/list':
        case 'resources.templates.list':
        case 'list_resource_templates': {
          response = okResponse(id, { resourceTemplates: this.resources.listTemplates() });
          break;
        }
        case 'resources/list':
        case 'resources.list':
        case 'list_resources': {
          response = okResponse(id, {
            resources: await this.resources.list(ctx.host, ctx.engine ?? ENGINE_CODEX),
          });
          break;
        }
        case 'resources/read':
        case 'resources.read':
        case 'read_resource': {
          const uri = typeof params['uri'] === 'string' ? (params['uri'] as string) : '';

          if (!uri) {
            response = errorResponse(id, -32602, 'Invalid params', 'uri is required');
            break;
          }
          response = okResponse(id, await this.resources.read(uri, ctx.host, ctx.engine ?? ENGINE_CODEX));
          break;
        }
        case 'resources/create':
        case 'resources.create':
        case 'create_resource': {
          const uri = typeof params['uri'] === 'string' ? (params['uri'] as string) : '';

          if (!uri) {
            response = errorResponse(id, -32602, 'Invalid params', 'uri is required');
            break;
          }
          response = okResponse(id, await this.resources.create(uri, params, ctx.host));
          break;
        }
        case 'resources/update':
        case 'resources.update':
        case 'update_resource': {
          const uri = typeof params['uri'] === 'string' ? (params['uri'] as string) : '';

          if (!uri) {
            response = errorResponse(id, -32602, 'Invalid params', 'uri is required');
            break;
          }
          response = okResponse(id, await this.resources.update(uri, params, ctx.host));
          break;
        }
        case 'resources/delete':
        case 'resources.delete':
        case 'delete_resource': {
          const uri = typeof params['uri'] === 'string' ? (params['uri'] as string) : '';

          if (!uri) {
            response = errorResponse(id, -32602, 'Invalid params', 'uri is required');
            break;
          }
          response = okResponse(id, await this.resources.delete(uri, ctx.host));
          break;
        }
        case 'prompts/list':
        case 'prompts.list': {
          response = okResponse(id, { prompts: [] });
          break;
        }
        case 'prompts/get':
        case 'prompts.get': {
          response = errorResponse(id, -32601, 'Method not found');
          break;
        }
        default:
          response = errorResponse(id, -32601, 'Method not found');
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      response = errorResponse(id, -32603, 'Internal error', message);

    }

    if (isNotification) return null;
    return response;
  }
}

function okResponse(id: unknown, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id: unknown, code: number, message: string, data?: unknown): JsonRpcResponse {
  const error: { code: number; message: string; data?: unknown } = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}
