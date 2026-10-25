import type { OwnedTableName } from './catalog.js';

/** Current document bytes belong to the owner, privately, alongside metadata.
 * They must never be spread into public state projections. History stays cold. */
export const CORE_CONTENT_FIELDS: Partial<Record<OwnedTableName, readonly string[]>> = {
  authPayloads: ['body'],
  chatgptUsageSnapshots: ['raw', 'error'],
  skills: ['manifest'],
  skillFiles: ['content'],
  agentsDocuments: ['body'],
  clientConfigDocuments: ['body'],
  sharedMemories: ['content'],
  mcpMemories: ['content'],
  coordProjectNotes: ['body'],
  coordProjectMemories: ['content'],
  coordProjectFiles: ['content'],
  claudeArtifacts: ['body'],
  coordProjectFeedback: ['body'],
  adminUsers: ['passwordHash'],
  secrets: ['valueEnc'],
};

export type CoreContents = ReadonlyMap<string, string | null>;
export const coreContentKey = (table: OwnedTableName, key: string, field: string) =>
  JSON.stringify([table, key, field]);
