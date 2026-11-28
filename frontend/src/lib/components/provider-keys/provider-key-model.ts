/**
 * Pure rules for the Provider keys page and the source switch: labels, the
 * key in use and the order after it (sticky round robin), the failover
 * consequence of removing a key, reordering and error wording.
 *
 * Import-free at runtime (type imports are erased) so `node --test` loads it
 * without the `$lib` alias or svelte-query.
 */
import type { ApiSource, ProviderKey, ProviderKeyProvider, ProviderKeyVerificationState } from "../../api/types";

/** What the operator calls each source. "Subscription" is the emulated path. */
export const SOURCE_LABEL: Record<ApiSource, string> = { emulated: "Subscription", upstream: "API key" };

export type BadgeTone = "success" | "secondary" | "danger" | "warning" | "outline";

export const VERIFICATION: Record<ProviderKeyVerificationState, { label: string; tone: BadgeTone }> = {
  valid: { label: "Verified", tone: "success" },
  invalid: { label: "Rejected", tone: "danger" },
  unverified: { label: "Unchecked", tone: "outline" },
  error: { label: "Check failed", tone: "warning" },
};

/** A failover candidate: `active` and not rejected by the provider. */
export function isUsable(key: Pick<ProviderKey, "state" | "verification_state">): boolean {
  return key.state === "active" && key.verification_state !== "invalid";
}

/** One provider's keys in failover order (sort order, then id), as the server tries them. */
export function failoverOrder<K extends Pick<ProviderKey, "sort_order" | "id">>(keys: readonly K[]): K[] {
  return [...keys].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
}

/** `ids` with the entry at `index` moved by `delta`, or null when it cannot move. */
export function moveIds(ids: readonly number[], index: number, delta: -1 | 1): number[] | null {
  const target = index + delta;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return null;
  const next = [...ids];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/**
 * The key in use and the one after it, wrapping around: the order the server
 * tries a provider's usable keys in (sticky round robin), ignoring cooldowns.
 */
export function rotationFrom<K extends Pick<ProviderKey, "sort_order" | "id" | "state" | "verification_state">>(
  keys: readonly K[],
  currentId: number | null,
): K[] {
  const usable = failoverOrder(keys).filter(isUsable);
  const start = Math.max(0, usable.findIndex((key) => key.id === currentId));
  return [...usable.slice(start), ...usable.slice(0, start)];
}

/**
 * What changes for traffic when `key` stops being a candidate (deleted or
 * paused). "The next key takes over" is only true while another usable key
 * exists; for the last one the answer depends on the surface source.
 */
export function removalConsequence(
  key: ProviderKey,
  siblings: readonly ProviderKey[],
  provider: Pick<ProviderKeyProvider, "label" | "base_path" | "source"> & { current_key_id?: number | null },
): { text: string; lastUsable: boolean } {
  const api = provider.base_path ?? "the API";
  if (!isUsable(key)) {
    return { text: "It is not in the failover order now, so no request is answered differently.", lastUsable: false };
  }
  const rotation = rotationFrom(siblings, provider.current_key_id ?? null);
  const others = rotation.filter((entry) => entry.id !== key.id);
  if (others.length > 0) {
    const inUse = rotation[0]?.id === key.id;
    return {
      text: inUse
        ? `It is the key in use. The next key, ${others[0]!.label}, takes over and stays in use.`
        : `It is not the key in use, so requests still go to ${others[0]!.label}; it only leaves the failover order.`,
      lastUsable: false,
    };
  }
  return {
    text:
      provider.source === "upstream"
        ? `It is the last usable ${provider.label} key. ${api} answers with API key, so its requests fail (503) until another key is added or the source goes back to Subscription.`
        : `It is the last usable ${provider.label} key. ${api} answers with Subscription, so only gateway keys pinned to API key are affected: they fail until another key is added.`,
    lastUsable: true,
  };
}

/** The subset of `ApiError` the wording needs; duck-typed to stay import-free. */
export type KeyError = { message?: string; code?: string; status?: number } | null | undefined;

export type KeyField = "label" | "key" | "base_url";

/** The form field a server rejection belongs to, so it can be shown beside it (INT-2). */
export function errorField(error: KeyError): KeyField | null {
  if (!error) return null;
  if (error.code === "gateway_key_not_allowed" || error.code === "provider_key_duplicate") return "key";
  if (error.code === "invalid_base_url") return "base_url";
  if (error.code === "invalid_request") {
    const message = error.message ?? "";
    if (/^label\b/i.test(message)) return "label";
    if (/^key\b/i.test(message)) return "key";
    if (/^base_url\b|base url/i.test(message)) return "base_url";
  }
  return null;
}

/** One sentence per documented failure, naming the next step. Never echoes a key. */
export function keyErrorText(error: KeyError, providerLabel = "provider", engineLabel = "Its engine"): string {
  if (!error) return "";
  switch (error.code) {
    case "gateway_key_not_allowed":
      return "This is a gateway key issued by this orchestrator, not a provider API key. Paste a key from your provider account.";
    case "provider_key_duplicate":
      return `This key is already stored for ${providerLabel}.`;
    case "invalid_base_url":
      return `Base URL refused: ${error.message ?? "not an allowed address"}.`;
    case "provider_key_not_found":
      return "This key no longer exists; it was probably deleted elsewhere. The list has been refreshed.";
    case "provider_key_not_usable":
      return "Only an active key the provider has not rejected can be the key in use. Resume or verify it first.";
    case "provider_key_order_mismatch":
      return "The keys changed while you were reordering. The list has been refreshed; move the key again.";
    case "engine_disabled":
      return `${engineLabel} is switched off fleet-wide. Turn it back on under Engines to add, rotate or verify ${providerLabel} keys.`;
    case "provider_key_missing":
      return `No usable ${providerLabel} key is stored. Add one under Provider keys before switching to API key.`;
    default:
      return error.message || "The request failed.";
  }
}

/** Shape checks the server repeats; run at submission only (INT-2). */
export function validateKeyValue(value: string): string | null {
  const key = value.trim();
  if (!key) return "Paste the API key.";
  if (key.length < 16 || key.length > 1024) return "A provider key is 16 to 1,024 characters long.";
  if (/\s/.test(key)) return "The key must not contain spaces or line breaks.";
  return null;
}
