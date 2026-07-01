import type { FastifyRequest } from 'fastify';

export interface MtlsClaims {
  present: boolean;
  fingerprint?: string;
  subject?: string;
  issuer?: string;
  // Intentionally left unset by parseMtls: there is no configured expected-CN
  // allowlist to compare `subject` against yet. Do NOT default this to true
  // or otherwise fake a match — compute and verify a real CN allowlist here
  // before any caller relies on this field for an authorization decision.
  cnameMatches?: boolean;
}

const FINGERPRINT_HEADER = 'x-mtls-fingerprint';
const SUBJECT_HEADER = 'x-mtls-subject';
const ISSUER_HEADER = 'x-mtls-issuer';

// TRUST BOUNDARY: parseMtls performs no verification of its own — it only
// reads whatever `x-mtls-*` headers are present on the request. These values
// are only trustworthy when this app is reached exclusively through a
// terminating reverse proxy that verifies the client certificate and then
// OVERWRITES these headers (never merely forwards client-supplied values).
// If any code path is wired to consult req.mtls for an authorization
// decision (e.g. ADMIN_ACCESS_MODE=mtls, or a host-identity check), first
// confirm the terminating proxy strips client-supplied versions of these
// headers before injecting verified ones — otherwise the claims below are
// fully attacker-controlled and spoofable.
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
