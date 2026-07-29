/**
 * Append-only writer for mcp_access_logs. Every JSON-RPC dispatch produces
 * one row regardless of success or failure, and a `mcp.invoked` WS event for
 * admins.
 */
import type { Database } from '../db/client.js';
import { mcpAccessLogs } from '../db/schema.js';
import type { Engine } from '../util/engine.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';

export interface McpAccessLogEntry {
  hostId: number | null;
  clientIp: string | null;
  method: string;
  name: string | null;
  success: boolean;
  errorCode: number | null;
  errorMessage: string | null;
  /** Effective dispatch engine; `/mcp` defaults an absent/invalid header to Codex. */
  engine: Engine | null;
}

export class McpAccessLogService {
  constructor(private readonly db: Database) {}

  async log(entry: McpAccessLogEntry): Promise<void> {
    const now = nowIso();
    await this.db.insert(mcpAccessLogs).values({
      hostId: entry.hostId,
      clientIp: entry.clientIp,
      method: entry.method,
      name: entry.name,
      success: entry.success ? 1 : 0,
      errorCode: entry.errorCode,
      errorMessage: entry.errorMessage,
      createdAt: now,
      engine: entry.engine,
    });
    wsPublisher.publish('mcp.invoked', {
      host_id: entry.hostId,
      method: entry.method,
      name: entry.name,
      success: entry.success,
      error_code: entry.errorCode,
      ts: now,
    });
  }
}
