/**
 * Integrations API — typed wrappers + svelte-query keys for every
 * third-party integration the orchestrator exposes.
 *
 * Current integrations: Joplin. Architected so additional integrations
 * (e.g. Nextcloud, Outline, Logseq) can be appended as sibling objects
 * without restructuring callers.
 */

import { api } from "./client";
import type {
  JoplinConfigPayload,
  JoplinConfigState,
  JoplinSyncState,
  JoplinTestResult,
} from "./types";

/** Stable svelte-query keys for integration resources. */
export const integrationKeys = {
  all: ["integrations"] as const,
  joplin: ["integrations", "joplin"] as const,
  joplinConfig: ["integrations", "joplin", "config"] as const,
};

/** Joplin endpoints. */
export const joplinApi = {
  /** GET /admin/joplin/config — returns config state (no password). */
  getConfig: () => api.get<JoplinConfigState>("/admin/joplin/config"),

  /** POST /admin/joplin/config — partial update; only supplied fields persist. */
  saveConfig: (payload: JoplinConfigPayload) =>
    api.post<JoplinConfigState>("/admin/joplin/config", payload),

  /** POST /admin/joplin/test — probe configured Joplin server. */
  test: () => api.post<JoplinTestResult>("/admin/joplin/test", {}),

  /** POST /admin/joplin/sync — full mirror into memory tier. */
  sync: () => api.post<JoplinSyncState>("/admin/joplin/sync", {}),
};

/** Returns a human-friendly explanation for {@link JoplinConfigState.activation_reason}. */
export function joplinActivationLabel(reason: string): string {
  switch (reason) {
    case "ready":
      return "Ready to enable";
    case "missing_url":
      return "Save a server URL before enabling";
    case "missing_email":
      return "Save an account email before enabling";
    case "missing_password":
      return "Save an account password before enabling";
    case "invalid_interval":
      return "Save a valid sync interval before enabling";
    case "verification_required":
      return "Run a successful connection test before enabling";
    default:
      return reason;
  }
}

/** Registry of integrations surfaced on the /integrations index. */
export interface IntegrationDescriptor {
  slug: string;
  name: string;
  description: string;
  href: string;
}

export const INTEGRATION_REGISTRY: IntegrationDescriptor[] = [
  {
    slug: "joplin",
    name: "Joplin",
    description: "Mirror notes from a Joplin server into the orchestrator's memory tier.",
    href: "/integrations/joplin",
  },
];
