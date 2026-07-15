/**
 * Account self-management API helpers.
 *
 * Wraps the password + passkey endpoints under `/admin/auth/*` and
 * `/admin/passkeys/*`. Designed for use with @tanstack/svelte-query —
 * the listed queryKey conventions match the WS invalidation map.
 */
import { api } from "./client";
import type {
  Passkey,
  PasskeyListResponse,
  PasskeyRegisterResponse,
  PasskeyRegistrationOptionsJSON,
  PasswordChangeRequest,
  PasswordChangeResponse,
} from "./types";

// ---- Theme ----

/** Supported admin theme values mirror the server side ADMIN_THEMES list. */
export type AccountTheme =
  | "auto"
  | "light"
  | "dark"
  | "auto-pink"
  | "bright-pink"
  | "dark-pink";

export interface ThemeResponse {
  theme: AccountTheme;
}

/** GET /admin/theme — returns the currently persisted admin theme preference. */
export function getTheme() {
  return api.get<ThemeResponse>("/admin/theme");
}

/** POST /admin/theme — persist the admin theme preference. */
export function setTheme(theme: AccountTheme) {
  return api.post<ThemeResponse>("/admin/theme", { theme });
}

// ---- Password ----

/** POST /admin/auth/password/change */
export function changePassword(payload: PasswordChangeRequest) {
  return api.post<PasswordChangeResponse>("/admin/auth/password/change", payload);
}

/** POST /admin/auth/password/request — sends a reset token by email. */
export function requestPasswordReset(input: { username?: string; email?: string }) {
  return api.post<unknown>("/admin/auth/password/request", input);
}

/** POST /admin/auth/password/reset — consumes a one-time reset token. */
export function resetPassword(input: {
  token: string;
  new_password: string;
  confirm_password: string;
}) {
  return api.post<unknown>("/admin/auth/password/reset", input);
}

// ---- Passkeys ----

/** GET /admin/passkeys → list of registered passkeys for the current user. */
export async function listPasskeys(): Promise<Passkey[]> {
  const data = await api.get<PasskeyListResponse>("/admin/passkeys");
  return data.passkeys ?? [];
}

/** POST /admin/auth/passkey/register/options → JSON registration options. */
export function passkeyRegisterOptions() {
  return api.post<PasskeyRegistrationOptionsJSON>("/admin/auth/passkey/register/options");
}

/**
 * POST /admin/auth/passkey/register — submits `{ response: attestation }`,
 * where `attestation` is the PublicKeyCredentialJSON produced by
 * @simplewebauthn/browser's startRegistration().
 */
export function passkeyRegister(payload: Record<string, unknown>) {
  return api.post<PasskeyRegisterResponse>("/admin/auth/passkey/register", payload);
}

/** POST /admin/passkeys/{id}/name — rename a registered passkey. */
export function renamePasskey(id: number | string, name: string) {
  return api.post<unknown>(`/admin/passkeys/${encodeURIComponent(String(id))}/name`, { name });
}

/** DELETE /admin/passkeys/{id} — revoke a registered passkey. */
export function deletePasskey(id: number | string) {
  return api.delete<unknown>(`/admin/passkeys/${encodeURIComponent(String(id))}`);
}

// ---- Query keys (shared across views) ----

export const accountKeys = {
  passkeys: ["passkeys"] as const,
  theme: ["settings", "theme"] as const,
};
