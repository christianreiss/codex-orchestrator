/**
 * Normalisation of the admin-set, receiver-visible fields of an external client
 * (docs/external-clients.md). Name and description end up in other agents'
 * context, so they are one line, free of control characters and markdown fences.
 */
import { ValidationError } from '../../http/errors.js';

export const EXTERNAL_TRUST_LEVELS = ['untrusted', 'peer', 'trusted', 'operator'] as const;
export type ExternalTrust = (typeof EXTERNAL_TRUST_LEVELS)[number];
export const EXTERNAL_NAME_MAX = 96;
export const EXTERNAL_DESCRIPTION_MAX = 120;

export function isExternalTrust(value: unknown): value is ExternalTrust {
  return typeof value === 'string' && (EXTERNAL_TRUST_LEVELS as readonly string[]).includes(value);
}

/** One line, no control/format characters, no fences; collapses whitespace. */
export function oneLine(value: unknown, max: number): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/`/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

export function normalizeExternalName(value: unknown): { name: string; key: string } {
  const name = oneLine(value, EXTERNAL_NAME_MAX);
  if (!name) throw new ValidationError('name is required', { param: 'name' });
  if (/^agent:/i.test(name)) throw new ValidationError('name must not start with "agent:"', { param: 'name' });
  return { name, key: name.toLowerCase() };
}

export function normalizeExternalDescription(value: unknown): string {
  return oneLine(value, EXTERNAL_DESCRIPTION_MAX);
}

export function normalizeExternalTrust(value: unknown, fallback: ExternalTrust = 'untrusted'): ExternalTrust {
  if (value === undefined || value === null || value === '') return fallback;
  if (!isExternalTrust(value))
    throw new ValidationError(`trust must be one of ${EXTERNAL_TRUST_LEVELS.join(', ')}`, { param: 'trust' });
  return value;
}
