/**
 * Confirmation copy for the fleet-wide engine master switches.
 *
 * A pure function for the same reason as `agent-messaging-consequences.ts`:
 * the frontend suite is `node --test` over `.ts` modules with no component
 * harness, so copy inside a `.svelte` file cannot be reviewed by a test. This
 * is the one place the consequences of the switch are written down.
 *
 * Import-free on purpose: labels and commands come in as strings, so the test
 * needs neither the `$lib` alias nor the engine constants.
 */

export interface EngineSwitchContext {
  /** Display name, e.g. "Grok". */
  label: string;
  /** Wrapper command, e.g. "cgx". */
  command: string;
  /**
   * Active hosts that carry this engine. `null` while the hosts list is
   * loading or unavailable: the copy drops the number rather than guess.
   */
  activeHosts: number | null;
  /**
   * Base paths of enabled exposed APIs whose backend is this engine. `null`
   * while the API surfaces are loading or unavailable: the copy then speaks
   * of "any exposed API" instead of claiming there are none.
   */
  routedApis: string[] | null;
  /** Disabling would leave no engine enabled anywhere in the fleet. */
  lastEnabled: boolean;
}

export interface EngineSwitchConfirmCopy {
  title: string;
  description: string;
  consequences: string[];
  /** Extra emphasis shown above the list; only for turning off the last engine. */
  warning: string | null;
  confirmLabel: string;
  destructive: boolean;
}

function hostsPhrase(activeHosts: number | null, label: string): string {
  if (activeHosts === null) return `every active host that carries ${label}`;
  if (activeHosts === 1) return `the 1 active host that carries ${label}`;
  return `the ${activeHosts} active hosts that carry ${label}`;
}

function capitalize(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

function apiList(paths: string[]): string {
  if (paths.length <= 1) return paths.join("");
  return `${paths.slice(0, -1).join(", ")} and ${paths[paths.length - 1]}`;
}

export function engineSwitchConfirmCopy(
  enabling: boolean,
  ctx: EngineSwitchContext,
): EngineSwitchConfirmCopy {
  const { label, command } = ctx;
  const routed = ctx.routedApis;
  const apis = apiList(routed ?? []);

  if (enabling) {
    return {
      title: `Enable ${label} for the fleet`,
      description: `Restores ${label} everywhere it is assigned, without a reinstall.`,
      consequences: [
        // "every active host" and "the 1 active host" are singular subjects.
        `${capitalize(hostsPhrase(ctx.activeHosts, label))} ${ctx.activeHosts === null || ctx.activeHosts === 1 ? "resumes" : "resume"} ${command} on the next launch, or within 15 minutes through background maintenance.`,
        `The server resumes token refresh, verification, quota polling, account leasing, seeding and installers for ${label}.`,
        routed === null
          ? `Keys assigned to ${label}, and unassigned keys whose endpoint default is ${label}, can answer again.`
          : routed.length > 0
            ? `Unassigned keys on ${apis} can answer again. Keys assigned to ${label} on any endpoint can also answer again.`
            : `No endpoint default uses ${label}. Keys assigned to ${label} can answer again on any endpoint.`,
        `If ${label} was off for a long time, check Accounts first: a credential whose refresh lapsed while it was off has to be re-seeded before hosts can launch it.`,
      ],
      warning: null,
      confirmLabel: `Enable ${label}`,
      destructive: false,
    };
  }

  return {
    title: `Disable ${label} for the fleet`,
    description: `Everything that runs ${label} stops until you turn it back on. Nothing is uninstalled and no credentials are deleted.`,
    consequences: [
      `Suspends ${label} on ${hostsPhrase(ctx.activeHosts, label)}: ${command} refuses to launch, and those hosts stop syncing, updating and receiving messages for it. Other engines on the same host keep running.`,
      `Sessions already running are not killed, but no new ${label} session starts and no new account lease is granted.`,
      `The server stops token refresh, verification and quota polling for ${label} accounts, and refuses seeding and installers for it.`,
      routed === null
        ? `Keys assigned to ${label}, and unassigned keys whose endpoint default is ${label}, answer 503 until the engine is enabled or their routing changes.`
        : routed.length > 0
          ? `Unassigned keys on ${apis} answer 503 while the default engine is ${label}. Keys assigned to ${label} on any endpoint also answer 503; keys assigned to another enabled engine keep working.`
          : `No endpoint default uses ${label}. Keys assigned to ${label} still answer 503; keys using another enabled engine keep working.`,
      `Tokens are not refreshed while it is off. After a long pause, ${label} accounts may need to be re-seeded before hosts can launch again.`,
      `Model defaults, instructions and other configuration stay editable while it is off.`,
    ],
    warning: ctx.lastEnabled
      ? `${label} is the last enabled engine. With it off, no host can launch any agent until an engine is turned back on. The admin console keeps working.`
      : null,
    confirmLabel: ctx.lastEnabled ? "Turn off every engine" : `Disable ${label}`,
    destructive: true,
  };
}
