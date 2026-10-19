/**
 * "Needs attention" for one host, derived client-side from fields that are
 * already in the host payload (list or detail). No new endpoint: signals that
 * only the detail endpoint knows (fleet version targets) arrive through the
 * optional `versions` context and are skipped when absent.
 *
 * Only what needs an operator counts as a `warning`: a pending access approval.
 * Missing, stale or partial credentials and old versions repair themselves:
 * cxx fetches and seeds auth on the host's next run, so they are `info`
 * (detail page only) and never raise the count.
 */
import {
  hostCxxWrapperState,
  hostEngines,
  hostHasRequiredAuth,
  isInsecureWindowActive,
} from "$lib/api/hosts";
import { engineLabel } from "$lib/constants/engines";
import type { HostEngine, HostEngineReadinessReason, HostListItem } from "$lib/api/types";

/** What the Fix button does. The component owning the page wires each kind. */
export type AttentionFixKind = "install" | "review-access" | "close-window" | "engines-page";

export interface AttentionItem {
  id: string;
  /** `warning` counts as "needs attention"; `info` is shown on the detail page only. */
  tone: "warning" | "info";
  text: string;
  /** One line on what Fix does. */
  hint?: string;
  fix?: AttentionFixKind;
}

export interface AttentionContext {
  /** An insecure-access request from this host is waiting for an answer. */
  pendingApproval?: boolean;
  /** Engines switched off fleet-wide. */
  disabledEngines?: readonly string[];
  /** Fleet latest versions, from the detail overview. */
  versions?: Partial<Record<HostEngine, string | null>>;
}

const INSTALL_HINT = "Gets a fresh install command to run on the host.";

function installedVersion(host: HostListItem, engine: HostEngine): string | null {
  if (engine === "claude") return host.claude_client_version_override ?? host.claude_client_version ?? null;
  if (engine === "grok") return host.grok_client_version_override ?? host.grok_client_version ?? null;
  return host.client_version_override ?? host.client_version ?? null;
}

const READINESS_TEXT: Partial<Record<HostEngineReadinessReason, string>> = {
  cli_outdated: "is not at the target version",
  cli_unknown: "version or target is unknown",
};

export function hostAttention(host: HostListItem, ctx: AttentionContext = {}): AttentionItem[] {
  const items: AttentionItem[] = [];
  const assigned = hostEngines(host);
  const disabled = ctx.disabledEngines ?? [];
  const active = assigned.filter((engine) => !disabled.includes(engine));

  if (ctx.pendingApproval) {
    items.push({
      id: "access-request",
      tone: "warning",
      text: "Waiting for your approval to connect",
      hint: "Opens the access requests so you can allow or deny it.",
      fix: "review-access",
    });
  }

  if (host.authed === false) {
    items.push({ id: "auth-none", tone: "info", text: "No credentials received yet", hint: INSTALL_HINT, fix: "install" });
  } else if (host.auth_outdated) {
    items.push({ id: "auth-stale", tone: "info", text: "Credentials are older than the fleet's", hint: INSTALL_HINT, fix: "install" });
  } else if (!hostHasRequiredAuth(host)) {
    items.push({ id: "auth-partial", tone: "info", text: "Some engines have no credentials yet", hint: INSTALL_HINT, fix: "install" });
  }

  let wrapperOutdated = false;
  for (const engine of active) {
    const readiness = host.engine_readiness?.[engine as HostEngine];
    const label = engineLabel(engine);
    if (readiness) {
      for (const reason of readiness.reasons) {
        if (reason === "wrapper_outdated" || reason === "wrapper_unknown") wrapperOutdated = true;
        const text = READINESS_TEXT[reason];
        if (text) {
          items.push({ id: `${engine}-${reason}`, tone: "info", text: `${label} CLI ${text}`, hint: INSTALL_HINT, fix: "install" });
        }
      }
      continue;
    }
    // Older payload without readiness: compare with the fleet's latest, when known.
    const target = ctx.versions?.[engine as HostEngine];
    const have = installedVersion(host, engine as HostEngine);
    if (target && have && target !== have) {
      items.push({ id: `${engine}-drift`, tone: "info", text: `${label} is on ${have}, the fleet is on ${target}`, hint: INSTALL_HINT, fix: "install" });
    }
  }
  if (wrapperOutdated) {
    items.push({ id: "agent-outdated", tone: "info", text: "Host agent (cxx) is not at the target version", hint: INSTALL_HINT, fix: "install" });
  }

  const wrapper = hostCxxWrapperState(host);
  if (wrapper.drift) {
    items.push({ id: "agent-drift", tone: "info", text: `Host agent versions differ between engines: ${wrapper.display}`, hint: INSTALL_HINT, fix: "install" });
  }

  if (isInsecureWindowActive(host)) {
    items.push({
      id: "temp-access",
      tone: "info",
      text: `Temporary access is open until ${new Date(host.insecure_enabled_until ?? "").toLocaleString()}`,
      hint: "Closes the window now.",
      fix: "close-window",
    });
  }
  for (const engine of assigned.filter((e) => disabled.includes(e))) {
    items.push({
      id: `${engine}-fleet-off`,
      tone: "info",
      text: `${engineLabel(engine)} is switched off fleet-wide, so this host does not run or sync it`,
      hint: "Opens Engines, where it can be switched back on.",
      fix: "engines-page",
    });
  }
  return items;
}

export function attentionCount(items: readonly AttentionItem[]): number {
  return items.filter((item) => item.tone === "warning").length;
}
