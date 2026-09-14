/**
 * Input normalization: untrusted argument in, canonical value or ValidationError out.
 *
 * Part of the `agent-messaging` module; the public interface is the
 * `AgentMessagingService` facade in `../agent-messaging.ts`.
 */

import { ValidationError } from '../../http/errors.js';
import {
  AGENT_MESSAGING_CALL_PIN_MAX_TTL_SECONDS,
  AGENT_MESSAGING_CALL_PIN_MIN_TTL_SECONDS,
  AGENT_MESSAGING_CALL_PIN_TTL_SECONDS,
  AGENT_MESSAGING_CONFERENCE_DISPATCH_FLOOR_SECONDS,
  AGENT_MESSAGING_CONFERENCE_DISPATCH_MAX_SECONDS,
  AGENT_MESSAGING_CONFERENCE_MAX_MEMBERS,
  AGENT_MESSAGING_CONFERENCE_MAX_TTL_SECONDS,
  AGENT_MESSAGING_CONFERENCE_MIN_TTL_SECONDS,
  AGENT_MESSAGING_CONFERENCE_TTL_SECONDS,
  AGENT_MESSAGING_DEFAULT_TTL_SECONDS,
  AGENT_MESSAGING_MAX_BODY_BYTES,
  AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS,
  AGENT_MESSAGING_MAX_TTL_SECONDS,
  AGENT_MESSAGING_MIN_TTL_SECONDS,
  CALL_PIN_RE,
  UUID_RE,
} from './constants.js';

export function normalizeMessageBody(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('message body must not be empty', { param: 'content' });
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > AGENT_MESSAGING_MAX_BODY_BYTES) {
    throw new ValidationError('message body exceeds 32 KiB', { param: 'content' });
  }
  return value;
}

export function normalizeCallPin(value: unknown): string {
  // Always a string. A number would drop the leading zeros of `0042`.
  const pin = typeof value === 'string' ? value.trim() : '';
  if (!CALL_PIN_RE.test(pin)) {
    throw new ValidationError('pin must be four digits', { param: 'pin' });
  }
  return pin;
}

export function normalizeCallPinTtl(value: unknown): number {
  if (value === undefined || value === null) return AGENT_MESSAGING_CALL_PIN_TTL_SECONDS;
  const ttl = Number(value);
  if (
    !Number.isSafeInteger(ttl) ||
    ttl < AGENT_MESSAGING_CALL_PIN_MIN_TTL_SECONDS ||
    ttl > AGENT_MESSAGING_CALL_PIN_MAX_TTL_SECONDS
  ) {
    throw new ValidationError('ttl_seconds must be between 60 and 3600', { param: 'ttl_seconds' });
  }
  return ttl;
}

export function normalizeConferenceTtl(value: unknown): number {
  if (value === undefined || value === null) return AGENT_MESSAGING_CONFERENCE_TTL_SECONDS;
  const ttl = Number(value);
  if (
    !Number.isSafeInteger(ttl) ||
    ttl < AGENT_MESSAGING_CONFERENCE_MIN_TTL_SECONDS ||
    ttl > AGENT_MESSAGING_CONFERENCE_MAX_TTL_SECONDS
  ) {
    throw new ValidationError('ttl_seconds must be between 300 and 21600', { param: 'ttl_seconds' });
  }
  return ttl;
}

export function normalizeConferenceMaxMembers(value: unknown): number {
  if (value === undefined || value === null) return AGENT_MESSAGING_CONFERENCE_MAX_MEMBERS;
  const max = Number(value);
  if (!Number.isSafeInteger(max) || max < 2 || max > AGENT_MESSAGING_CONFERENCE_MAX_MEMBERS) {
    throw new ValidationError(`max_members must be between 2 and ${AGENT_MESSAGING_CONFERENCE_MAX_MEMBERS}`, {
      param: 'max_members',
    });
  }
  return max;
}

export function normalizeDispatchEta(value: unknown): number {
  if (value === undefined || value === null) return AGENT_MESSAGING_CONFERENCE_DISPATCH_FLOOR_SECONDS;
  const eta = Number(value);
  if (!Number.isSafeInteger(eta) || eta < 0 || eta > AGENT_MESSAGING_CONFERENCE_DISPATCH_MAX_SECONDS) {
    throw new ValidationError('eta_seconds must be between 0 and 14400', { param: 'eta_seconds' });
  }
  // The floor is not a minimum the caller asked for -- it is how long the sweep
  // waits before declaring a silent member stuck. A task that claims it needs
  // thirty seconds still gets the full grace period, because a headless run
  // spends most of that booting an engine.
  return Math.max(eta, AGENT_MESSAGING_CONFERENCE_DISPATCH_FLOOR_SECONDS);
}

export function normalizeMessageTtl(value: unknown): number {
  if (value === undefined || value === null) return AGENT_MESSAGING_DEFAULT_TTL_SECONDS;
  const ttl = Number(value);
  if (
    !Number.isSafeInteger(ttl) ||
    ttl < AGENT_MESSAGING_MIN_TTL_SECONDS ||
    ttl > AGENT_MESSAGING_MAX_TTL_SECONDS
  ) {
    throw new ValidationError('ttl_seconds must be between 60 and 604800', {
      param: 'ttl_seconds',
    });
  }
  return ttl;
}

export function deliveryBackoffSeconds(attempt: number): number {
  const bounded = Math.max(1, Math.min(AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS, Math.trunc(attempt)));
  return Math.min(900, 2 ** bounded);
}

export function normalizeRequiredText(value: unknown, param: string, maxBytes: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${param} is required`, { param });
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) throw new ValidationError(`${param} is too long`, { param });
  return normalized;
}

export function normalizeOptionalText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) throw new ValidationError('text is too long');
  return normalized;
}

export function normalizeUuid(value: unknown, param: string): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!UUID_RE.test(normalized)) throw new ValidationError(`${param} must be a UUID`, { param });
  return normalized;
}

export function normalizeBridgeToken(value: unknown): string {
  const token = String(value ?? '').trim();
  if (token.length < 43 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new ValidationError('bridge_token must be a 43-128 character base64url value', { param: 'bridge_token' });
  }
  return token;
}

export function normalizeAgentAlias(value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (!/^(?:agent:)?[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
    throw new ValidationError('alias must use lowercase letters, digits, dot, underscore or dash', { param: 'alias' });
  }
  const alias = normalized.startsWith('agent:') ? normalized : `agent:${normalized}`;
  if (UUID_RE.test(alias.slice('agent:'.length))) {
    throw new ValidationError('alias cannot use the reserved canonical address format', { param: 'alias' });
  }
  return alias;
}

export function normalizeErrorCode(value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const normalized = String(value).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 64);
  return normalized || null;
}

export function normalizeSessionStatus(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ['starting', 'active', 'waiting', 'offline'].includes(normalized) ? normalized : null;
}

export function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
