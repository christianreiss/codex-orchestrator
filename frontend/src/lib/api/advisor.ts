import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
import type { Engine } from "$lib/portal/types";
import { api } from "./client";

export interface AdvisorSettings {
  enabled: boolean;
  host_id: number | null;
  engine: Engine;
}
export interface AdvisorAvailability extends AdvisorSettings {
  reason: string;
}
export interface AdvisorSessionView {
  advisor_session_id: string;
  kind: string;
  status: string;
  busy: boolean;
  turns: number;
  caller: string;
  verdict: { verdict: string; tier?: number; summary: string } | null;
  close_reason: string | null;
  created_at: string;
}
export interface AdvisorState {
  settings: AdvisorSettings;
  availability: AdvisorAvailability;
  advisors: AdvisorSessionView[];
}

export function advisorQuery() {
  return createQuery({
    queryKey: ["advisor"],
    queryFn: () => api.get<AdvisorState>("/admin/advisor"),
    refetchInterval: 30_000,
  });
}

export function advisorMutation() {
  const client = useQueryClient();
  return createMutation({
    mutationFn: (settings: AdvisorSettings) => api.put<AdvisorSettings>("/admin/advisor", settings),
    onSettled: () => void client.invalidateQueries({ queryKey: ["advisor"] }),
  });
}
