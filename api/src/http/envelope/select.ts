import * as standard from './standard.js';
import * as openai from './openai.js';
import * as anthropic from './anthropic.js';
import type { ApiError } from '../errors.js';

export type EnvelopeKind = 'standard' | 'openai' | 'anthropic' | 'raw';

export interface EnvelopeFormatter {
  kind: EnvelopeKind;
  success: (data: unknown) => unknown;
  failure: (err: ApiError) => unknown;
}

const FORMATTERS: Record<EnvelopeKind, EnvelopeFormatter> = {
  standard: {
    kind: 'standard',
    success: (d) => standard.success(d),
    failure: (e) => standard.failure(e),
  },
  openai: {
    kind: 'openai',
    success: (d) => openai.success(d),
    failure: (e) => openai.failure(e),
  },
  anthropic: {
    kind: 'anthropic',
    success: (d) => anthropic.success(d),
    failure: (e) => anthropic.failure(e),
  },
  raw: {
    kind: 'raw',
    success: (d) => d,
    failure: (e) => ({ message: e.message, code: e.code }),
  },
};

export function selectFormatter(url: string): EnvelopeFormatter {
  if (url.startsWith('/anthropic/v1/')) return FORMATTERS.anthropic;
  if (url.startsWith('/v1/') || url === '/v1') return FORMATTERS.openai;
  return FORMATTERS.standard;
}

export function getFormatter(kind: EnvelopeKind): EnvelopeFormatter {
  return FORMATTERS[kind];
}
