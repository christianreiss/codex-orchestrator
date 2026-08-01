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
  type QueryKey,
} from "@tanstack/svelte-query";
import { api, ApiError } from "./client";
import type {
  HostsListResponse,
  HostDetailResponse,
  HostListItem,
  HostDetail,
  HostInstallerPayload,
  HostRegisterPayload,
  HostQuickRegisterPayload,
  HostRegisterResponse,
  HostInstallerResponse,
  HostEngine,
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

export function createReleaseIpBindingMutation(qc: QueryClient) {
  return createMutation<
    { host: HostDetail },
    ApiError,
    { id: number | string }
  >({
    mutationFn: ({ id }) =>
      api.post<{ host: HostDetail }>(`/admin/hosts/${id}/release-ip-binding`),
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
    { id: number | string } & HostInstallerPayload
  >({
    mutationFn: ({ id, engines, curl_insecure }) => {
      const payload: HostInstallerPayload = {};
      if (engines && engines.length) payload.engines = engines;
      if (typeof curl_insecure === "boolean") payload.curl_insecure = curl_insecure;
      return api.post<HostInstallerResponse>(
        `/admin/hosts/${id}/installer`,
        Object.keys(payload).length ? payload : undefined,
      );
    },
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: hostsKeys.detail(vars.id) });
      void qc.invalidateQueries({ queryKey: hostsKeys.list() });
    },
  });
}

export function createHostEnginesMutation(qc: QueryClient) {
  return createMutation<
    { host: HostDetail },
    ApiError,
    { id: number | string; engines: HostEngine[] },
    { previous?: HostDetailResponse }
  >({
    mutationFn: ({ id, engines }) =>
      api.post<{ host: HostDetail }>(`/admin/hosts/${id}/engines`, { engines }),
    onMutate: async ({ id, engines }) => {
      await qc.cancelQueries({ queryKey: hostsKeys.detail(id) });
      const previous = qc.getQueryData<HostDetailResponse>(
        hostsKeys.detail(id),
      );
      if (previous?.host) {
        qc.setQueryData<HostDetailResponse>(hostsKeys.detail(id), {
          ...previous,
          host: {
            ...previous.host,
            engines: engines.join(","),
            engines_list: engines,
          },
        });
      }
      return { previous };
    },
    onError: (_err, vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(hostsKeys.detail(vars.id), ctx.previous);
    },
    onSettled: (_d, _e, vars) => {
      void qc.invalidateQueries({ queryKey: hostsKeys.detail(vars.id) });
      void qc.invalidateQueries({ queryKey: hostsKeys.list() });
      void qc.invalidateQueries({ queryKey: ["agent-messaging"] });
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
  | "curl_insecure"
  | "browseros_mcp"
  | "agent_messaging"
  | "allow";

type ToggleEndpointPath =
  | "secure"
  | "vip"
  | "roaming"
  | "auto-update"
  | "scaling-exempt"
  | "curl-insecure"
  | "browseros-mcp"
  | "agent-messaging";

interface ToggleConfig {
  endpoint: ToggleEndpointPath;
  /** Field on HostDetail to flip in the cache. */
  detailField: keyof HostDetail;
  /** Body key sent to the backend. */
  bodyKey: BoolToggleField | "enabled";
  /** Other feature roots whose state changes with this host toggle. */
  extraInvalidations?: QueryKey[];
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
      for (const queryKey of cfg.extraInvalidations ?? []) {
        void qc.invalidateQueries({ queryKey });
      }
    },
  });
}

export function createSecureToggleMutation(qc: QueryClient) {
  return makeBoolToggle(qc, {
    endpoint: "secure",
    detailField: "secure",
    bodyKey: "secure",
    extraInvalidations: [["agent-messaging"]],
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
    bodyKey: "allow",
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
      api.post(`/admin/hosts/${id}/auto-update`, { override: value }),
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
    bodyKey: "allow",
  });
}

export function createBrowserOsMcpToggleMutation(qc: QueryClient) {
  return makeBoolToggle(qc, {
    endpoint: "browseros-mcp",
    detailField: "browseros_mcp_enabled",
    bodyKey: "browseros_mcp",
  });
}

export function createAgentMessagingToggleMutation(qc: QueryClient) {
  return makeBoolToggle(qc, {
    endpoint: "agent-messaging",
    detailField: "agent_messaging_enabled",
    bodyKey: "enabled",
    extraInvalidations: [["agent-messaging"]],
  });
}

/** An ineligible host may still turn messaging off; only a new enable is blocked. */
export function hostAgentMessagingToggleDisabled(
  host: Pick<HostDetail, "agent_messaging_enabled" | "secure" | "status">,
): boolean {
  return !host.agent_messaging_enabled && (!host.secure || host.status !== "active");
}

// --- version / model / reverse-dns / agents-version ----------------------

export function createReverseDnsMutation(qc: QueryClient) {
  return createMutation<
    unknown,
    ApiError,
    { id: number | string; mode: "global" | "enabled" | "disabled" }
  >({
    mutationFn: ({ id, mode }) =>
      api.post(`/admin/hosts/${id}/reverse-dns`, { mode }),
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
    mutationFn: ({ id, engine, model, reasoning_effort }) => {
      // Each key is only included when the caller actually means to touch
      // it, so a reasoning-effort-only save can't silently clear the model
      // override (and vice versa) — the backend treats an omitted key as
      // "leave alone" and an explicit `null` as "clear", so collapsing
      // `undefined` into a forced `null` here would corrupt that contract.
      const body =
        engine === "claude"
          ? { ...(model !== undefined ? { claude_model_override: model } : {}) }
          : {
              ...(model !== undefined ? { model_override: model } : {}),
              ...(reasoning_effort !== undefined ? { reasoning_effort_override: reasoning_effort } : {}),
            };
      return api.post(`/admin/hosts/${id}/model`, body);
    },
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
      api.post(`/admin/hosts/${id}/codex-version`, { selection: version }),
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
        selection: version,
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
        selection: document_id,
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

export interface HostCxxWrapperState {
  display: string;
  drift: boolean;
}

/** One shared cxx binary is reported through two legacy engine telemetry fields. */
export function hostCxxWrapperState(
  host: Pick<
    HostListItem,
    "engines_list" | "engines" | "wrapper_version" | "claude_wrapper_version"
  >,
): HostCxxWrapperState {
  const engines = new Set(hostEngines(host));
  const codexEnabled = engines.has("codex");
  const claudeEnabled = engines.has("claude");
  const codexVersion = codexEnabled ? host.wrapper_version : null;
  const claudeVersion = claudeEnabled ? host.claude_wrapper_version : null;
  const drift =
    codexEnabled &&
    claudeEnabled &&
    (codexVersion !== null || claudeVersion !== null) &&
    codexVersion !== claudeVersion;

  if (drift) {
    return {
      display: `Codex ${codexVersion ?? "—"} · Claude ${claudeVersion ?? "—"} (migration drift)`,
      drift: true,
    };
  }
  return { display: codexVersion ?? claudeVersion ?? "—", drift: false };
}

export const HOST_ONLINE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type HostStatusKind = "online" | "offline" | "auth-missing" | "auth-outdated";

function parseHostTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? null : ts;
}

export function hostLatestRefreshMs(
  host: Pick<HostListItem, "last_refresh" | "claude_last_refresh">,
): number | null {
  const times = [parseHostTime(host.last_refresh), parseHostTime(host.claude_last_refresh)].filter(
    (t): t is number => typeof t === "number",
  );
  return times.length ? Math.max(...times) : null;
}

export function hostLatestRefresh(
  host: Pick<HostListItem, "last_refresh" | "claude_last_refresh">,
): string | null {
  const codexTs = parseHostTime(host.last_refresh);
  const claudeTs = parseHostTime(host.claude_last_refresh);
  if (codexTs !== null && (claudeTs === null || codexTs >= claudeTs)) return host.last_refresh;
  if (claudeTs !== null) return host.claude_last_refresh;
  return null;
}

/**
 * Liveness timestamp: when the host last talked to the orchestrator.
 * `updated_at` is bumped on every auth sync and cron check-in — unlike
 * `last_refresh`, which carries the canonical payload's mint time and can be
 * days old even on a perfectly healthy host.
 */
export function hostLastSeenMs(
  host: Pick<HostListItem, "updated_at" | "last_refresh" | "claude_last_refresh">,
): number | null {
  const times = [
    parseHostTime(host.updated_at),
    parseHostTime(host.last_refresh),
    parseHostTime(host.claude_last_refresh),
  ].filter((t): t is number => typeof t === "number");
  return times.length ? Math.max(...times) : null;
}

export function hostHasRequiredAuth(
  host: Pick<HostListItem, "engines_list" | "engines" | "canonical_digest" | "claude_canonical_digest" | "authed">,
): boolean {
  if (host.authed === false) return false;
  const engines = hostEngines(host);
  const required = engines.length ? engines : ["codex"];
  return required.every((engine) => {
    if (engine === "claude") return Boolean(host.claude_canonical_digest);
    if (engine === "codex") return Boolean(host.canonical_digest);
    return true;
  });
}

export function hostStatusKind(host: HostListItem, nowMs = Date.now()): HostStatusKind {
  const raw = (host.status ?? "").toLowerCase();
  if (raw === "offline" || raw === "stale" || raw === "disabled") return "offline";
  if (!hostHasRequiredAuth(host)) return "auth-missing";
  if (host.auth_outdated === true) return "auth-outdated";
  const lastSeen = hostLastSeenMs(host);
  if (lastSeen !== null && nowMs - lastSeen <= HOST_ONLINE_WINDOW_MS) return "online";
  return "offline";
}

export function hostStatusLabel(host: HostListItem): string {
  const kind = hostStatusKind(host);
  if (kind === "online") return "Online";
  if (kind === "auth-missing") return "Auth missing";
  if (kind === "auth-outdated") return "Outdated auth";
  return "Offline";
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
      return hostStatusKind(host) === "online";
    case "offline":
      return hostStatusKind(host) === "offline";
    case "secure":
      return host.secure === true;
    case "insecure":
      return host.secure === false || isInsecureWindowActive(host);
    case "unprovisioned":
      return !hostHasRequiredAuth(host);
    case "vip":
      return host.vip === true;
    case "roaming":
      return host.allow_roaming_ips === true;
    default:
      return true;
  }
}
