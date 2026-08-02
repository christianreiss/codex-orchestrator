/**
 * Doctor feature endpoints.
 *
 * `GET /admin/doctor` is a server-side self-diagnostic: connectivity,
 * migrations, canonical auth, encryption keyring, kill-switches, and issued
 * key counts as a flat row list. It is deliberately pull-on-demand (the
 * runner check makes a real HTTP call), so the page wires this into a
 * mutation rather than an auto-fetching query -- see SeedAuthDialog's
 * `createSeedCommandMutation` for the same "GET-shaped but explicit action"
 * pattern.
 *
 * `POST /admin/doctor/test-key` relays a single pasted key through the real
 * proxy auth path. It only ever tests a key the operator pastes in -- never
 * a stored key by reference -- and a passing/failing result still counts
 * against that key's real rate limit and use count.
 */
import { api } from "./client";
import type { ApiKeyEngine } from "./types";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorRow {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  hint?: string | null;
  /** Route that owns remediation for this row -- link only, never an inline control. */
  owner_route?: string | null;
}

export interface DoctorReport {
  generated_at: string;
  rows: DoctorRow[];
  hosts: { total: number; synced: number };
  canonical_auth: { codex: boolean; claude: boolean };
}

export interface DoctorTestKeyPayload {
  engine: ApiKeyEngine;
  key: string;
}

export interface DoctorTestKeyResult {
  ok: boolean;
  status: number | null;
  latency_ms: number;
  model_count?: number;
  error?: string;
}

export const doctorApi = {
  status: () => api.get<DoctorReport>("/admin/doctor"),

  testKey: (payload: DoctorTestKeyPayload) =>
    api.post<DoctorTestKeyResult>("/admin/doctor/test-key", payload),
};
