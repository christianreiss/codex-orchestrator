import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpAccessLogs } from '../../../src/db/schema.js';
import { McpAccessLogService, type McpAccessLogEntry } from '../../../src/services/mcp-access-log.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

/**
 * `GET /admin/mcp/logs` reads back every column this writer sets, so the row
 * shape is the whole contract -- `engine` above all, which was hardcoded null
 * and left the column dead for every MCP call ever logged. The clock is frozen
 * so `created_at` and the `mcp.invoked` payload are exact assertions.
 */

const NOW = '2026-07-28T21:00:00Z';

type Row = Record<string, unknown>;

function entry(over: Partial<McpAccessLogEntry> = {}): McpAccessLogEntry {
  return {
    hostId: 7,
    clientIp: '10.0.0.4',
    method: 'tools/call',
    name: 'memory_store',
    success: true,
    errorCode: null,
    errorMessage: null,
    engine: 'codex',
    ...over,
  };
}

async function logged(entryOver: Partial<McpAccessLogEntry> = {}): Promise<Row> {
  const db: DbFake = createDbFake();
  await new McpAccessLogService(db as never).log(entry(entryOver));
  expect(db.inserts).toHaveLength(1);
  expect(db.inserts[0]!.table).toBe(mcpAccessLogs);
  return db.inserts[0]!.values as Row;
}

let events: Array<{ type: string; payload: unknown }> = [];
let unsubscribe: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  events = [];
  unsubscribe = wsPublisher.subscribe((e) => events.push({ type: e.type, payload: e.payload }));
});

afterEach(() => {
  unsubscribe();
  vi.useRealTimers();
});

describe('McpAccessLogService.log', () => {
  it('records a codex dispatch on the engine column', async () => {
    expect((await logged({ engine: 'codex' })).engine).toBe('codex');
  });

  it('records a claude dispatch on the engine column', async () => {
    expect((await logged({ engine: 'claude' })).engine).toBe('claude');
  });

  it('records null when the caller announced no engine', async () => {
    expect((await logged({ engine: null })).engine).toBeNull();
  });

  it('writes the full row for a successful call', async () => {
    expect(await logged()).toEqual({
      hostId: 7,
      clientIp: '10.0.0.4',
      method: 'tools/call',
      name: 'memory_store',
      success: 1,
      errorCode: null,
      errorMessage: null,
      createdAt: NOW,
      engine: 'codex',
    });
  });

  it('writes success 0 with the error pair for a failed call', async () => {
    expect(
      await logged({
        hostId: null,
        clientIp: null,
        method: 'prompts/get',
        name: null,
        success: false,
        errorCode: -32601,
        errorMessage: 'Method not found',
        engine: 'claude',
      }),
    ).toEqual({
      hostId: null,
      clientIp: null,
      method: 'prompts/get',
      name: null,
      success: 0,
      errorCode: -32601,
      errorMessage: 'Method not found',
      createdAt: NOW,
      engine: 'claude',
    });
  });

  it('publishes mcp.invoked for admin listeners', async () => {
    await new McpAccessLogService(createDbFake() as never).log(
      entry({ success: false, errorCode: -32603, errorMessage: 'boom' }),
    );
    expect(events).toEqual([
      {
        type: 'mcp.invoked',
        payload: {
          host_id: 7,
          method: 'tools/call',
          name: 'memory_store',
          success: false,
          error_code: -32603,
          ts: NOW,
        },
      },
    ]);
  });
});
