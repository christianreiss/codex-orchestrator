import { ownerRuntimeFor, resolveOwnerHost } from '../control-plane/state/admission.js';
import { eq, getTableColumns, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { hosts, versions } from '../db/schema.js';
import { isTruthyFlagValue } from './settings.js';

function admissionQuery(db: Database, mode: 'hash' | 'legacy') {
  return db
    .select({
      ...getTableColumns(hosts),
      admissionApiDisabled: sql<
        string | null
      >`(SELECT ${versions.version} FROM ${versions} WHERE ${versions.name} = 'api_disabled' LIMIT 1)`,
      admissionReverseDns: sql<
        string | null
      >`(SELECT ${versions.version} FROM ${versions} WHERE ${versions.name} = 'reverse_dns_enabled' LIMIT 1)`,
    })
    .from(hosts)
    .where(eq(mode === 'hash' ? hosts.apiKeyHash : hosts.apiKey, sql.placeholder('credential')))
    .limit(1);
}
type Plan = ReturnType<ReturnType<typeof admissionQuery>['prepare']>;
const plans = new WeakMap<Database, Map<'hash' | 'legacy', Plan>>();

/** Reuse SQL construction only: every execution reads current rows and flags. */
export async function readTransportAdmission(db: Database, hash: string, key: string) {
  const owner = ownerRuntimeFor(db);
  if (owner) {
    owner.assertOwner();
    const snapshot = owner.state.snapshot();
    const host = resolveOwnerHost(db, hash, key);
    if (!host) return null;
    return { host, apiDisabled: snapshot.setting('api_disabled') === '1', reverseDnsDefault: isTruthyFlagValue(snapshot.setting('reverse_dns_enabled'), false) };
  }
  let variants = plans.get(db);
  if (!variants) {
    variants = new Map();
    plans.set(db, variants);
  }
  const read = async (mode: 'hash' | 'legacy', credential: string) => {
    let plan = variants.get(mode);
    if (!plan) {
      plan = admissionQuery(db, mode).prepare();
      variants.set(mode, plan);
    }
    return (await plan.execute({ credential }))[0];
  };
  // Preserve hash-first admission and the existing legacy-key fallback.
  const row = (await read('hash', hash)) ?? (await read('legacy', key));
  if (!row) return null;
  const { admissionApiDisabled, admissionReverseDns, ...host } = row;
  return {
    host,
    apiDisabled: admissionApiDisabled === '1',
    reverseDnsDefault: isTruthyFlagValue(admissionReverseDns, false),
  };
}
