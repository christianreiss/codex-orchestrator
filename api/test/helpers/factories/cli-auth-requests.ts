import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { cliAuthRequests, type CliAuthRequest } from '../../../src/db/schema.js';
import { sha256 } from '../../../src/security/hash.js';
import { nowIso, isoOffsetSeconds } from '../../../src/util/timestamp.js';
import type { TestDb } from '../test-db.js';

export interface MakeCliAuthRequestOverrides {
  requestId?: string;
  userCode?: string;
  fqdn?: string;
  status?: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired';
  ttlSeconds?: number;
  ip?: string;
  userAgent?: string;
  engine?: 'codex' | 'claude';
}

export interface MakeCliAuthRequestResult {
  row: CliAuthRequest;
  requestId: string;
  userCode: string;
}

export async function makeCliAuthRequest(
  db: TestDb,
  overrides: MakeCliAuthRequestOverrides = {},
): Promise<MakeCliAuthRequestResult> {
  const requestId = overrides.requestId ?? randomBytes(32).toString('hex');
  // user_code is CHAR(9); generate uppercase alpha-digit code 'XXX-XXX-X' style.
  const userCode = overrides.userCode ?? randomBytes(5).toString('hex').toUpperCase().slice(0, 9);
  const userCodeHash = sha256(userCode);
  const now = nowIso();
  const ttl = overrides.ttlSeconds ?? 600;

  await db.insert(cliAuthRequests).values({
    requestId,
    userCode,
    userCodeHash,
    fqdn: overrides.fqdn ?? 'cli.example.test',
    secure: 1,
    status: overrides.status ?? 'pending',
    ip: overrides.ip ?? '127.0.0.1',
    userAgent: overrides.userAgent ?? 'cli/0.0',
    expiresAt: isoOffsetSeconds(ttl),
    createdAt: now,
    engine: overrides.engine ?? 'codex',
  });

  const [row] = await db
    .select()
    .from(cliAuthRequests)
    .where(eq(cliAuthRequests.requestId, requestId))
    .limit(1);
  if (!row) throw new Error('makeCliAuthRequest: row not found after insert');
  return { row, requestId, userCode };
}
