/**
 * Auth seeding + canonical upload for the operator-facing admin UI.
 *
 * Two operator workflows live behind `/admin/auth/*`:
 *  - `seed-command` mints a short-lived bash one-liner the operator runs on the
 *    host to capture credentials, returned as `{ command, expires_at, engine }`.
 *    Only a backend running without a database cannot mint a token; it falls
 *    back to a bare `{ status, queued }` acknowledgement, so the SeedAuthDialog
 *    accepts either shape.
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

/** The subset this UI reads of the upload route's `StoreAuthCandidateResult` + `{ received, size }`. */
export interface UploadAuthResponse {
  status?: string;
  received?: boolean;
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
