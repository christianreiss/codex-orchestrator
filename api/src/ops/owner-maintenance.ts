import type { RetentionDeadlineIndex } from '../services/server-retention/deadlines.js';
import type { Database } from '../db/client.js';
import type { OwnerWorkObligation, OwnerWorkResult } from './owner-worker.js';

export type OwnerMaintenanceOperation =
  | 'messaging'
  | 'insecure-expiry'
  | 'transfer-expiry'
  | 'transfer-orphans'
  | 'auth-retention'
  | 'grok-usage'
  | 'chatgpt-usage'
  | 'skill-source'
  | 'feedback'
  | 'wrapper-rollout'
  | 'auth-verification'
  | 'quota-notices'
  | 'schedules'
  | 'watchdogs'
  | 'portal-retention';
export interface MessagingMaintenanceFacts {
  relayConnected(relayId: string): boolean;
  sessionConnected(sessionId: string, binding: number): boolean;
  receiverConnected(sessionId: string, binding: number, receiverGeneration: string): boolean;
  /** Changes on every connection/registry transition relevant to maintenance. */
  revision(): string;
  /** Boot/write-maintained metadata index; never a query into cold chat bodies. */
  conferenceHasPendingDeliveries(conferenceId: string): boolean;
}
export interface OwnerMaintenanceCommands {
  run(operation: OwnerMaintenanceOperation, obligation: OwnerWorkObligation): Promise<OwnerWorkResult>;
  retention: RetentionDeadlineIndex;
  facts: MessagingMaintenanceFacts;
  subscribeFacts(listener: () => void): () => void;
}
const bindings = new WeakMap<object, OwnerMaintenanceCommands>();
export function bindOwnerMaintenanceCommands(db: Database, commands: OwnerMaintenanceCommands): void {
  if (bindings.has(db)) throw new Error('Owner maintenance commands already bound');
  bindings.set(db, commands);
}
export function requireOwnerMaintenanceCommands(db: Database): OwnerMaintenanceCommands {
  const commands = bindings.get(db);
  if (!commands)
    throw new Error('Owner maintenance commands must be migrated and bound before worker startup');
  return commands;
}
