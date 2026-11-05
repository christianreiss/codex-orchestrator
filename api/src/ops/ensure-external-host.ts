/**
 * Provision the server-owned host that carries every external client's session
 * and address (docs/external-clients.md). Like the advisor host it is not a fleet
 * machine: nobody registers it and no admin listing shows it. Unlike the advisor
 * its addresses stay visible to agent discovery. Idempotent; creates at most one.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { hosts } from '../db/schema.js';
import { sha256 } from '../security/hash.js';
import { nowIso } from '../util/timestamp.js';
import { ENGINE_EXTERNAL } from '../util/engine.js';
import { EXTERNAL_FQDN, EXTERNAL_ROLE } from '../services/internal-hosts.js';

export async function ensureExternalHost(db: Database): Promise<{ status: 'created' | 'present'; host_id: number }> {
  const [existing] = await db.select().from(hosts).where(eq(hosts.internalRole, EXTERNAL_ROLE)).limit(1);
  if (existing) {
    if (existing.status !== 'active' || existing.secure !== 1 || existing.engines !== ENGINE_EXTERNAL || existing.expiresAt) {
      await db
        .update(hosts)
        .set({ status: 'active', secure: 1, engines: ENGINE_EXTERNAL, expiresAt: null, updatedAt: nowIso() })
        .where(eq(hosts.id, existing.id));
    }
    return { status: 'present', host_id: existing.id };
  }
  // The host key is never used: external clients authenticate with their own
  // keys. It only has to be unique, so it is random and immediately forgotten.
  const throwaway = `sk-external-${randomBytes(32).toString('hex')}`;
  const hash = sha256(throwaway);
  const now = nowIso();
  await db.insert(hosts).values({
    fqdn: EXTERNAL_FQDN,
    apiKey: hash,
    apiKeyHash: hash,
    status: 'active',
    secure: 1,
    allowRoamingIps: 1,
    reverseDnsMode: 0,
    engines: ENGINE_EXTERNAL,
    internalRole: EXTERNAL_ROLE,
    createdAt: now,
    updatedAt: now,
  });
  const [host] = await db.select().from(hosts).where(eq(hosts.fqdn, EXTERNAL_FQDN)).limit(1);
  return { status: 'created', host_id: host!.id };
}
