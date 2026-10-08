import {
  createQuery,
  createMutation,
  useQueryClient,
} from "@tanstack/svelte-query";
import { apiFetch } from "./client";
import { derived, type Readable } from "svelte/store";
export interface Schedule {
  id: string;
  name: string;
  target: string;
  prompt?: string;
  kind: "once" | "cron" | "interval";
  at: string | null;
  cron: string | null;
  interval_minutes: number | null;
  timezone: string;
  enabled: boolean;
  persistent: boolean;
  progress_timeout_seconds: number | null;
  version: number;
  next_due_at: string | null;
  created_by: string;
  updated_by: string;
}
export interface ScheduleRun {
  id: string;
  due_at: string;
  status: string;
  recovery_count: number;
  last_error: string | null;
  next_attempt_at: string;
}
export interface ScheduleDetail {
  schedule: Schedule;
  runs: ScheduleRun[];
}
export const scheduleKeys = { all: ["schedules"] as const };
export function schedulesQuery(after: Readable<string | undefined>) {
  return createQuery(
    derived(after, (value) => ({
      queryKey: [...scheduleKeys.all, "list", value],
      queryFn: () =>
        apiFetch<{ schedules: Schedule[]; next_cursor: string | null }>(
          "/admin/schedules" + (value ? "?after=" + value : ""),
        ),
    })),
  );
}
export function scheduleQuery(id: Readable<string>) {
  return createQuery(
    derived(id, (value) => ({
      queryKey: [...scheduleKeys.all, "detail", value],
      enabled: !!value,
      queryFn: () => apiFetch<ScheduleDetail>("/admin/schedules/" + value),
    })),
  );
}
export function scheduleMutation(
  onSuccess: () => void,
  onError: (error: Error) => void,
) {
  const client = useQueryClient();
  return createMutation<
    unknown,
    Error,
    { method: "POST" | "PATCH" | "DELETE"; id?: string; body: unknown }
  >({
    mutationFn: ({ method, id, body }) =>
      apiFetch("/admin/schedules" + (id ? "/" + id : ""), { method, body }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: scheduleKeys.all });
      onSuccess();
    },
    onError,
  });
}
