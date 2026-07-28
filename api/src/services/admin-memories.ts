import type { Database } from '../db/client.js';
import { AdminMemoryAudit } from './admin-memory-audit.js';
import { AdminMemoryCatalog } from './admin-memory-catalog.js';
import { AdminMemoryLifecycle } from './admin-memory-lifecycle.js';
import type { MemoryDetail, MemoryScope } from './admin-memory-model.js';

export {
  MEMORY_SCOPES,
  decodeMemoryGraphCursor,
  memoryEtagForState,
  memoryNodeId,
  parseMemoryNodeId,
  sanitizeMemoryAuditDetails,
} from './admin-memory-model.js';
export type { MemoryCapabilities, MemoryDetail, MemoryScope } from './admin-memory-model.js';

/** Thin public facade for the unified admin-memory API. */
export class AdminMemoriesService {
  private readonly catalog: AdminMemoryCatalog;
  private readonly lifecycle: AdminMemoryLifecycle;
  private readonly history: AdminMemoryAudit;

  constructor(db: Database) {
    this.catalog = new AdminMemoryCatalog(db);
    this.lifecycle = new AdminMemoryLifecycle(db);
    this.history = new AdminMemoryAudit(db);
  }

  graph(input: Record<string, unknown>, canMutate: boolean): Promise<Record<string, unknown>> {
    return this.catalog.graph(input, canMutate);
  }

  detail(scope: MemoryScope, recordId: number, canMutate: boolean): Promise<MemoryDetail> {
    return this.catalog.detail(scope, recordId, canMutate);
  }

  create(
    scope: MemoryScope,
    input: Record<string, unknown>,
    actorId: number,
  ): Promise<{ status: 'created'; memory: MemoryDetail }> {
    return this.lifecycle.create(scope, input, actorId);
  }

  update(
    scope: MemoryScope,
    recordId: number,
    input: Record<string, unknown>,
    actorId: number,
  ): Promise<{ status: 'updated' | 'unchanged'; memory: MemoryDetail }> {
    return this.lifecycle.update(scope, recordId, input, actorId);
  }

  remove(
    scope: MemoryScope,
    recordId: number,
    expectedEtag: unknown,
    actorId: number,
  ): Promise<{ status: 'deleted'; node_id: string; scope: MemoryScope; record_id: number }> {
    return this.lifecycle.remove(scope, recordId, expectedEtag, actorId);
  }

  appendShared(
    recordId: number,
    content: unknown,
    actorId: number,
  ): Promise<{ status: 'appended'; memory: MemoryDetail }> {
    return this.lifecycle.appendShared(recordId, content, actorId);
  }

  audit(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.history.list(input);
  }
}
