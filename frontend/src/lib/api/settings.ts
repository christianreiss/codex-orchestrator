/**
 * Settings — svelte-query query/mutation builders.
 *
 * One read/write pair per setting. Each mutation invalidates the
 * matching ['settings', '<slug>'] query so the form re-reads the
 * authoritative server state. The WS `settings.changed` event also
 * invalidates ['settings'] hierarchically (see lib/ws/events.ts),
 * so cross-tab edits stay in sync.
 */
import {
  createMutation,
  createQuery,
  useQueryClient,
  type CreateMutationOptions,
} from "@tanstack/svelte-query";
import { api } from "./client";
import type {
  ApiStateValue,
  ApiKeysInChatValue,
  AutoUpdateValue,
  CdxSilentValue,
  ClaudeSettingsValue,
  ClaudeVersionLockValue,
  CodexVersionLockValue,
  CodexVersionsCheckResult,
  InsecureApprovalValue,
  LogRetentionValue,
  ModelDefaultsEngine,
  ModelDefaultsUpdate,
  ModelDefaultsValue,
  PrunePolicyValue,
  QuotaModeValue,
  ReverseDnsValue,
  ScalingStatus,
} from "./types";
import { claudeSettingsKeys } from "./claudeSettings";

/* ─────────────────────────────── helpers ─────────────────────────────── */

type MutationOpts<T, V> = Omit<CreateMutationOptions<T, Error, V, unknown>, "mutationFn">;

function makeToggle<T>(path: string, key: "disabled" | "enabled" | "silent") {
  return (value: boolean) => api.post<T>(path, { [key]: value });
}

/* ────────────────────────── 1. API state ─────────────────────────── */

export const apiStateQueryKey = ["settings", "api-state"] as const;

export function apiStateQuery() {
  return createQuery<ApiStateValue>({
    queryKey: apiStateQueryKey,
    queryFn: () => api.get<ApiStateValue>("/admin/api/state"),
  });
}

export function apiStateMutation(opts: MutationOpts<ApiStateValue, boolean> = {}) {
  const qc = useQueryClient();
  return createMutation<ApiStateValue, Error, boolean>({
    mutationFn: makeToggle<ApiStateValue>("/admin/api/state", "disabled"),
    ...opts,
    onSettled: (...args) => {
      void qc.invalidateQueries({ queryKey: apiStateQueryKey });
      opts.onSettled?.(...args);
    },
  });
}

/* ────────────────────────── 2. OpenAI state ──────────────────────── */

export const openaiStateQueryKey = ["settings", "openai-state"] as const;

export function openaiStateQuery() {
  return createQuery<ApiStateValue>({
    queryKey: openaiStateQueryKey,
    queryFn: () => api.get<ApiStateValue>("/admin/openai/state"),
  });
}

export function openaiStateMutation(opts: MutationOpts<ApiStateValue, boolean> = {}) {
  const qc = useQueryClient();
  return createMutation<ApiStateValue, Error, boolean>({
    mutationFn: makeToggle<ApiStateValue>("/admin/openai/state", "disabled"),
    ...opts,
    onSettled: (...args) => {
      void qc.invalidateQueries({ queryKey: openaiStateQueryKey });
      opts.onSettled?.(...args);
    },
  });
}

/* ────────────────────────── 3. Claude state ──────────────────────── */

export const claudeStateQueryKey = ["settings", "claude-state"] as const;

export function claudeStateQuery() {
  return createQuery<ApiStateValue>({
    queryKey: claudeStateQueryKey,
    queryFn: () => api.get<ApiStateValue>("/admin/claude/state"),
  });
}

export function claudeStateMutation(opts: MutationOpts<ApiStateValue, boolean> = {}) {
  const qc = useQueryClient();
  return createMutation<ApiStateValue, Error, boolean>({
    mutationFn: makeToggle<ApiStateValue>("/admin/claude/state", "disabled"),
    ...opts,
    onSettled: (...args) => {
      void qc.invalidateQueries({ queryKey: claudeStateQueryKey });
      opts.onSettled?.(...args);
    },
  });
}

/* ────────────────────── 3a. Claude settings ──────────────────────── */

export const claudeSettingsQueryKey = ["settings", "claude-settings"] as const;

export function claudeSettingsQuery() {
  return createQuery<ClaudeSettingsValue>({
    queryKey: claudeSettingsQueryKey,
    queryFn: () => api.get<ClaudeSettingsValue>("/admin/claude/settings"),
  });
}

export function claudeSettingsMutation(
  opts: MutationOpts<ClaudeSettingsValue, Partial<ClaudeSettingsValue>> = {},
) {
  const qc = useQueryClient();
  return createMutation<ClaudeSettingsValue, Error, Partial<ClaudeSettingsValue>>({
    mutationFn: (payload) => api.post<ClaudeSettingsValue>("/admin/claude/settings", payload),
    ...opts,
    onSettled: (...args) => {
      void qc.invalidateQueries({ queryKey: claudeSettingsQueryKey });
      opts.onSettled?.(...args);
    },
  });
}

/* ─────────────────────── 3b. Fleet model defaults ─────────────────────── */

export const modelDefaultsQueryKey = (engine: ModelDefaultsEngine) =>
  ["settings", "model-defaults", engine] as const;

export function modelDefaultsQuery(engine: ModelDefaultsEngine) {
  return createQuery<ModelDefaultsValue>({
    queryKey: modelDefaultsQueryKey(engine),
    queryFn: () => api.get<ModelDefaultsValue>(`/admin/model-defaults/${engine}`),
  });
}

export function modelDefaultsMutation(
  engine: ModelDefaultsEngine,
  opts: MutationOpts<ModelDefaultsValue, ModelDefaultsUpdate> = {},
) {
  const qc = useQueryClient();
  return createMutation<ModelDefaultsValue, Error, ModelDefaultsUpdate>({
    mutationFn: (payload) =>
      api.post<ModelDefaultsValue>(`/admin/model-defaults/${engine}`, payload),
    ...opts,
    onSettled: (...args) => {
      void qc.invalidateQueries({ queryKey: modelDefaultsQueryKey(engine) });
      if (engine === "claude") {
        void qc.invalidateQueries({ queryKey: claudeSettingsKeys.config() });
      }
      opts.onSettled?.(...args);
    },
  });
}

/* ─────────────────── 3c. Claude version (engine) ─────────────────── */

// `/admin/versions/check` is a side-effecting POST that force-probes GitHub
// for BOTH engines' releases in a single call (bypassing the 1h settings
// cache), so the Claude and Codex "read" queries below share one query key
// and a long staleTime -- otherwise they'd each independently re-trigger the
// same forced upstream lookup on every stale remount. Explicit re-checks go
// through claudeVersionsCheckMutation / codexVersionsCheckMutation (mirrors
// overview.ts's versionsCheckMutation, which exposes this same endpoint as
// a mutation for the same reason).
export const versionsCheckQueryKey = ["settings", "versions-check"] as const;
export const claudeVersionsQueryKey = versionsCheckQueryKey;

export function claudeVersionsQuery() {
  return createQuery<CodexVersionsCheckResult>({
    queryKey: claudeVersionsQueryKey,
    queryFn: () => api.post<CodexVersionsCheckResult>("/admin/versions/check"),
    staleTime: Infinity,
  });
}

export function claudeVersionsCheckMutation(
  opts: MutationOpts<CodexVersionsCheckResult, void> = {},
) {
  const qc = useQueryClient();
  return createMutation<CodexVersionsCheckResult, Error, void>({
    mutationFn: () => api.post<CodexVersionsCheckResult>("/admin/versions/check"),
    ...opts,
    onSettled: (...args) => {
      void qc.invalidateQueries({ queryKey: claudeVersionsQueryKey });
      opts.onSettled?.(...args);
    },
  });
}

export function claudeVersionMutation(opts: MutationOpts<ClaudeVersionLockValue, string> = {}) {
  const qc = useQueryClient();
  return createMutation<ClaudeVersionLockValue, Error, string>({
    mutationFn: (selection) =>
      api.post<ClaudeVersionLockValue>("/admin/claude/version", { selection }),
    ...opts,
    onSettled: (...args) => {
      void qc.invalidateQueries({ queryKey: claudeVersionsQueryKey });
      opts.onSettled?.(...args);
    },
  });
}

/* ────────────────────────── 4. Reverse DNS ───────────────────────── */

export const reverseDnsQueryKey = ["settings", "reverse-dns"] as const;

export function reverseDnsQuery() {
  return createQuery<ReverseDnsValue>({
    queryKey: reverseDnsQueryKey,
    queryFn: () => api.get<ReverseDnsValue>("/admin/reverse-dns"),
  });
}

export function reverseDnsMutation(opts: MutationOpts<ReverseDnsValue, boolean> = {}) {
  const qc = useQueryClient();
  return createMutation<ReverseDnsValue, Error, boolean>({
    mutationFn: makeToggle<ReverseDnsValue>("/admin/reverse-dns", "enabled"),
    ...opts,
    onSettled: (...args) => {
      void qc.invalidateQueries({ queryKey: reverseDnsQueryKey });
      opts.onSettled?.(...args);
    },
  });
}

/* ────────────────────────── 5. Auto-update ───────────────────────── */

export const autoUpdateQueryKey = ["settings", "auto-update"] as const;

export function autoUpdateQuery() {
  return createQuery<AutoUpdateValue>({
    queryKey: autoUpdateQueryKey,
    queryFn: () => api.get<AutoUpdateValue>("/admin/auto-update"),
  });
}

export function autoUpdateMutation(opts: MutationOpts<AutoUpdateValue, boolean> = {}) {
  const qc = useQueryClient();
  return createMutation<AutoUpdateValue, Error, boolean>({
    mutationFn: makeToggle<AutoUpdateValue>("/admin/auto-update", "enabled"),
    ...opts,
    onSettled: (...args) => {
      void qc.invalidateQueries({ queryKey: autoUpdateQueryKey });
      opts.onSettled?.(...args);
    },
  });
}

/* ────────────────────── 6. Codex silent mode ─────────────────────── */

export const cdxSilentQueryKey = ["settings", "cdx-silent"] as const;

export function cdxSilentQuery() {
  return createQuery<CdxSilentValue>({
    queryKey: cdxSilentQueryKey,
    queryFn: () => api.get<CdxSilentValue>("/admin/cdx-silent"),
  });
}

export function cdxSilentMutation(opts: MutationOpts<CdxSilentValue, boolean> = {}) {
  const qc = useQueryClient();
  return createMutation<CdxSilentValue, Error, boolean>({
    mutationFn: makeToggle<CdxSilentValue>("/admin/cdx-silent", "silent"),
    ...opts,
    onSettled: (...args) => {
      void qc.invalidateQueries({ queryKey: cdxSilentQueryKey });
      opts.onSettled?.(...args);
    },
  });
}

/* ─────────────────── 6a. API keys supplied in chat ─────────────────── */

export const apiKeysInChatQueryKey = ["settings", "api-keys-in-chat"] as const;

export function apiKeysInChatQuery() {
  return createQuery<ApiKeysInChatValue>({
    queryKey: apiKeysInChatQueryKey,
    queryFn: () => api.get<ApiKeysInChatValue>("/admin/api-keys-in-chat"),
  });
}

export function apiKeysInChatMutation(
  opts: MutationOpts<ApiKeysInChatValue, boolean> = {},
) {
  const qc = useQueryClient();
  return createMutation<ApiKeysInChatValue, Error, boolean>({
    mutationFn: makeToggle<ApiKeysInChatValue>("/admin/api-keys-in-chat", "enabled"),
    ...opts,
    onSettled: (...args) => {
      void qc.invalidateQueries({ queryKey: apiKeysInChatQueryKey });
      opts.onSettled?.(...args);
    },
  });
}

/* ─────────────────── 7. Insecure approval policy ─────────────────── */

export const insecureApprovalQueryKey = ["settings", "insecure-approval"] as const;

export function insecureApprovalQuery() {
  return createQuery<InsecureApprovalValue>({
    queryKey: insecureApprovalQueryKey,
    queryFn: () => api.get<InsecureApprovalValue>("/admin/insecure-approval"),
  });
}

export function insecureApprovalMutation(
  opts: MutationOpts<InsecureApprovalValue, boolean> = {},
) {
  const qc = useQueryClient();
  return createMutation<InsecureApprovalValue, Error, boolean>({
    mutationFn: makeToggle<InsecureApprovalValue>("/admin/insecure-approval", "enabled"),
    ...opts,
    onSettled: (...args) => {
      void qc.invalidateQueries({ queryKey: insecureApprovalQueryKey });
      opts.onSettled?.(...args);
    },
  });
}

/* ───────────────────────── 8. Quota mode ─────────────────────────── */

export const quotaModeQueryKey = ["settings", "quota-mode"] as const;

export function quotaModeQuery() {
  return createQuery<QuotaModeValue>({
    queryKey: quotaModeQueryKey,
    queryFn: () => api.get<QuotaModeValue>("/admin/quota-mode"),
  });
}

export function quotaModeMutation(opts: MutationOpts<QuotaModeValue, Partial<QuotaModeValue>> = {}) {
  const qc = useQueryClient();
  return createMutation<QuotaModeValue, Error, Partial<QuotaModeValue>>({
    mutationFn: (payload) => api.post<QuotaModeValue>("/admin/quota-mode", payload),
    ...opts,
    onSettled: (...args) => {
      void qc.invalidateQueries({ queryKey: quotaModeQueryKey });
      opts.onSettled?.(...args);
    },
  });
}

/* ────────────────────────── 9. Codex version ─────────────────────── */

// Shares versionsCheckQueryKey with claudeVersionsQuery above -- see the
// comment there. Both engines' data comes back from the same forced POST,
// so registering it under one key (instead of two) means mounting the
// Claude section, Codex section, and OpenAI section together triggers a
// single upstream check, not three.
export const codexVersionsQueryKey = versionsCheckQueryKey;

export function codexVersionsQuery() {
  return createQuery<CodexVersionsCheckResult>({
    queryKey: codexVersionsQueryKey,
    queryFn: () => api.post<CodexVersionsCheckResult>("/admin/versions/check"),
    staleTime: Infinity,
  });
}

export function codexVersionsCheckMutation(
  opts: MutationOpts<CodexVersionsCheckResult, void> = {},
) {
  const qc = useQueryClient();
  return createMutation<CodexVersionsCheckResult, Error, void>({
    mutationFn: () => api.post<CodexVersionsCheckResult>("/admin/versions/check"),
    ...opts,
    onSettled: (...args) => {
      void qc.invalidateQueries({ queryKey: codexVersionsQueryKey });
      opts.onSettled?.(...args);
    },
  });
}

export function codexVersionMutation(opts: MutationOpts<CodexVersionLockValue, string> = {}) {
  const qc = useQueryClient();
  return createMutation<CodexVersionLockValue, Error, string>({
    mutationFn: (selection) =>
      api.post<CodexVersionLockValue>("/admin/codex-version", { selection }),
    ...opts,
    onSettled: (...args) => {
      void qc.invalidateQueries({ queryKey: codexVersionsQueryKey });
      opts.onSettled?.(...args);
    },
  });
}

/* ────────────────────────── 10. Scaling ──────────────────────────── */

export const scalingQueryKey = ["settings", "scaling"] as const;

export function scalingQuery() {
  return createQuery<ScalingStatus>({
    queryKey: scalingQueryKey,
    queryFn: () => api.get<ScalingStatus>("/admin/scaling"),
  });
}

export function scalingMutation(opts: MutationOpts<ScalingStatus, unknown> = {}) {
  const qc = useQueryClient();
  return createMutation<ScalingStatus, Error, unknown>({
    mutationFn: (payload) => api.post<ScalingStatus>("/admin/scaling", payload),
    ...opts,
    onSettled: (...args) => {
      void qc.invalidateQueries({ queryKey: scalingQueryKey });
      opts.onSettled?.(...args);
    },
  });
}

/* ─────────────────────── 11. Prune policy ────────────────────────── */
// No GET endpoint exists for prune policy; the only field is
// `inactivity_window_days`. The Settings page lets admins edit raw
// JSON for the payload. We read the current value from the codex
// versions snapshot when available.

export function prunePolicyMutation(
  opts: MutationOpts<PrunePolicyValue, { inactivity_days: number }> = {},
) {
  return createMutation<PrunePolicyValue, Error, { inactivity_days: number }>({
    mutationFn: (payload) => api.post<PrunePolicyValue>("/admin/prune-policy", payload),
    ...opts,
  });
}

/* ─────────────────────── 12. Log retention ───────────────────────── */

export const logRetentionQueryKey = ["settings", "log-retention"] as const;

export function logRetentionQuery() {
  return createQuery<LogRetentionValue>({
    queryKey: logRetentionQueryKey,
    queryFn: () => api.get<LogRetentionValue>("/admin/log-retention"),
  });
}

export function logRetentionMutation(
  opts: MutationOpts<LogRetentionValue, Partial<LogRetentionValue>> = {},
) {
  const qc = useQueryClient();
  return createMutation<LogRetentionValue, Error, Partial<LogRetentionValue>>({
    mutationFn: (payload) => api.post<LogRetentionValue>("/admin/log-retention", payload),
    ...opts,
    onSettled: (...args) => {
      void qc.invalidateQueries({ queryKey: logRetentionQueryKey });
      opts.onSettled?.(...args);
    },
  });
}
