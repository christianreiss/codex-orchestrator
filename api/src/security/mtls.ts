import type { FastifyRequest } from 'fastify';

export interface MtlsClaims {
  present: boolean;
  fingerprint?: string;
  subject?: string;
  issuer?: string;
  cnameMatches?: boolean;
}

const FINGERPRINT_HEADER = 'x-mtls-fingerprint';
const SUBJECT_HEADER = 'x-mtls-subject';
const ISSUER_HEADER = 'x-mtls-issuer';

export function parseMtls(req: FastifyRequest): MtlsClaims {
  const fingerprint = headerOne(req, FINGERPRINT_HEADER);
  const subject = headerOne(req, SUBJECT_HEADER);
  const issuer = headerOne(req, ISSUER_HEADER);
  return {
    present: Boolean(fingerprint),
    fingerprint,
    subject,
    issuer,
  };
}

function headerOne(req: FastifyRequest, key: string): string | undefined {
  const v = req.headers[key];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' && v.length ? v : undefined;
}
