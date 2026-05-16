/**
 * API-keys feature endpoints.
 *
 * Engine-scoped: the backend exposes parallel routes under
 * `/admin/openai/...` (Codex / OpenAI) and `/admin/claude/...` (Anthropic).
 * We thin-wrap both behind a single typed surface so the route can render
 * an OpenAI + Claude section without duplicating fetch logic.
 */
import { api } from "./client";
import type {
  AdminApiKey,
  AdminApiKeyCreated,
  AdminApiKillSwitchState,
  ApiKeyEngine,
  CreateApiKeyPayload,
} from "./types";

const PREFIX: Record<ApiKeyEngine, string> = {
  openai: "/admin/openai",
  claude: "/admin/claude",
};

/** Stable query keys; mirrors the WS invalidation entries in `lib/ws/events.ts`. */
export const keyQueryKeys = {
  list: (engine: ApiKeyEngine) => ["keys", engine, "list"] as const,
  state: (engine: ApiKeyEngine) => ["keys", engine, "state"] as const,
};

export const keysApi = {
  list: (engine: ApiKeyEngine) =>
    api.get<AdminApiKey[]>(`${PREFIX[engine]}/keys`),

  create: (engine: ApiKeyEngine, payload: CreateApiKeyPayload) =>
    api.post<AdminApiKeyCreated>(`${PREFIX[engine]}/keys`, payload),

  toggle: (engine: ApiKeyEngine, id: number, active: boolean) =>
    api.post<{ message?: string }>(`${PREFIX[engine]}/keys/${id}/toggle`, {
      active,
    }),

  remove: (engine: ApiKeyEngine, id: number) =>
    api.delete<{ message?: string }>(`${PREFIX[engine]}/keys/${id}`),

  getState: (engine: ApiKeyEngine) =>
    api.get<AdminApiKillSwitchState>(`${PREFIX[engine]}/state`),

  setState: (engine: ApiKeyEngine, disabled: boolean) =>
    api.post<AdminApiKillSwitchState>(`${PREFIX[engine]}/state`, { disabled }),
};

/** Pretty label for the engine — used by toast copy + section headers. */
export function engineLabel(engine: ApiKeyEngine): string {
  return engine === "openai" ? "OpenAI" : "Claude";
}

/** Coerce DB-flavoured truthy values into a real boolean. */
export function isActive(record: AdminApiKey): boolean {
  const v = record.is_active;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return false;
}
