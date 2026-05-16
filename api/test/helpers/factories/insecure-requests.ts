import { eq, desc } from 'drizzle-orm';
import {
  insecureAuthRequests,
  insecureDomainAllows,
  type Host,
} from '../../../src/db/schema.js';
import { nowIso } from '../../../src/util/timestamp.js';
import type { TestDb } from '../test-db.js';

export interface MakeInsecureAuthRequestOverrides {
  status?: 'pending' | 'approved' | 'denied' | 'expired';
  requestIp?: string;
  engine?: 'codex' | 'claude';
}

export async function makeInsecureAuthRequest(
  db: TestDb,
  host: Host,
  overrides: MakeInsecureAuthRequestOverrides = {},
) {
  const now = nowIso();
  await db.insert(insecureAuthRequests).values({
    hostId: host.id,
    status: overrides.status ?? 'pending',
    requestIp: overrides.requestIp ?? '203.0.113.1',
    requestedAt: now,
    updatedAt: now,
    engine: overrides.engine ?? 'codex',
  });
  const [row] = await db
    .select()
    .from(insecureAuthRequests)
    .where(eq(insecureAuthRequests.hostId, host.id))
    .orderBy(desc(insecureAuthRequests.id))
    .limit(1);
  if (!row) throw new Error('makeInsecureAuthRequest: row not found');
  return row;
}

export interface MakeInsecureDomainAllowOverrides {
  domain?: string;
  windowMinutes?: number;
  enabledUntil?: string | null;
}

export async function makeInsecureDomainAllow(
  db: TestDb,
  overrides: MakeInsecureDomainAllowOverrides = {},
) {
  const now = nowIso();
  const domain = overrides.domain ?? `domain-${Math.random().toString(36).slice(2, 6)}.test`;
  await db.insert(insecureDomainAllows).values({
    domain,
    windowMinutes: overrides.windowMinutes ?? 60,
    enabledUntil: overrides.enabledUntil ?? null,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db
    .select()
    .from(insecureDomainAllows)
    .where(eq(insecureDomainAllows.domain, domain))
    .limit(1);
  if (!row) throw new Error('makeInsecureDomainAllow: row not found');
  return row;
}
