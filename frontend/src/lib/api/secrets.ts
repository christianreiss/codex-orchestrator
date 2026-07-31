/**
 * Fleet secrets store endpoints.
 *
 * The working credentials agents read over MCP — GitHub PATs, database
 * passwords, service tokens — as opposed to the engine-boot auth under
 * `/auth`, which has its own lifecycle and is never managed here.
 *
 * Only `reveal` ever returns a plaintext, and it is a POST on purpose: a GET
 * could be prefetched by the browser, cached by an intermediary, and replayed
 * out of history. Every mutation here, and the reveal, requires the owner or
 * admin role; the backend answers other roles with 403 `admin_role_required`.
 */
import { api } from "./client";
import type {
  AdminSecret,
  AdminSecretListResponse,
  AdminSecretResponse,
  AdminSecretRevealResponse,
  AdminSecretUpdateResponse,
  AdminSecretsModuleState,
  CreateSecretPayload,
  UpdateSecretPayload,
} from "./types";

/** Stable query keys; mirrors the WS invalidation entries in `lib/ws/events.ts`. */
export const secretQueryKeys = {
  list: () => ["secrets", "list"] as const,
  state: () => ["secrets", "state"] as const,
};

export const secretsApi = {
  list: async (includeDeleted = false): Promise<AdminSecret[]> => {
    const qs = includeDeleted ? "?include_deleted=1" : "";
    const res = await api.get<AdminSecretListResponse>(`/admin/secrets${qs}`);
    return res.secrets ?? [];
  },

  create: (payload: CreateSecretPayload) =>
    api.post<AdminSecretResponse>("/admin/secrets", payload),

  update: (id: number, payload: UpdateSecretPayload) =>
    api.patch<AdminSecretUpdateResponse>(`/admin/secrets/${id}`, payload),

  remove: (id: number) => api.delete<AdminSecretResponse>(`/admin/secrets/${id}`),

  reveal: (id: number) =>
    api.post<AdminSecretRevealResponse>(`/admin/secrets/${id}/reveal`, {}),

  getState: () => api.get<AdminSecretsModuleState>("/admin/secrets/state"),

  setState: (enabled: boolean) =>
    api.post<AdminSecretsModuleState>("/admin/secrets/state", { enabled }),
};

/** Null engine means every engine, matching how the backend scopes visibility. */
export function engineScopeLabel(engine: AdminSecret["engine"]): string {
  if (engine === "codex") return "Codex only";
  if (engine === "claude") return "Claude only";
  return "Both engines";
}

/**
 * Who may rotate or delete this over MCP. A secret created here belongs to no
 * host, which is what keeps agents from overwriting a shared credential; one an
 * agent created is theirs to manage.
 */
export function ownerLabel(secret: AdminSecret): string {
  return secret.source_host_id === null ? "Operator" : `Host #${secret.source_host_id}`;
}

/** The MCP call an agent makes to read this secret — shown so operators can hand it over. */
export function agentUsage(slug: string): string {
  return `secret_get ${slug}`;
}
