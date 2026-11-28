/**
 * Provider API keys: the real OpenAI, Anthropic, xAI and Moonshot keys that
 * answer a gateway surface while its source is `upstream`. Not the gateway
 * client keys (`keys.ts`): those authenticate callers, these pay the provider.
 *
 * A key value is write-only. It is sent once on create or rotate and no
 * response carries it again; records show `key_hint` only. Reads need
 * `auth.read_metadata`, every write `keys.manage`. Create and rotate do not
 * verify on their own; the console chains `verify` after a save.
 */
import { createQuery } from "@tanstack/svelte-query";
import { api } from "./client";
import type {
  ApiSource,
  ApiSurfaceId,
  ApiSurfaceRow,
  CreateProviderKeyPayload,
  ProviderId,
  ProviderKey,
  ProviderKeyState,
  ProviderKeysValue,
  UpdateProviderKeyPayload,
} from "./types";

/** Stable query key; mirrors the WS invalidation entries in `lib/ws/events.ts`. */
export const providerKeysQueryKey = ["provider-keys"] as const;

export function providerKeysQuery() {
  return createQuery<ProviderKeysValue>({
    queryKey: providerKeysQueryKey,
    queryFn: () => providerKeysApi.list(),
  });
}

export const providerKeysApi = {
  list: () => api.get<ProviderKeysValue>("/admin/provider-keys"),

  create: (payload: CreateProviderKeyPayload) => api.post<ProviderKey>("/admin/provider-keys", payload),

  update: (id: number, payload: UpdateProviderKeyPayload) =>
    api.patch<ProviderKey>(`/admin/provider-keys/${id}`, payload),

  setState: (id: number, state: ProviderKeyState) =>
    api.post<ProviderKey>(`/admin/provider-keys/${id}/state`, { state }),

  /** `GET {effective_base_url}/models` with the key; returns the record with its verdict. */
  verify: (id: number) => api.post<ProviderKey>(`/admin/provider-keys/${id}/verify`, {}),

  /** `ids` must list every key of `provider` exactly once (409 otherwise). */
  reorder: (provider: ProviderId, ids: number[]) =>
    api.post<{ keys: ProviderKey[] }>("/admin/provider-keys/order", { provider, ids }),

  /** Make this key its provider's key in use; 409 `provider_key_not_usable` when paused or rejected. */
  setCurrent: (id: number) =>
    api.post<{ provider: ProviderId; current_key_id: number }>(`/admin/provider-keys/${id}/current`, {}),

  remove: (id: number) => api.delete<{ id: number; message?: string }>(`/admin/provider-keys/${id}`),

  /** The surface default source. Lives with the provider keys because `upstream` spends them. */
  setSurfaceSource: (surface: ApiSurfaceId, source: ApiSource) =>
    api.post<ApiSurfaceRow>(`/admin/api/surfaces/${surface}/source`, { source }),
};
