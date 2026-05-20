/**
 * CLI device-code approval endpoints.
 *
 *   POST /cli/auth/lookup   → look up a pending request by user code
 *   POST /cli/auth/approve  → approve a pending request
 *   POST /cli/auth/deny     → deny a pending request
 *
 * Note: the backend uses `user_code` as the field name (not `code`). The
 * helpers below accept a normalized code string and translate.
 */

import { api } from "./client";
import type { CliAuthApprove, CliAuthLookup } from "./types";

/** Strip everything but A-Z/0-9 and uppercase. Returns the canonical `XXXX-9999` form when possible. */
export function normalizeCode(input: string): string {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length <= 4) return cleaned;
  return cleaned.slice(0, 4) + "-" + cleaned.slice(4, 8);
}

/** True when `code` matches the canonical `AAAA-9999` shape. */
export function isCodeComplete(code: string): boolean {
  return /^[A-Z]{4}-[0-9]{4}$/.test(code);
}

export function lookupCliAuth(code: string): Promise<CliAuthLookup> {
  return api.post<CliAuthLookup>("/cli/auth/lookup", { user_code: code });
}

export function approveCliAuth(code: string): Promise<CliAuthApprove> {
  return api.post<CliAuthApprove>("/cli/auth/approve", { user_code: code });
}

export function denyCliAuth(code: string): Promise<{ message: string; fqdn: string }> {
  return api.post<{ message: string; fqdn: string }>("/cli/auth/deny", { user_code: code });
}
