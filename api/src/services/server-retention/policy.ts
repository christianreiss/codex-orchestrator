import { createHash } from 'node:crypto';
import { ValidationError } from '../../http/errors.js';
import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';

export const RETENTION_POLICY_KEY = 'server_retention_policy_v1';
export const RETENTION_RUN_KEY = 'server_retention_run_v1';
export interface ServerRetentionPolicy {
  audit_days: number;
  history_hours: number;
  quota_days: number;
  armed: boolean;
}
export const DEFAULT_SERVER_RETENTION: Readonly<ServerRetentionPolicy> = Object.freeze({
  audit_days: 14, history_hours: 24, quota_days: 7, armed: false,
});
export const RECEIPT_RESULT_DAYS = 14;
export const INTERNAL_RECEIPT_DAYS = 7;
export function validateServerRetention(value: unknown): ServerRetentionPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('A retention policy is required');
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(key => !['audit_days','history_hours','quota_days','armed'].includes(key))) throw new ValidationError('Unknown retention setting');
  for (const [key, max] of [['audit_days', 3650], ['history_hours', 87600], ['quota_days', 3650]] as const) {
    if (!Number.isInteger(p[key]) || Number(p[key]) < 1 || Number(p[key]) > max)
      throw new ValidationError(`${key} must be an integer between 1 and ${max}`, { param: key });
  }
  if (typeof p.armed !== 'boolean') throw new ValidationError('armed must be a boolean', { param: 'armed' });
  return { audit_days: Number(p.audit_days), history_hours: Number(p.history_hours), quota_days: Number(p.quota_days), armed: p.armed };
}
export function parseServerRetention(raw: string | null | undefined): ServerRetentionPolicy {
  return raw ? validateServerRetention(JSON.parse(raw)) : { ...DEFAULT_SERVER_RETENTION };
}
export function serverRetentionPolicy(snapshot: OwnerStateSnapshot): ServerRetentionPolicy {
  return parseServerRetention(snapshot.setting(RETENTION_POLICY_KEY));
}
export function retentionRevision(policy: ServerRetentionPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}
export function historyRetentionHours(snapshot: OwnerStateSnapshot | undefined, fallback = 24): number {
  return snapshot?.setting(RETENTION_POLICY_KEY) ? serverRetentionPolicy(snapshot).history_hours : fallback;
}
