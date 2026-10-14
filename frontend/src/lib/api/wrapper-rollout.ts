import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
import { api } from "./client";

/** Staged cxx rollout (api/src/services/wrapper-rollout.ts). */

export type RolloutStatus = "active" | "halted" | "complete" | "cancelled";
export type RolloutAction = "halt" | "resume" | "promote" | "complete";

export interface WrapperRollout {
  id: string;
  target_version: string;
  from_version: string;
  stage_index: number;
  stage: string;
  next_stage: string | null;
  stage_started_at: string;
  soak_minutes: number;
  soak_ends_at: string | null;
  status: RolloutStatus;
  halted_reason: string | null;
  admitted_host_ids: number[];
  stage_host_ids?: number[];
  confirmed_host_ids: number[];
  started_at: string;
  history: Array<{ at: string; event: string; by: string; detail?: string }>;
}

export interface WrapperRolloutStatus {
  enabled: boolean;
  settings: { stages: string[]; soak_minutes: number };
  rollout: WrapperRollout | null;
  hosts: Array<{ id: number; canary: boolean; excluded: boolean; running: string | null; admitted: boolean }>;
}

export const wrapperRolloutQueryKey = ["wrapper-rollout"] as const;

export function wrapperRolloutQuery() {
  return createQuery<WrapperRolloutStatus>({
    queryKey: wrapperRolloutQueryKey,
    queryFn: () => api.get<WrapperRolloutStatus>("/admin/wrapper/rollout"),
  });
}

export function wrapperRolloutActionMutation() {
  const qc = useQueryClient();
  return createMutation<WrapperRolloutStatus, Error, { action: RolloutAction; reason?: string }>({
    mutationFn: ({ action, reason }) =>
      api.post<WrapperRolloutStatus>(`/admin/wrapper/rollout/${action}`, reason ? { reason } : {}),
    onSuccess: (data) => qc.setQueryData(wrapperRolloutQueryKey, data),
  });
}

export function wrapperCanaryMutation() {
  const qc = useQueryClient();
  return createMutation<{ id: number; wrapper_canary: boolean }, Error, { hostId: number; enabled: boolean }>({
    mutationFn: ({ hostId, enabled }) =>
      api.post(`/admin/hosts/${hostId}/wrapper-canary`, { enabled }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: wrapperRolloutQueryKey });
      void qc.invalidateQueries({ queryKey: ["hosts"] });
    },
  });
}

function versionParts(value: string): number[] | null {
  const m = value.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * The cxx version a host should be on according to the last recorded rollout,
 * or null when there is none to compare against. Mirrors the server gate: a
 * live rollout holds unadmitted hosts at `from_version`.
 */
export function hostWrapperTarget(status: WrapperRolloutStatus | undefined, hostId: number): string | null {
  const rollout = status?.rollout;
  if (!status?.enabled || !rollout || rollout.status === "cancelled") return null;
  const live = rollout.status === "active" || rollout.status === "halted";
  return live && !rollout.admitted_host_ids.includes(hostId) ? rollout.from_version : rollout.target_version;
}

/** True when `version` is a release older than `target`. Unparseable versions are never "behind". */
export function isWrapperBehind(version: string | null | undefined, target: string | null): boolean {
  if (!version || !target) return false;
  const a = versionParts(version);
  const b = versionParts(target);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}
