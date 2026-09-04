/**
 * Insecure-windows + approvals API surface.
 *
 * The "insecure" feature has three moving parts:
 *   - per-host insecure windows (open via /admin/hosts/{id}/insecure/{enable,disable})
 *   - pending operator approvals at /admin/insecure-approvals/pending
 *   - domain allow-lists at /admin/insecure-domain-allows/{id}/revoke
 * Plus the bulk extend / disable-all under /admin/hosts/insecure/*, and the
 * fleet-wide window at /admin/hosts/insecure/window{,/close} — one deadline
 * that auto-allows every insecure host, and whose close shuts all of them.
 */
import {
  createQuery,
  createMutation,
  type QueryClient,
} from "@tanstack/svelte-query";
import { api, ApiError } from "./client";
import type {
  InsecureSummaryResponse,
  InsecureApprovalsResponse,
} from "./types";

export const insecureKeys = {
  summary: () => ["hosts", "insecure"] as const,
  approvals: () => ["insecure-approvals"] as const,
};

// --- queries --------------------------------------------------------------

export function insecureSummaryQuery() {
  return createQuery<InsecureSummaryResponse>({
    queryKey: insecureKeys.summary(),
    queryFn: () => api.get<InsecureSummaryResponse>("/admin/hosts/insecure"),
    refetchInterval: 15_000,
  });
}

export function insecureApprovalsQuery() {
  return createQuery<InsecureApprovalsResponse>({
    queryKey: insecureKeys.approvals(),
    queryFn: () =>
      api.get<InsecureApprovalsResponse>("/admin/insecure-approvals/pending"),
    refetchInterval: 30_000,
  });
}

// --- mutations ------------------------------------------------------------

export function createEnableInsecureMutation(qc: QueryClient) {
  return createMutation<unknown, ApiError, { id: number | string; duration_minutes?: number }>({
    mutationFn: ({ id, duration_minutes }) =>
      api.post(`/admin/hosts/${id}/insecure/enable`, {
        duration_minutes: duration_minutes ?? undefined,
      }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ["hosts"] });
      void qc.invalidateQueries({ queryKey: insecureKeys.summary() });
      void qc.invalidateQueries({ queryKey: ["hosts", "detail", String(vars.id)] });
    },
  });
}

export function createDisableInsecureMutation(qc: QueryClient) {
  return createMutation<unknown, ApiError, { id: number | string }>({
    mutationFn: ({ id }) => api.post(`/admin/hosts/${id}/insecure/disable`),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ["hosts"] });
      void qc.invalidateQueries({ queryKey: insecureKeys.summary() });
      void qc.invalidateQueries({ queryKey: ["hosts", "detail", String(vars.id)] });
    },
  });
}

export function createExtendAllInsecureMutation(qc: QueryClient) {
  return createMutation<{ extended?: number } | unknown, ApiError, void>({
    mutationFn: () => api.post("/admin/hosts/insecure/extend"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["hosts"] });
      void qc.invalidateQueries({ queryKey: insecureKeys.summary() });
    },
  });
}

export function createDisableAllInsecureMutation(qc: QueryClient) {
  return createMutation<unknown, ApiError, void>({
    mutationFn: () => api.post("/admin/hosts/insecure/disable-all"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["hosts"] });
      void qc.invalidateQueries({ queryKey: insecureKeys.summary() });
    },
  });
}

export function createOpenFleetWindowMutation(qc: QueryClient) {
  return createMutation<unknown, ApiError, { duration_minutes?: number }>({
    mutationFn: ({ duration_minutes }) =>
      api.post("/admin/hosts/insecure/window", {
        duration_minutes: duration_minutes ?? undefined,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["hosts"] });
      void qc.invalidateQueries({ queryKey: insecureKeys.summary() });
      void qc.invalidateQueries({ queryKey: insecureKeys.approvals() });
    },
  });
}

export function createCloseFleetWindowMutation(qc: QueryClient) {
  return createMutation<unknown, ApiError, void>({
    mutationFn: () => api.post("/admin/hosts/insecure/window/close"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["hosts"] });
      void qc.invalidateQueries({ queryKey: insecureKeys.summary() });
      void qc.invalidateQueries({ queryKey: insecureKeys.approvals() });
    },
  });
}

export function createApproveInsecureMutation(qc: QueryClient) {
  return createMutation<unknown, ApiError, { id: number | string; duration_minutes?: number }>({
    mutationFn: ({ id, duration_minutes }) =>
      api.post(`/admin/insecure-approvals/${id}/approve`, {
        duration_minutes: duration_minutes ?? undefined,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: insecureKeys.approvals() });
      void qc.invalidateQueries({ queryKey: insecureKeys.summary() });
      void qc.invalidateQueries({ queryKey: ["hosts"] });
    },
  });
}

export function createDenyInsecureMutation(qc: QueryClient) {
  return createMutation<unknown, ApiError, { id: number | string }>({
    mutationFn: ({ id }) => api.post(`/admin/insecure-approvals/${id}/deny`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: insecureKeys.approvals() });
    },
  });
}

export function createAllowDomainMutation(qc: QueryClient) {
  return createMutation<
    unknown,
    ApiError,
    { id: number | string; domain?: string; duration_minutes?: number }
  >({
    mutationFn: ({ id, domain, duration_minutes }) =>
      api.post(`/admin/insecure-approvals/${id}/allow-domain`, {
        domain,
        duration_minutes,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: insecureKeys.approvals() });
      void qc.invalidateQueries({ queryKey: insecureKeys.summary() });
    },
  });
}

export function createRevokeDomainMutation(qc: QueryClient) {
  return createMutation<unknown, ApiError, { id: number | string }>({
    mutationFn: ({ id }) =>
      api.post(`/admin/insecure-domain-allows/${id}/revoke`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: insecureKeys.summary() });
    },
  });
}
