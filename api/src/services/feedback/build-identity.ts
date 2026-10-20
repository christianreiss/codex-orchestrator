/** Replaced by esbuild, not read from the runtime checkout or mutable env. */
declare const __ORCHESTRATOR_BUILD__: { commit: string | null; dirty: boolean };
export interface BuildIdentity { commit: string | null; dirty: boolean }
export function buildIdentity(): BuildIdentity {
  return typeof __ORCHESTRATOR_BUILD__ === 'undefined'
    ? { commit: null, dirty: true }
    : __ORCHESTRATOR_BUILD__;
}
export function classifyVersion(build: BuildIdentity, upstream: string): 'unknown' | 'old_version' | 'recent' {
  if (build.dirty || !build.commit || !/^[a-f0-9]{40}$/.test(build.commit)) return 'unknown';
  return build.commit === upstream ? 'recent' : 'old_version';
}
