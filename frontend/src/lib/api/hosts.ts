/**
 * Hosts feature — svelte-query builders for the host list + per-host detail
 * routes, plus mutations for every toggle / version / model / lifecycle
 * action exposed under /admin/hosts/{id}/*.
 *
 * Each mutation factory exposes optimistic-update plumbing so the host
 * detail toggles flip instantly in the UI and roll back if the request
 * fails (using svelte-query's onMutate / onError / onSettled).
 */
import {
  createQuery,
  createMutation,
  type QueryClient,
} from "@tanstack/svelte-query";
import { api, ApiError } from "./client";
import type {
  HostsListResponse,
  HostDetailResponse,
  HostListItem,
  HostDetail,
  HostRegisterPayload,
  HostQuickRegisterPayload,
  HostRegisterResponse,
  HostInstallerResponse,
} from "./types";

// --- query keys -----------------------------------------------------------

export const hostsKeys = {
  all: () => ["hosts"] as const,
  list: () => ["hosts", "list"] as const,
  detail: (id: number | string) => ["hosts", "detail", String(id)] as const,
  insecure: () => ["hosts", "insecure"] as const,
};

// --- queries --------------------------------------------------------------

export function hostsListQuery() {
  return createQuery<HostsListResponse>({
    queryKey: hostsKeys.list(),
    queryFn: () => api.get<HostsListResponse>("/admin/hosts"),
  });
}

export function hostDetailQuery(id: number | string) {
  return createQuery<HostDetailResponse>({
    queryKey: hostsKeys.detail(id),
    queryFn: () => api.get<HostDetailResponse>(`/admin/hosts/${id}/detail`),
    enabled: id !== undefined && id !== null && String(id) !== "",
  });
}

// --- create / delete ------------------------------------------------------

export function createRegisterHostMutation() {
  return createMutation<HostRegisterResponse, ApiError, HostRegisterPayload>({
    mutationFn: (payload) =>
      api.post<HostRegisterResponse>("/admin/hosts/register", payload),
  });
}

export function createQuickRegisterMutation() {
  return createMutation<
    HostRegisterResponse,
    ApiError,
    HostQuickRegisterPayload
  >({
    mutationFn: (payload) =>
      api.post<HostRegisterResponse>("/admin/hosts/quick-register", payload),
  });
}

export function createDeleteHostMutation(qc: QueryClient) {
  return createMutation<void, ApiError, { id: number | string }>({
    mutationFn: ({ id }) => api.delete<void>(`/admin/hosts/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hostsKeys.all() });
    },
  });
}

export function createClearHostAuthMutation(qc: QueryClient) {
  return createMutation<void, ApiError, { id: number | string }>({
    mutationFn: ({ id }) => api.post<void>(`/admin/hosts/${id}/clear`),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: hostsKeys.detail(vars.id) });
      void qc.invalidateQueries({ queryKey: hostsKeys.list() });
    },
  });
}

export function createMintInstallerMutation(qc: QueryClient) {
  return createMutation<
    HostInstallerResponse,
    ApiError,
    { id: number | string }
  >({
    mutationFn: ({ id }) =>
      api.post<HostInstallerResponse>(`/admin/hosts/${id}/installer`),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: hostsKeys.detail(vars.id) });
      void qc.invalidateQueries({ queryKey: hostsKeys.list() });
    },
  });
}

// --- generic optimistic boolean-toggle factory ----------------------------

type BoolToggleField =
  | "secure"
  | "vip"
  | "roaming"
  | "auto_update"
  | "scaling_exempt"
  | "curl_insecure";

type ToggleEndpointPath =
  | "secure"
  | "vip"
  | "roaming"
  | "auto-update"
  | "scaling-exempt"
  | "curl-insecure";

interface ToggleConfig {
  endpoint: ToggleEndpointPath;
  /** Field on HostDetail to flip in the cache. */
  detailField: keyof HostDetail;
  /** Body key sent to the backend. */
  bodyKey: BoolToggleField | "enabled";
}

interface ToggleVars {
  id: number | string;
  value: boolean;
}

/**
 * Build a mutation that optimistically toggles a boolean field on a host.
 *
 * onMutate snapshots the cached detail entry, writes the new value, and
 * returns the previous value so onError can roll it back. onSettled forces
 * a refresh from the server.
 */
function makeBoolToggle(qc: QueryClient, cfg: ToggleConfig) {
  return createMutation<
    unknown,
    ApiError,
    ToggleVars,
    { previous?: HostDetailResponse }
  >({
    mutationFn: ({ id, value }) =>
      api.post(`/admin/hosts/${id}/${cfg.endpoint}`, { [cfg.bodyKey]: value }),
    onMutate: async ({ id, value }) => {
      await qc.cancelQueries({ queryKey: hostsKeys.detail(id) });
      const previous = qc.getQueryData<HostDetailResponse>(
        hostsKeys.detail(id),
      );
      if (previous && previous.host) {
        qc.setQueryData<HostDetailResponse>(hostsKeys.detail(id), {
          ...previous,
          host: { ...previous.host, [cfg.detailField]: value } as HostDetail,
        });
      }
      return { previous };
    },
    onError: (_err, vars, ctx) => {
      if (ctx?.previous) {
        qc.setQueryData(hostsKeys.detail(vars.id), ctx.previous);
      }
    },
    onSettled: (_data, _err, vars) => {
      void qc.invalidateQueries({ queryKey: hostsKeys.detail(vars.id) });
      void qc.invalidateQueries({ queryKey: hostsKeys.list() });
    },
  });
}

export function createSecureToggleMutation(qc: QueryClient) {
  return makeBoolToggle(qc, {
    endpoint: "secure",
    detailField: "secure",
    bodyKey: "secure",
  });
}

export function createVipToggleMutation(qc: QueryClient) {
  return makeBoolToggle(qc, {
    endpoint: "vip",
    detailField: "vip",
    bodyKey: "vip",
  });
}

export function createRoamingToggleMutation(qc: QueryClient) {
  return makeBoolToggle(qc, {
    endpoint: "roaming",
    detailField: "allow_roaming_ips",
    bodyKey: "roaming",
  });
}

export function createAutoUpdateToggleMutation(qc: QueryClient) {
  return createMutation<
    unknown,
    ApiError,
    ToggleVars,
    { previous?: HostDetailResponse }
  >({
    mutationFn: ({ id, value }) =>
      api.post(`/admin/hosts/${id}/auto-update`, { auto_update: value }),
    onMutate: async ({ id, value }) => {
      await qc.cancelQueries({ queryKey: hostsKeys.detail(id) });
      const previous = qc.getQueryData<HostDetailResponse>(
        hostsKeys.detail(id),
      );
      if (previous && previous.host) {
        qc.setQueryData<HostDetailResponse>(hostsKeys.detail(id), {
          ...previous,
          host: {
            ...previous.host,
            auto_update_override: value,
            effective_auto_update_enabled: value,
          },
        });
      }
      return { previous };
    },
    onError: (_err, vars, ctx) => {
      if (ctx?.previous)
        qc.setQueryData(hostsKeys.detail(vars.id), ctx.previous);
    },
    onSettled: (_d, _e, vars) => {
      void qc.invalidateQueries({ queryKey: hostsKeys.detail(vars.id) });
      void qc.invalidateQueries({ queryKey: hostsKeys.list() });
    },
  });
}

export function createScalingExemptToggleMutation(qc: QueryClient) {
  return makeBoolToggle(qc, {
    endpoint: "scaling-exempt",
    // No direct field; reflect on lane_preference via refetch.
    detailField: "lane_preference",
    bodyKey: "scaling_exempt",
  });
}

export function createCurlInsecureToggleMutation(qc: QueryClient) {
  return makeBoolToggle(qc, {
    endpoint: "curl-insecure",
    detailField: "curl_insecure",
    bodyKey: "curl_insecure",
  });
}

// --- version / model / reverse-dns / agents-version ----------------------

export function createReverseDnsMutation(qc: QueryClient) {
  return createMutation<
    unknown,
    ApiError,
    { id: number | string; mode: "global" | "enabled" | "disabled" }
  >({
    mutationFn: ({ id, mode }) =>
      api.post(`/admin/hosts/${id}/reverse-dns`, { reverse_dns_mode: mode }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: hostsKeys.detail(vars.id) });
      void qc.invalidateQueries({ queryKey: hostsKeys.list() });
    },
  });
}

export function createModelOverrideMutation(qc: QueryClient) {
  return createMutation<
    unknown,
    ApiError,
    {
      id: number | string;
      engine?: "codex" | "claude";
      model?: string | null;
      reasoning_effort?: string | null;
    }
  >({
    mutationFn: ({ id, engine, model, reasoning_effort }) =>
      api.post(`/admin/hosts/${id}/model`, {
        engine,
        model,
        reasoning_effort,
      }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: hostsKeys.detail(vars.id) });
      void qc.invalidateQueries({ queryKey: hostsKeys.list() });
    },
  });
}

export function createCodexVersionMutation(qc: QueryClient) {
  return createMutation<
    unknown,
    ApiError,
    { id: number | string; version: string | null }
  >({
    mutationFn: ({ id, version }) =>
      api.post(`/admin/hosts/${id}/codex-version`, { client_version: version }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: hostsKeys.detail(vars.id) });
      void qc.invalidateQueries({ queryKey: hostsKeys.list() });
    },
  });
}

export function createClaudeVersionMutation(qc: QueryClient) {
  return createMutation<
    unknown,
    ApiError,
    { id: number | string; version: string | null }
  >({
    mutationFn: ({ id, version }) =>
      api.post(`/admin/hosts/${id}/claude-version`, {
        client_version: version,
      }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: hostsKeys.detail(vars.id) });
      void qc.invalidateQueries({ queryKey: hostsKeys.list() });
    },
  });
}

export function createAgentsVersionMutation(qc: QueryClient) {
  return createMutation<
    unknown,
    ApiError,
    { id: number | string; document_id: number | null }
  >({
    mutationFn: ({ id, document_id }) =>
      api.post(`/admin/hosts/${id}/agents-version`, {
        agents_document_id: document_id,
      }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: hostsKeys.detail(vars.id) });
    },
  });
}

// --- helpers --------------------------------------------------------------

/** Returns true if the host's insecure window is currently open. */
export function isInsecureWindowActive(host: {
  secure?: boolean;
  insecure_enabled_until?: string | null;
}): boolean {
  if (host.secure) return false;
  const until = host.insecure_enabled_until;
  if (!until) return false;
  const ts = Date.parse(until);
  if (Number.isNaN(ts)) return false;
  return ts > Date.now();
}

/** Engine list as canonical lowercase strings. */
export function hostEngines(
  h: Pick<HostListItem, "engines_list" | "engines">,
): string[] {
  const list = Array.isArray(h.engines_list) ? h.engines_list : [];
  if (list.length > 0) return list as string[];
  if (typeof h.engines === "string" && h.engines.trim() !== "") {
    return h.engines
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** Classify a host into one of the filter-chip buckets. */
export type HostFilterId =
  | "all"
  | "online"
  | "offline"
  | "secure"
  | "insecure"
  | "unprovisioned"
  | "vip"
  | "roaming";

export function hostMatchesFilter(
  host: HostListItem,
  filter: HostFilterId,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "online":
      return (
        (host.status ?? "").toLowerCase() === "active" ||
        (host.status ?? "").toLowerCase() === "online"
      );
    case "offline":
      return (
        (host.status ?? "").toLowerCase() === "stale" ||
        (host.status ?? "").toLowerCase() === "offline"
      );
    case "secure":
      return host.secure === true;
    case "insecure":
      return host.secure === false || isInsecureWindowActive(host);
    case "unprovisioned":
      return host.authed === false;
    case "vip":
      return host.vip === true;
    case "roaming":
      return host.allow_roaming_ips === true;
    default:
      return true;
  }
}
