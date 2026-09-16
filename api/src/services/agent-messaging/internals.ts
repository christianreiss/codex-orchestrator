/**
 * Small shared primitives: lease-owner parsing, host fingerprints, error shapes.
 *
 * Part of the `agent-messaging` module; the public interface is the
 * `AgentMessagingService` facade in `../agent-messaging.ts`.
 */

import { timingSafeEqual } from 'node:crypto';

import { type Host } from '../../db/schema.js';
import { sha256 } from '../../security/hash.js';
import { UUID_RE } from './constants.js';

/** Fan-out reports per member, so a caller needs the code without the stack. */
export function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? code : 'agent_messaging_conference_send_failed';
}

export function errorMessageOf(error: unknown): string {
  const message = (error as { message?: unknown })?.message;
  return typeof message === 'string' ? message : 'Delivery failed';
}

export function relayIdFromLeaseOwner(value: string): string | null {
  const match = /^relay:([0-9a-f-]{36}):\d+$/.exec(value);
  return match?.[1] && UUID_RE.test(match[1]) ? match[1] : null;
}

export function sessionIdFromLeaseOwner(value: string): string | null {
  const match = /^session:([0-9a-f-]{36})$/.exec(value);
  return match?.[1] && UUID_RE.test(match[1]) ? match[1] : null;
}

export function safeHashEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function hostAuthFingerprint(host: Pick<Host, 'apiKey' | 'apiKeyHash'>): string {
  return sha256(host.apiKeyHash || host.apiKey);
}

export function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; errno?: unknown };
  return candidate.code === 'ER_DUP_ENTRY' || candidate.errno === 1062;
}
