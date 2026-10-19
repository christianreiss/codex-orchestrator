/**
 * Agent roles — /admin/roles/*. Operator steering only: agents improve roles
 * through the proposal pipeline; the console sets policy, edits operator
 * drafts, reverts, withdraws and decides held proposals.
 */
import { api } from "./client";

export type RolePolicy = {
  mutation: "autonomous" | "supervised" | "frozen";
  protected_paths: string[];
  daily_budget: number;
  holder_upgrade: "at_task_boundary" | "manual";
  verdict_binding: boolean;
};

export type RoleListRow = {
  slug: string;
  display_name: string;
  summary: string;
  status: "active" | "retired";
  current_version: number | null;
  policy: RolePolicy;
  holders: number;
  open_proposals: number;
  held_proposals: number;
  updated_at: string;
};

export type RoleVersion = {
  id: string;
  version: number | null;
  state: "draft" | "published" | "withdrawn";
  sha256: string;
  changelog: string | null;
  published_at: string | null;
  withdrawn_at: string | null;
  source_proposal_id: string | null;
  reverted_from_version: number | null;
  created_by: Record<string, unknown>;
  published_by: Record<string, unknown> | null;
  uri: string | null;
};

export type RoleFile = {
  path: string;
  mime_type: string;
  load: "core" | "on_demand";
  description: string | null;
  size_bytes: number;
  sha256: string;
  introduced_in_version: number | null;
  source_proposal_id: string | null;
  uri: string;
  text?: string | null;
};

export type RoleDetail = {
  role: { slug: string; display_name: string; summary: string; status: "active" | "retired"; policy: RolePolicy; version: number; current_version_id: string | null };
  versions: RoleVersion[];
  draft: (RoleVersion & { manifest: string; files: RoleFile[] }) | null;
  holders: Array<{ address_id: string; version_id: string; activated_at: string; activated_by: Record<string, unknown>; reason: string }>;
};

export type RoleProposal = {
  id: string;
  role: string;
  kind: string;
  risk: "additive" | "modifying" | "core" | "revert";
  title: string;
  rationale: string;
  evidence: unknown[];
  status: "checking" | "in_review" | "held" | "applied" | "rejected" | "withdrawn" | "superseded";
  version: number;
  author: { address_id?: string; engine?: string; host_id?: number; role_version?: number };
  ops: Array<{ op: "put" | "delete"; path: string; size_bytes?: number; load?: string; revert_to_version?: number }>;
  gate_results: { passed: boolean; checks: Array<{ gate: string; ok: boolean; detail?: string }>; note?: string } | null;
  judge: { verdict: string; reason: string; model: string; strict?: boolean } | null;
  reviews: Array<{ reviewer_address_id: string; engine: string; verdict: string; reason: string; at: string }>;
  decision_note: string | null;
  result_version_id: string | null;
  created_at: string;
  updated_at: string;
};

export type RoleProposalDetail = {
  proposal: RoleProposal;
  current: Array<{ path: string; text: string | null }>;
  proposed: Array<{ path: string; text: string | null; binary: boolean }>;
  events: Array<{ seq: number; action: string; actor: Record<string, unknown>; detail: Record<string, unknown>; at: string }>;
};

export type DraftFileInput = { path: string; content?: string; encoding?: "utf8" | "base64"; blob_sha256?: string; mime_type?: string; load: "core" | "on_demand"; description?: string | null };

export const rolesKeys = {
  all: ["roles"] as const,
  list: () => ["roles", "list"] as const,
  detail: (slug: string) => ["roles", "detail", slug] as const,
  timeline: (slug: string) => ["roles", "timeline", slug] as const,
  version: (slug: string, version: number) => ["roles", "version", slug, version] as const,
  proposal: (id: string) => ["roles", "proposal", id] as const,
};

export const rolesApi = {
  state: () => api.get<{ enabled: boolean }>("/admin/roles/state"),
  setState: (enabled: boolean) => api.post<{ enabled: boolean }>("/admin/roles/state", { enabled }),
  list: () => api.get<{ enabled: boolean; roles: RoleListRow[] }>("/admin/roles"),
  create: (input: { slug: string; display_name: string; summary: string }) => api.post<RoleDetail>("/admin/roles", input),
  get: (slug: string) => api.get<RoleDetail>(`/admin/roles/${encodeURIComponent(slug)}`),
  update: (slug: string, input: Partial<{ display_name: string; summary: string; status: "active" | "retired"; policy: Partial<RolePolicy> }> & { expected_version: number }) =>
    api.patch<RoleDetail>(`/admin/roles/${encodeURIComponent(slug)}`, input),
  timeline: (slug: string) => api.get<{ role: string; versions: RoleVersion[]; proposals: RoleProposal[] }>(`/admin/roles/${encodeURIComponent(slug)}/timeline`),
  version: (slug: string, version: number) => api.get<RoleVersion & { manifest: string; files: RoleFile[] }>(`/admin/roles/${encodeURIComponent(slug)}/versions/${version}`),
  saveDraft: (slug: string, input: { manifest: string; files: DraftFileInput[]; changelog?: string | null }) => api.put<RoleDetail>(`/admin/roles/${encodeURIComponent(slug)}/draft`, input),
  discardDraft: (slug: string) => api.delete<RoleDetail>(`/admin/roles/${encodeURIComponent(slug)}/draft`),
  publish: (slug: string, changelog?: string) => api.post<RoleDetail>(`/admin/roles/${encodeURIComponent(slug)}/publish`, changelog ? { changelog } : {}),
  revert: (slug: string, version: number, reason: string) => api.post<RoleDetail>(`/admin/roles/${encodeURIComponent(slug)}/revert`, { version, reason }),
  withdraw: (slug: string, version: number, reason: string) => api.post<RoleDetail>(`/admin/roles/${encodeURIComponent(slug)}/versions/${version}/withdraw`, { reason }),
  proposal: (id: string) => api.get<RoleProposalDetail>(`/admin/roles/proposals/${id}`),
  decide: (id: string, input: { verdict: "accept" | "reject"; reason: string; expected_version: number }) =>
    api.post<Record<string, unknown>>(`/admin/roles/proposals/${id}/decide`, input),
};
