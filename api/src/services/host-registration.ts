import {persistAuditLog} from './audit-log.js';
import { mutateOwnerState, ownerRuntimeFor, type OwnerMutationContext } from '../control-plane/state/runtime.js';
import { materializeHost, stageHostRegistration } from '../control-plane/state/host-registration.js';
import { requestHost } from '../control-plane/state/admission.js';
import { suspendOwnedMessaging } from '../control-plane/state/suspension.js';
import { adminAudit } from '../control-plane/state/admin.js';
import { ENGINES } from '../util/engine.js';
import { isTruthyFlagValue } from './settings.js';
import type { FleetEngineState } from './engine-switch.js';
import { pruneHosts } from './host-lifecycle.js';
import { eq } from 'drizzle-orm';
import {
  adminEvents,
  installTokens,
  hosts as hostsTable,
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
import { ENGINE_CODEX, ENGINE_GROK } from '../util/engine.js';
import { ModelDefaultsService } from './model-defaults.js';
import { readFleetEngineState } from './engine-switch.js';
import { hostEnginesList } from './host-engine-policy.js';
import { assertEnginesAddable, parseEnginesInput } from './host-management.js';

/**
 * Host create + API-key rotate, used by the CLI auth approve path. Emits a
 * host.created / host.updated WS event and writes an admin_events audit row.
 */

export interface RegisteredHost {
  host: Host;
  apiKey: string;
}

export interface HostRegistrationInput {
    fqdn: string;
    secure?: boolean;
    insecureWindowMinutes?: number;
    engines?: string;
    createdBy?: string | null;
}
export interface HostRegistrationService {
  registerOrRotate(input: HostRegistrationInput): Promise<RegisteredHost>;
  stageOwned?(ctx: OwnerMutationContext, input: HostRegistrationInput, completed: (result: RegisteredHost) => void): void;
}

export interface HostRegistrationDeps {
  db: Database;
  keyring: Keyring;
  insecure: InsecureWindowService;
  defaultHostEngines?: string;
}

export function createHostRegistrationService(deps: HostRegistrationDeps): HostRegistrationService {
  const { db, keyring, insecure } = deps;
  const stageOwned = (ctx: OwnerMutationContext, { fqdn, secure = true, insecureWindowMinutes, engines: enginesIn, createdBy }: HostRegistrationInput, completed: (result: RegisteredHost) => void) => {
    const trimmed = fqdn.trim(), now = nowIso();
    const current = ctx.draft.table('hosts').by('fqdn', trimmed)[0];
    const fleet = Object.fromEntries(ENGINES.map(engine => [engine, !isTruthyFlagValue(ctx.draft.table('versions').get(`${engine}_engine_disabled`)?.version)])) as FleetEngineState;
    const defaults = parseEnginesInput(deps.defaultHostEngines, [ENGINE_CODEX]);
    const usable = defaults.filter(engine => fleet[engine]);
    const engines = enginesIn ?? current?.engines ?? (usable.length ? usable : defaults).join(',');
    assertEnginesAddable(hostEnginesList(engines), current ? hostEnginesList(current.engines) : [], fleet);
    if (hostEnginesList(engines).includes(ENGINE_GROK)) new ModelDefaultsService(db).stageGrokDefaults(ctx);
    const { key: apiKey, hash: apiKeyHash } = generateApiKey('sk-codex-');
    const patch = { apiKey: apiKeyHash, apiKeyHash, apiKeyEnc: encrypt(apiKey, keyring), secure: secure ? 1 : 0, engines, updatedAt: now };
    const finish = (hostId: number, created: boolean) => {
      if (!secure) {
        if (!insecure.stageInitial) throw new Error('Owner registration requires composed insecure-window service');
        insecure.stageInitial(ctx, hostId, insecureWindowMinutes);
      }
      const action = created ? 'host.created' : 'host.rotated';
      const details = { fqdn: trimmed, createdBy: createdBy ?? null, engines };
      stageHostRegistration(ctx, hostId, action, details, now);
      adminAudit(ctx, action, details, now, hostId);
      completed({ host: requestHost(ctx.draft.table('hosts').get(hostId)!, apiKey), apiKey });
    };
    if (current) {
      suspendOwnedMessaging(ctx, current.id, 'host_auth_rotated');
      for (const row of ctx.draft.table('installTokens').by('hostId', current.id)) ctx.draft.removeRow('installTokens', row);
      ctx.draft.upsert('hosts', { ...current, ...patch });
      ctx.write(async tx => tx.delete(installTokens).where(eq(installTokens.hostId, current.id)));
      ctx.write(async tx => tx.update(hostsTable).set(patch).where(eq(hostsTable.id, current.id)));
      finish(current.id, false);
    } else {
      const values = { ...patch, fqdn: trimmed, status: 'active', createdAt: now };
      ctx.write(async tx => {
        const result = await tx.insert(hostsTable).values(values);
        const hostId = Number(result[0]?.insertId);
        if (!Number.isSafeInteger(hostId) || hostId < 1) throw new Error('Host insert returned no identity');
        ctx.draft.upsert('hosts', materializeHost({ ...values, id: hostId }));
        finish(hostId, true);
      });
    }
  };
  return {
    stageOwned,
    async registerOrRotate(input) {
      const { fqdn, secure = true, insecureWindowMinutes, engines: enginesIn, createdBy } = input;
      const trimmed = fqdn.trim();
      const now = nowIso();
      const owner = ownerRuntimeFor(db);
      if (owner) {
        const result = await mutateOwnerState(owner, { kind: 'host.registration', payload: { fqdn: trimmed, secure, engines: enginesIn ?? null, createdBy: createdBy ?? null, insecureWindowMinutes: insecureWindowMinutes ?? null }, prepare(ctx) {
          let result!: RegisteredHost;
          stageOwned(ctx, input, value => { result = value; });
          return () => JSON.parse(JSON.stringify(result)) as import('../control-plane/commands.js').Json;
        } }) as unknown as RegisteredHost;
        wsPublisher.publish('host.updated', { id: result.host.id, fqdn: trimmed });
        return result;
      }
      const existing = await db.select().from(hostsTable).where(eq(hostsTable.fqdn, trimmed)).limit(1);

      // Same rule as the admin host forms: an engine switched off fleet-wide
      // cannot be newly assigned; one the host already carries may stay.
      const fleet = await readFleetEngineState(db);
      let newEngines = enginesIn ?? existing[0]?.engines;
      if (newEngines === undefined) {
        const defaults = parseEnginesInput(deps.defaultHostEngines, [ENGINE_CODEX]);
        const usable = defaults.filter((engine) => fleet[engine]);
        // Preserve the explicit engine_disabled error when no default remains.
        newEngines = (usable.length ? usable : defaults).join(',');
      }
      assertEnginesAddable(
        hostEnginesList(newEngines),
        existing[0] ? hostEnginesList(existing[0].engines) : [],
        fleet,
      );

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
          assertEnginesAddable(hostEnginesList(engines), hostEnginesList(locked.engines), await readFleetEngineState(tx));
          // The host API key fingerprints every active bridge and relay. Rotate
          // that authentication generation and fence all bus runtime together;
          // a secure/same-engine rotation is just as definitive as a demotion.
          await suspendAgentMessagingRuntimeLocked(tx, locked.id, 'host_auth_rotated');
          await tx.delete(installTokens).where(eq(installTokens.hostId, locked.id));
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
        if (engines.split(',').some(engine => engine.trim().toLowerCase() === ENGINE_GROK)) {
          await new ModelDefaultsService(db).ensureGrokDefaults();
        }
        if (!secure) {
          await insecure.openInitial(host.id, insecureWindowMinutes);
          const refreshed = await db.select().from(hostsTable).where(eq(hostsTable.id, prev.id)).limit(1);
          host = refreshed[0] ?? host;
        }
        await audit(db, host.id, 'host.rotated', { fqdn: host.fqdn, createdBy: createdBy ?? null, engines });
        wsPublisher.publish('host.updated', { id: host.id, fqdn: host.fqdn });
        await pruneHosts(db);
        return { host, apiKey };
      }

      const engines = newEngines;
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
      if (engines.split(',').some(engine => engine.trim().toLowerCase() === ENGINE_GROK)) {
        await new ModelDefaultsService(db).ensureGrokDefaults();
      }
      if (!secure) {
        await insecure.openInitial(host.id, insecureWindowMinutes);
        const refreshed = await db.select().from(hostsTable).where(eq(hostsTable.id, host.id)).limit(1);
        host = refreshed[0] ?? host;
      }
      await audit(db, host.id, 'host.created', { fqdn: host.fqdn, createdBy: createdBy ?? null, engines });
      wsPublisher.publish('host.created', { id: host.id, fqdn: host.fqdn });
      await pruneHosts(db);
      return { host, apiKey };
    },
  };
}

async function audit(db: Database, hostId: number, type: string, payload: Record<string, unknown>): Promise<void> {
  const now = nowIso();
  await db.insert(adminEvents).values({ type, hostId, payload, createdAt: now });
  await persistAuditLog(db, { hostId, action: type, details: JSON.stringify(payload), createdAt: now });
}
