import { api } from "./client";
export interface WorkflowDocument {
  schema_version: 1; title: string; summary: string;
  goal: { statement: string; success_criteria: { id: string; text: string }[] };
  inputs: { key: string; label: string; type: "string" | "number" | "boolean" | "enum"; required: boolean; default?: string | number | boolean; options?: string[]; description?: string }[];
  tasks: { id: string; title: string; instructions: string; acceptance_criteria: string[]; depends_on: string[]; knowledge_ids: string[]; execution_hint?: string }[];
  knowledge: { id: string; title: string; inline?: string; reference?: { uri: string; read_hint?: string } }[];
}
export interface WorkflowSummary { workflow_id: string; slug: string; status: "active" | "archived"; version: number; control_version: number; title: string; summary: string; goal: WorkflowDocument["goal"]; updated_at: string }
export interface WorkflowVersion { version: number; sha256: string; document: WorkflowDocument; reason: string; diff?: unknown; source_run_id?: string | null; created_at: string }
export interface WorkflowDefinition extends WorkflowVersion { enabled: boolean; workflow_id: string; slug: string; status: "active" | "archived"; control_version: number; updated_at: string }
export interface WorkflowMember { address_id: string; agent_address?: string; name?: string; display_name?: string; engine?: string; host_id?: number; fqdn?: string; status: string; joined_at?: string; session_id?: string; binding_generation?: number }
export interface WorkflowInvitation { invitation_id?: string; id?: string; target_address_id?: string; name?: string; status: string; reason?: string; expires_at?: string }
export interface WorkflowTask { task_id: string; title: string; status: string; version: number; attempt_no: number; claim: { owner_address_id: string; generation: number; lease_until: string; recovery: boolean } | null; summary?: string; outputs?: Record<string, unknown>; evidence?: WorkflowEvidence[]; depends_on?: string[]; reason?: string; skip_reason?: string }
export interface WorkflowEvidence { id: string; description: string; type?: string; uri?: string; hash?: string; execution_host?: string; time?: string; expires_at?: string }
export interface WorkflowAttempt { attempt_no: number; status: string; started_at?: string; ended_at?: string; execution_host?: string; summary?: string; outputs?: Record<string, unknown>; evidence?: WorkflowEvidence[]; error?: unknown }
export interface WorkflowEvaluation { version: number; status: string; draft?: Record<string, unknown>; decision?: string; reason?: string; findings?: unknown; lessons?: unknown; applied_version?: number; diff?: unknown }
export interface WorkflowQuestion { id: string; question: string; answer?: string }
export interface WorkflowPreparation {
  phase: "clarifying" | "awaiting_confirmation" | "ready";
  revision: number;
  notes: string;
  questions: WorkflowQuestion[];
  summary: { revision: number; title: string; goal: string; inputs: Record<string, unknown>;
    questions: WorkflowQuestion[]; tasks: { id: string; title: string; instructions: string; acceptance_criteria: string[] }[]; notes: string } | null;
  confirmation: { summary_revision: number; actor: Record<string, unknown>; time: string;
    channel: "web" | "conversation"; user_confirmation: string } | null;
}
export interface WorkflowRun {
  server_time?: string; enabled: boolean; run_id: string; workflow_id: string; workflow_slug?: string; workflow_version: number; version: number;
  next_cursor?: string | number | null; status: "pending" | "running" | "paused" | "blocked" | "evaluating" | "completed"; outcome: string | null;
  title: string; inputs: Record<string, unknown>; coordinator: { address_id: string; generation: number; lease_until: string } | null;
  report_url: string; communication: { group_id: string; room_id: string; group_topic: string; communication_url: string } | null;
  members: WorkflowMember[]; invitations: WorkflowInvitation[]; tasks: WorkflowTask[]; evaluation: WorkflowEvaluation | null;
  summary?: string; criteria?: { id: string; status: string; reason?: string; evidence_ids?: string[] }[]; open_items?: unknown[];
  created_at: string; updated_at: string; started_at?: string | null; finished_at?: string | null; completed_at?: string | null;
  preparation?: WorkflowPreparation | null;
  document?: WorkflowDocument; report?: Record<string, unknown> | null; results?: Record<string, unknown>; cancel_requested?: boolean;
}
export interface WorkflowEvent { id: string; sequence: number; type: string; actor: unknown; detail: unknown; created_at: string }
export interface WorkflowPage<T> { enabled?: boolean; items: T[]; next_cursor: string | number | null }
export const workflowKeys = {
  all: ["workflows"] as const, state: ["workflows", "state"] as const,
  list: (filter: Record<string, unknown>) => ["workflows", "list", filter] as const,
  definition: (id: string, version?: number) => ["workflows", "definition", id, version ?? "latest"] as const,
  versions: (id: string) => ["workflows", "versions", id] as const,
};
export const workflowRunKeys = {
  all: ["workflow-runs"] as const,
  list: (filter: Record<string, unknown>) => ["workflow-runs", "list", filter] as const,
  tasks: (id: string) => ["workflow-runs", id, "tasks"] as const,
  report: (id: string) => ["workflow-runs", id, "report"] as const,
  events: (id: string) => ["workflow-runs", id, "events"] as const,
  task: (id: string, task: string) => ["workflow-runs", id, "task", task] as const,
};
const definitions = "/admin/workflow-definitions";
const runs = "/admin/workflow-runs";
function query(filters: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  return params.size ? `?${params}` : "";
}
export const workflowsApi = {
  state: () => api.get<{ enabled: boolean; messaging_enabled?: boolean; unavailable_reason?: string | null }>(`${definitions}/state`),
  setState: (enabled: boolean, client_request_id: string) => api.post<{ enabled: boolean }>(`${definitions}/state`, { enabled, client_request_id }),
  list: (filter: Record<string, unknown>, signal?: AbortSignal) => api.get<WorkflowPage<WorkflowSummary>>(`${definitions}${query(filter)}`, { signal }),
  get: (id: string, version?: number) => api.get<WorkflowDefinition>(`${definitions}/${encodeURIComponent(id)}${version ? `/versions/${version}` : ""}`),
  versions: (id: string, cursor?: string) => api.get<WorkflowPage<WorkflowVersion>>(`${definitions}/${encodeURIComponent(id)}/versions${query({ cursor })}`),
  create: (input: { client_request_id: string; slug: string; document: WorkflowDocument; reason: string }) => api.post<WorkflowDefinition>(definitions, input),
  revise: (id: string, input: { client_request_id: string; expected_workflow_version: number; document: WorkflowDocument; reason: string }) => api.post<WorkflowDefinition>(`${definitions}/${encodeURIComponent(id)}/revise`, input),
  archive: (id: string, input: { client_request_id: string; expected_workflow_version: number; expected_control_version: number; reason: string }, restore = false) => api.post<WorkflowDefinition>(`${definitions}/${encodeURIComponent(id)}/${restore ? "restore" : "archive"}`, input),
  revert: (id: string, input: { client_request_id: string; expected_workflow_version: number; version: number; reason: string }) => api.post<WorkflowDefinition>(`${definitions}/${encodeURIComponent(id)}/revert`, input),
  runList: (filter: Record<string, unknown>, signal?: AbortSignal) => api.get<WorkflowPage<WorkflowRun>>(`${runs}${query(filter)}`, { signal }),
  prepare: (input: { client_request_id: string; workflow_id: string; version: number | "latest"; title: string; inputs: Record<string, unknown> }) => api.post<WorkflowRun>(runs, input),
  runGet: (id: string, cursor?: string) => api.get<WorkflowRun>(`${runs}/${encodeURIComponent(id)}${query({ cursor })}`),
  report: (id: string) => api.get<WorkflowRun>(`${runs}/${encodeURIComponent(id)}/report`),
  events: (id: string, cursor?: string) => api.get<WorkflowPage<WorkflowEvent>>(`${runs}/${encodeURIComponent(id)}/events${query({ cursor })}`),
  task: (id: string, task: string, cursor?: string) => api.get<{ task: WorkflowTask; attempts: WorkflowAttempt[]; next_cursor: string | number | null }>(`${runs}/${encodeURIComponent(id)}/tasks/${encodeURIComponent(task)}${query({ cursor })}`),
  control: (id: string, input: { client_request_id: string; expected_run_version: number; action: string; reason?: string; title?: string; inputs?: Record<string, unknown>; questions?: WorkflowQuestion[]; notes?: string; summary_revision?: number; target_address_id?: string }) => api.post<WorkflowRun>(`${runs}/${encodeURIComponent(id)}/control`, input),
  cancelPrepared: (id: string, input: { client_request_id: string; expected_run_version: number; reason: string }) => api.post<WorkflowRun>(`${runs}/${encodeURIComponent(id)}/prepare-cancel`, input),
};
