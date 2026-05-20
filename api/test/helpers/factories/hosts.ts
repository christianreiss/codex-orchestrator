import { generateApiKey } from '../../../src/util/api-key-helpers.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { hosts, type Host, type NewHost } from '../../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { nowIso } from '../../../src/util/timestamp.js';
import { testKeyring } from '../test-keyring.js';
import type { TestDb } from '../test-db.js';

/**
 * Issues a fresh API key (hash + encrypted blob included) and inserts a host
 * with sane defaults. Override any column via the `overrides` object.
 *
 * Returns the inserted row along with the plaintext api_key so tests can use
 * it as the `Authorization: Bearer <key>` header value.
 */
export interface MakeHostResult {
  host: Host;
  apiKey: string;
}

export interface MakeHostOverrides extends Partial<NewHost> {
  apiKey?: string;
}

export async function makeHost(
  db: TestDb,
  overrides: MakeHostOverrides = {},
): Promise<MakeHostResult> {
  const issued = generateApiKey('sk-codex-');
  const apiKey = overrides.apiKey ?? issued.key;
  const apiKeyHash = overrides.apiKeyHash ?? issued.hash;
  const apiKeyEnc = overrides.apiKeyEnc ?? encrypt(apiKey, testKeyring());
  const now = nowIso();
  const fqdn = overrides.fqdn ?? `test-${Math.random().toString(36).slice(2, 10)}.example.test`;

  const defaults: NewHost = {
    fqdn,
    apiKey,
    apiKeyHash,
    apiKeyEnc,
    status: 'active',
    secure: 1,
    allowRoamingIps: 0,
    engines: 'codex',
    apiCalls: 0,
    configVersion: 0,
    wrapperTrack: 'v2',
    vip: 0,
    curlInsecure: 0,
    browserosMcpEnabled: 0,
    scalingExempt: 0,
    createdAt: now,
    updatedAt: now,
  };
  // Re-apply derived key/hash/enc last so a caller that overrides `apiKey`
  // alone still gets a matching hash/enc unless they explicitly set those.
  const row: NewHost = {
    ...defaults,
    ...overrides,
    apiKey,
    apiKeyHash,
    apiKeyEnc,
  };

  await db.insert(hosts).values(row);
  const [created] = await db.select().from(hosts).where(eq(hosts.fqdn, fqdn)).limit(1);
  if (!created) throw new Error('makeHost: insert succeeded but row not found');
  return { host: created, apiKey };
}
