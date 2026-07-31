import { eq } from 'drizzle-orm';
import {
  adminEvents,
  hosts as hostsTable,
  logs as logsTable,
  type Host,
} from '../db/schema.js';
import type { Database } from '../db/client.js';
import { generateApiKey } from '../util/api-key-helpers.js';
import { encrypt } from '../security/secret-box.js';
import type { Keyring } from '../security/keyring.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import type { InsecureWindowService } from './insecure-window.js';
import { suspendAgentMessagingRuntimeLocked } from './agent-messaging.js';
import { NotFoundError } from '../http/errors.js';

/**
 * Host create + API-key rotate, used by the CLI auth approve path. Emits a
 * host.created / host.updated WS event and writes an admin_events audit row.
 */

export interface RegisteredHost {
  host: Host;
  apiKey: string;
}

export interface HostRegistrationService {
  registerOrRotate(input: {
    fqdn: string;
    secure?: boolean;
    insecureWindowMinutes?: number;
    engines?: string;
    createdBy?: string | null;
  }): Promise<RegisteredHost>;
}

export interface HostRegistrationDeps {
  db: Database;
  keyring: Keyring;
  insecure: InsecureWindowService;
}

export function createHostRegistrationService(deps: HostRegistrationDeps): HostRegistrationService {
  const { db, keyring, insecure } = deps;
  return {
    async registerOrRotate({ fqdn, secure = true, insecureWindowMinutes, engines: enginesIn, createdBy }) {
      const trimmed = fqdn.trim();
      const now = nowIso();
      const existing = await db.select().from(hostsTable).where(eq(hostsTable.fqdn, trimmed)).limit(1);

      const { key: apiKey, hash: apiKeyHash } = generateApiKey('sk-codex-');
      const apiKeyEnc = encrypt(apiKey, keyring);

      if (existing[0]) {
        const prev = existing[0];
        // An omitted engines field on a rotate means "keep what's there", not
        // "reset to the default" — otherwise every CLI re-approval would strip
        // a host provisioned with codex,claude back down to codex.
        let engines = enginesIn ?? prev.engines;
        await db.transaction(async (tx) => {
          const lockedRows = await tx
            .select()
            .from(hostsTable)
            .where(eq(hostsTable.id, prev.id))
            .limit(1)
            .for('update');
          const locked = lockedRows[0];
          if (!locked) throw new NotFoundError('Host not found', 'host_not_found');
          engines = enginesIn ?? locked.engines;
          // The host API key fingerprints every active bridge and relay. Rotate
          // that authentication generation and fence all bus runtime together;
          // a secure/same-engine rotation is just as definitive as a demotion.
          await suspendAgentMessagingRuntimeLocked(tx, locked.id, 'host_auth_rotated');
          await tx
            .update(hostsTable)
            .set({
              apiKey: apiKeyHash,
              apiKeyHash,
              apiKeyEnc,
              secure: secure ? 1 : 0,
              engines,
              updatedAt: now,
            })
            .where(eq(hostsTable.id, locked.id));
        });
        const updatedRows = await db.select().from(hostsTable).where(eq(hostsTable.id, prev.id)).limit(1);
        let host = updatedRows[0]!;
        if (!secure) {
          await insecure.openInitial(host.id, insecureWindowMinutes);
          const refreshed = await db.select().from(hostsTable).where(eq(hostsTable.id, prev.id)).limit(1);
          host = refreshed[0] ?? host;
        }
        await audit(db, host.id, 'host.rotated', { fqdn: host.fqdn, createdBy: createdBy ?? null, engines });
        wsPublisher.publish('host.updated', { id: host.id, fqdn: host.fqdn });
        return { host, apiKey };
      }

      const engines = enginesIn ?? 'codex';
      const ins = await db.insert(hostsTable).values({
        fqdn: trimmed,
        apiKey: apiKeyHash,
        apiKeyHash,
        apiKeyEnc,
        status: 'active',
        secure: secure ? 1 : 0,
        engines,
        createdAt: now,
        updatedAt: now,
      });
      const insertedRow = ins[0] as { insertId?: number | bigint } | undefined;
      const insertedId = insertedRow?.insertId !== undefined ? Number(insertedRow.insertId) : 0;
      const inserted = await db.select().from(hostsTable).where(eq(hostsTable.id, insertedId)).limit(1);
      let host = inserted[0]!;
      if (!secure) {
        await insecure.openInitial(host.id, insecureWindowMinutes);
        const refreshed = await db.select().from(hostsTable).where(eq(hostsTable.id, host.id)).limit(1);
        host = refreshed[0] ?? host;
      }
      await audit(db, host.id, 'host.created', { fqdn: host.fqdn, createdBy: createdBy ?? null, engines });
      wsPublisher.publish('host.created', { id: host.id, fqdn: host.fqdn });
      return { host, apiKey };
    },
  };
}

async function audit(db: Database, hostId: number, type: string, payload: Record<string, unknown>): Promise<void> {
  const now = nowIso();
  await db.insert(adminEvents).values({ type, hostId, payload, createdAt: now });
  await db.insert(logsTable).values({ hostId, action: type, details: JSON.stringify(payload), createdAt: now });
}
