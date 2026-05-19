/**
 * Auth seeding + canonical upload for the operator-facing admin UI.
 *
 * Two operator workflows live behind `/admin/auth/*`:
 *  - `seed-command` returns a short-lived bash one-liner the operator runs on
 *    the host to capture credentials. The backend currently stubs the response
 *    as `{ status, queued }`; the SeedAuthDialog accepts either that shape or
 *    a future `{ command, expires_at }` envelope.
 *  - `upload` accepts the canonical auth payload (Codex auth JSON or Claude
 *    API key) so the fleet can repair drifted hosts directly.
 */
import {
  createMutation,
  type QueryClient,
} from "@tanstack/svelte-query";
import { api, ApiError } from "./client";
import { hostsKeys } from "./hosts";

export type AuthEngine = "codex" | "claude";

export interface SeedCommandResponse {
  status?: string;
  queued?: boolean;
  command?: string;
  expires_at?: string;
}

export interface UploadAuthResponse {
  status?: string;
  queued?: boolean;
  received?: boolean;
  filename?: string | null;
  size?: number;
}

export interface SeedCommandVars {
  engine: AuthEngine;
}

export interface UploadAuthVars {
  engine: AuthEngine;
  payload: string;
}

export function createSeedCommandMutation() {
  return createMutation<SeedCommandResponse, ApiError, SeedCommandVars>({
    mutationFn: ({ engine }) =>
      api.post<SeedCommandResponse>("/admin/auth/seed-command", { engine }),
  });
}

export function createUploadAuthMutation(qc: QueryClient) {
  return createMutation<UploadAuthResponse, ApiError, UploadAuthVars>({
    mutationFn: ({ engine, payload }) =>
      api.post<UploadAuthResponse>("/admin/auth/upload", { engine, payload }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hostsKeys.all() });
    },
  });
}
