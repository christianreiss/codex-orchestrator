import type { Host } from '../db/schema.js';
import { ENGINES, ENGINE_HOST_FIELDS, type Engine } from '../util/engine.js';
import { hostEnginesList } from './host-engine-policy.js';
import { applyHostClientVersionPin, type VersionSnapshot } from './version-snapshot.js';
import { isSemanticVersion, normalizeVersion } from './client-versions.js';

export type HostEngineReadinessReason = 'not_assigned' | 'fleet_disabled' | 'auth_missing' | 'cli_unknown' | 'cli_outdated' | 'wrapper_unknown' | 'wrapper_outdated';
export interface HostEngineReadiness {
  state: 'ready' | 'attention' | 'inactive';
  reasons: HostEngineReadinessReason[];
  cli_version: string | null;
  cli_target: string | null;
  wrapper_version: string | null;
  wrapper_target: string | null;
}

/** Semver precedence, including prereleases; build metadata does not change precedence. */
function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.split('+')[0]!.split(/-(.*)/s);
  const [ac, ap] = parts(a), [bc, bp] = parts(b);
  const an = ac!.split('.').map(BigInt), bn = bc!.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (an[i] !== bn[i]) return an[i]! > bn[i]! ? 1 : -1;
  if (ap === bp) return 0;
  if (ap === undefined) return 1;
  if (bp === undefined) return -1;
  const ai = ap.split('.'), bi = bp.split('.');
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    const av = ai[i], bv = bi[i];
    if (av === bv) continue;
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    const numericA = /^\d+$/.test(av), numericB = /^\d+$/.test(bv);
    if (numericA && numericB) return BigInt(av) > BigInt(bv) ? 1 : -1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return av > bv ? 1 : -1;
  }
  return 0;
}
function versionReason(installed: string | null, target: string | null, exact: boolean, prefix: 'cli' | 'wrapper'): HostEngineReadinessReason | null {
  const actual = normalizeVersion(installed), expected = normalizeVersion(target);
  if (!actual || !expected || !isSemanticVersion(actual) || !isSemanticVersion(expected)) return `${prefix}_unknown`;
  const comparison = compareVersions(actual, expected);
  return (exact ? comparison !== 0 : comparison < 0) ? `${prefix}_outdated` : null;
}

/** Auth existence is engine-local. Insecure hosts intentionally skip auth checks. */
export function hostEngineReadiness(host: Host, snapshots: Record<Engine, VersionSnapshot>): Record<Engine, HostEngineReadiness> {
  const assigned = hostEnginesList(host.engines);
  return Object.fromEntries(ENGINES.map((engine) => {
    const fields = ENGINE_HOST_FIELDS[engine];
    const snapshot = applyHostClientVersionPin(snapshots[engine], host, engine);
    const cli = host[fields.clientVersion] ?? null, wrapper = host[fields.wrapperVersion] ?? null;
    const target = snapshot.client_version_override ?? snapshot.client_version;
    const reasons: HostEngineReadinessReason[] = [];
    if (!assigned.includes(engine)) reasons.push('not_assigned');
    else if (snapshot.fleet_disabled_engines.includes(engine)) reasons.push('fleet_disabled');
    else {
      if (host.secure === 1 && !host[fields.authDigest]) reasons.push('auth_missing');
      const cliReason = versionReason(cli, target, snapshot.client_version_enforce_exact, 'cli');
      const wrapperReason = versionReason(wrapper, snapshot.wrapper_version, false, 'wrapper');
      if (cliReason) reasons.push(cliReason);
      if (wrapperReason) reasons.push(wrapperReason);
    }
    const inactive = reasons.includes('not_assigned') || reasons.includes('fleet_disabled');
    return [engine, { state: inactive ? 'inactive' : reasons.length ? 'attention' : 'ready', reasons,
      cli_version: cli, cli_target: target, wrapper_version: wrapper, wrapper_target: snapshot.wrapper_version }];
  })) as Record<Engine, HostEngineReadiness>;
}
