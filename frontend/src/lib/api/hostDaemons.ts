import {
  createQuery,
  createMutation,
  type QueryClient,
} from "@tanstack/svelte-query";
import { toStore } from "svelte/store";
import type { Engine } from "$lib/portal/types";
import { api } from "./client";
export interface DaemonSettings {
  enabled: boolean;
  resident_enabled?: boolean;
  lifetime_minutes?: number | null;
  expires_at?: string | null;
  username: string;
  default_cwd: string;
  max_parallel: number;
  idle_minutes: number;
  question_minutes: number;
}
export interface RemoteSession {
  id: string;
  title: string;
  engine: Engine;
  createdAt?: string;
  lastActivityAt?: string;
  cwd: string;
  status: string;
  sessionId: string | null;
  addressId: string | null;
  /** `plan` while the session awaits plan approval; null runs with the host posture. */
  permissionMode?: "plan" | null;
  operations?: {
    id: string;
    status: string;
    createdAt?: string;
    result: { reply?: string; error?: string } | null;
  }[];
}
export interface DaemonHost extends DaemonSettings {
  residence?: { requested: boolean; runtime_enabled: boolean };
  spawn?: { sourceHostId: number; operationId: string } | null;
  deadline_expired?: boolean;
  host_id: number;
  fqdn?: string;
  access?: { allowed: boolean; reason: string | null; secure: boolean; enabled_until: string | null };
  health: {
    presence_source?: "connection";
    state: "disabled" | "green" | "yellow" | "red";
    reasons: string[];
    heartbeat_at: string | null;
    evaluated_at: string;
    used_slots: number;
    max_slots: number;
  };
  engines?: Engine[];
  /** 1 when the host daemon (cxx 0.9.146+) can run Claude/Grok turns in plan mode. */
  permission_mode_version?: number;
  sessions: RemoteSession[];
}
export const daemonDefaults: DaemonSettings = {
  enabled: false,
  resident_enabled: false,
  username: "root",
  default_cwd: "",
  max_parallel: 8,
  idle_minutes: 60,
  question_minutes: 1440,
};
export function hostDaemonsQuery(enabled: () => boolean = () => true) {
  return createQuery(toStore(() => ({
    enabled: enabled(),
    queryKey: ["host-daemons"],
    queryFn: () => api.get<{ hosts: DaemonHost[] }>("/admin/host-daemons"),

  })));
}
export function hostDaemonQuery(id: string | number) {
  return createQuery({
    queryKey: ["host-daemons", String(id)],
    queryFn: () => api.get<DaemonHost>(`/admin/hosts/${id}/daemon`),

  });
}
export function configureDaemon(qc: QueryClient, id: string | number) {
  return createMutation({
    mutationFn: (settings: DaemonSettings) =>
      api.put(`/admin/hosts/${id}/daemon`, settings),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["host-daemons"] }),
  });
}
