import { hostCxxWrapperState, hostEngines, hostHasRequiredAuth } from "$lib/api/hosts";
import type { HostEngine, HostListItem } from "$lib/api/types";
import type { HostFindings } from "./attention";

/** Readiness reasons that mean "the CLI or the host agent is not at the target version". */
const VERSION_REASONS = new Set(["cli_outdated", "cli_unknown", "wrapper_outdated", "wrapper_unknown"]);

/**
 * Sorts the host list into the two buckets the Overview reports: credentials,
 * and versions. Uses only stable host fields (`authed`, `auth_outdated`,
 * `engine_readiness`) so it does not depend on the host page's own wording.
 */
export function hostFindings(hosts: readonly HostListItem[], disabledEngines: readonly string[]): HostFindings {
  const authProblems: string[] = [];
  const versionProblems: string[] = [];
  for (const host of hosts) {
    if (host.authed === false || host.auth_outdated || !hostHasRequiredAuth(host)) authProblems.push(host.fqdn);
    const behind = hostEngines(host)
      .filter((engine) => !disabledEngines.includes(engine))
      .some((engine) => host.engine_readiness?.[engine as HostEngine]?.reasons.some((reason) => VERSION_REASONS.has(reason)));
    if (behind || hostCxxWrapperState(host).drift) versionProblems.push(host.fqdn);
  }
  return { authProblems, versionProblems };
}
