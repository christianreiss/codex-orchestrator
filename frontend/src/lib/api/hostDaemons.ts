import {
  createQuery,
  createMutation,
  type QueryClient,
} from "@tanstack/svelte-query";
import { api } from "./client";
export interface DaemonSettings {
  enabled: boolean;
  username: string;
  default_cwd: string;
  max_parallel: number;
  idle_minutes: number;
  question_minutes: number;
}
export interface RemoteSession {
  id: string;
  title: string;
  engine: string;
  cwd: string;
  status: string;
  sessionId: string | null;
  addressId: string | null;
  operations?: {
    id: string;
    status: string;
    result: { reply?: string } | null;
  }[];
}
export interface DaemonHost extends DaemonSettings {
  host_id: number;
  fqdn?: string;
  health: {
    state: "disabled" | "green" | "yellow" | "red";
    reasons: string[];
    heartbeat_at: string | null;
    evaluated_at: string;
    used_slots: number;
    max_slots: number;
  };
  sessions: RemoteSession[];
}
export const daemonDefaults: DaemonSettings = {
  enabled: false,
  username: "root",
  default_cwd: "",
  max_parallel: 8,
  idle_minutes: 60,
  question_minutes: 1440,
};
export function hostDaemonsQuery() {
  return createQuery({
    queryKey: ["host-daemons"],
    queryFn: () => api.get<{ hosts: DaemonHost[] }>("/admin/host-daemons"),
    refetchInterval: 15_000,
  });
}
export function hostDaemonQuery(id: string | number) {
  return createQuery({
    queryKey: ["host-daemons", String(id)],
    queryFn: () => api.get<DaemonHost>(`/admin/hosts/${id}/daemon`),
    refetchInterval: 15_000,
  });
}
export function configureDaemon(qc: QueryClient, id: string | number) {
  return createMutation({
    mutationFn: (settings: DaemonSettings) =>
      api.put(`/admin/hosts/${id}/daemon`, settings),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["host-daemons"] }),
  });
}
