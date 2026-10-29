import { createQuery } from "@tanstack/svelte-query";
import { api } from "./client";

/** Communicator API level (api/src/services/communicator-api-version.ts). */

export interface ApiLevelCounts {
  observed: number;
  below_min: number;
  below_current: number;
  at_current: number;
  unreported: number;
}

export interface CommunicatorApiState {
  /** Level this server speaks. */
  api_version: number;
  /** Effective minimum: max(code default, override), never above api_version. */
  min_api: number;
  default_min_api: number;
  override_min_api: number | null;
  override_updated_at: string | null;
  clients: { hosts: ApiLevelCounts; communicators: ApiLevelCounts };
}

export const communicatorApiQueryKey = ["communicator-api-version"] as const;

export function communicatorApiQuery() {
  return createQuery<CommunicatorApiState>({
    queryKey: communicatorApiQueryKey,
    queryFn: () => api.get<CommunicatorApiState>("/admin/communicator/api-version"),
  });
}
