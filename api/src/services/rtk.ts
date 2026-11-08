import { createHash } from 'node:crypto';
import type { Database } from '../db/client.js';
import { versions } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import type { Engine } from '../util/engine.js';
import { assertHostEngineAssigned } from './host-engine-policy.js';
import { SettingsService } from './settings.js';
import { persistAuditLog } from './audit-log.js';
import { mutateOwnerState, ownerRuntimeFor } from '../control-plane/state/runtime.js';
import { adminAudit } from '../control-plane/state/admin.js';
import { wsPublisher } from '../ws/publisher.js';

export const RTK_VERSION = '1.2.0';
export const rtkPolicyKey = (engine: Engine, hostId?: number) =>
  `rtk_${engine}${hostId == null ? '' : `_host_${hostId}`}`;
export const rtkReportKey = (engine: Engine, hostId: number) => `rtk_report_${engine}_host_${hostId}`;

export function validateRtkEnabled(body: unknown, allowInherit = false): boolean | null {
  if (
    body == null ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => k !== 'enabled')
  )
    throw new ValidationError('Expected enabled boolean');
  const enabled = (body as { enabled?: unknown }).enabled;
  if (typeof enabled === 'boolean' || (allowInherit && enabled === null)) return enabled;
  throw new ValidationError(
    allowInherit ? 'enabled must be boolean or null to inherit' : 'enabled must be boolean',
  );
}

export function resolveRtkPolicy(
  fleetRaw: string | null,
  overrideRaw: string | null,
  fleetAt: string | null,
  overrideAt: string | null,
) {
  const fleet = fleetRaw === 'true';
  const override = overrideRaw === 'true' ? true : overrideRaw === 'false' ? false : null;
  return {
    enabled: override ?? fleet,
    source: override === null ? ('fleet' as const) : ('host' as const),
    override,
    fleet,
    policy_revision: createHash('sha256')
      .update(JSON.stringify([fleetRaw, overrideRaw, fleetAt, overrideAt]))
      .digest('hex'),
  };
}
export async function rtkPolicy(db: Database, engine: Engine, hostId?: number) {
  const settings = new SettingsService(db);
  const fleet = await settings.getWithMeta(rtkPolicyKey(engine));
  const host =
    hostId === undefined
      ? { value: null, updatedAt: null }
      : await settings.getWithMeta(rtkPolicyKey(engine, hostId));
  return {
    ...resolveRtkPolicy(fleet.value, host.value, fleet.updatedAt, host.updatedAt),
    adapter_mode: 'instructions' as const,
  };
}
export async function storeRtkPolicy(db: Database, engine: Engine, enabled: boolean | null, hostId?: number) {
  const key = rtkPolicyKey(engine, hostId);
  const value = enabled === null ? '' : String(enabled);
  const owner = ownerRuntimeFor(db);
  const at = new Date().toISOString();
  const details = { engine, enabled, host_id: hostId ?? null };
  if (owner) {
    await mutateOwnerState(owner, {
      kind: 'rtk.policy',
      payload: details,
      prepare(ctx) {
        if (hostId !== undefined) {
          const host = ctx.snapshot.hosts.get(hostId);
          if (!host) throw new NotFoundError('Host not found');
          assertHostEngineAssigned(host, engine);
        }
        const row = { name: key, version: value, updatedAt: at };
        ctx.draft.upsert('versions', row);
        ctx.write((tx) =>
          tx
            .insert(versions)
            .values(row)
            .onDuplicateKeyUpdate({ set: { version: value, updatedAt: at } }),
        );
        ctx.write((tx) =>
          persistAuditLog(tx, {
            hostId: hostId ?? null,
            action: 'admin.rtk',
            details: JSON.stringify(details),
            createdAt: at,
          }),
        );
        adminAudit(ctx, 'settings.changed', details, at, hostId ?? null);
        return null;
      },
    });
  } else {
    await new SettingsService(db).set(key, value, { publish: false });
    await persistAuditLog(db, {
      hostId: hostId ?? null,
      action: 'admin.rtk',
      details: JSON.stringify(details),
      createdAt: at,
    });
  }
  wsPublisher.publish('settings.changed', { key });
  if (hostId !== undefined) wsPublisher.publish('host.updated', { id: hostId });
  return rtkPolicy(db, engine, hostId);
}

export const RTK_ERROR_CODES = [
  'disabled',
  'unsupported_platform',
  'unsupported_native',
  'download_failed',
  'integrity_failed',
  'install_failed',
  'hook_conflict',
  'hook_failed',
  'recall_failed',
  'unavailable',
] as const;
export function validateRtkReport(value: unknown, observedAt: string) {
  if (value == null || typeof value !== 'object' || Array.isArray(value))
    throw new ValidationError('Invalid RTK report');
  const body = value as Record<string, unknown>;
  const allowed = [
    'engine',
    'adapter_mode',
    'ready',
    'wrapper_version',
    'native_version',
    'rtk_version',
    'policy_revision',
    'error_code',
  ];
  if (Object.keys(body).some((k) => !allowed.includes(k)) || typeof body.ready !== 'boolean')
    throw new ValidationError('Invalid RTK report fields');
  if (body.adapter_mode !== 'instructions') throw new ValidationError('Invalid adapter_mode');
  for (const key of ['wrapper_version', 'native_version', 'rtk_version']) {
    if (typeof body[key] !== 'string' || !/^[a-zA-Z0-9.+_-]{0,80}$/.test(body[key] as string))
      throw new ValidationError(`Invalid ${key}`);
  }
  if (
    body.policy_revision !== null &&
    (typeof body.policy_revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.policy_revision))
  )
    throw new ValidationError('Invalid policy_revision');
  if (
    body.error_code !== undefined &&
    !RTK_ERROR_CODES.includes(body.error_code as (typeof RTK_ERROR_CODES)[number])
  )
    throw new ValidationError('Invalid error_code');
  return {
    engine: body.engine,
    adapter_mode: body.adapter_mode,
    ready: body.ready,
    wrapper_version: body.wrapper_version,
    native_version: body.native_version,
    rtk_version: body.rtk_version,
    policy_revision: body.policy_revision,
    ...(body.error_code === undefined ? {} : { error_code: body.error_code }),
    observed_at: observedAt,
  };
}
