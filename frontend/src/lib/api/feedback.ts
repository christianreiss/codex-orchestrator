import { api } from './client';

export const feedbackTypes = ['bug', 'feature', 'feedback'] as const;
export const feedbackStatuses = ['open', 'in_progress', 'blocked', 'resolved', 'dismissed', 'duplicate'] as const;
export const feedbackPriorities = ['low', 'normal', 'high', 'critical'] as const;
export type FeedbackType = typeof feedbackTypes[number];
export type FeedbackStatus = typeof feedbackStatuses[number];
export type FeedbackPriority = typeof feedbackPriorities[number];
export interface FeedbackConfiguration {
  mode: 'source_developer' | 'user'; auto_publish: boolean; runner_enabled: boolean;
  engine: 'codex' | 'claude' | 'grok' | null; model: string | null;
  revision: string; token_configured: boolean; repository: string;
}
export interface FeedbackProbe { endpoint: 'health' | 'versions'; pointer: string; equals: string | number | boolean | null }
export interface FeedbackPipeline {
  version_state: 'unknown' | 'old_version' | 'recent';
  review_state: 'pending' | 'needs_retest' | 'new' | 'known' | 'fixed' | 'discarded' | 'unclear';
  delivery_state: 'local' | 'pending' | 'sent' | 'uncertain' | 'failed';
  created_commit: string | null; tested_commit: string | null; upstream_commit: string | null;
  github_url: string | null; github_issue_number: number | null; reason: string | null;
  checked_at: string | null; next_attempt_at: string | null; updated_at: string;
  evidence_urls: string[]; probe: FeedbackProbe | null;
  baseline: { passed: boolean; at: string; commit: string | null } | null;
  retest: { passed: boolean; at: string; commit: string | null } | null;
}
export interface FeedbackItem {
  id: string; type: FeedbackType; title: string; component: string;
  priority: FeedbackPriority; status: FeedbackStatus; version: number;
  report?: Record<string, unknown>; source: Record<string, unknown>; pipeline?: FeedbackPipeline;
  result?: { resolution?: string; fix_ref?: string; verification?: string; reason?: string } | null;
  deployment: 'unknown' | 'not_deployed' | 'deployed'; deployment_ref: string | null;
  duplicate_of: string | null; claim_owner: Record<string, unknown> | null;
  claim_expires_at: string | null; created_at: string; updated_at: string;
}
export interface FeedbackEvent {
  id: string; version: number; action: string; actor: Record<string, unknown>;
  detail: Record<string, unknown>; created_at: string;
}
export interface FeedbackFilters {
  version_state?: string; review_state?: string; delivery_state?: string;
  status?: string; type?: string; component?: string; priority?: string;
  query?: string; offset?: number; limit?: number;
}
export interface FeedbackSubmission {
  client_request_id: string; type: FeedbackType; title: string; description: string;
  component?: string; priority?: FeedbackPriority; reproduction?: string;
  expected?: string; actual?: string; versions?: string;
  retest?: FeedbackProbe;
}
export const feedbackKeys = {
  all: ['feedback'] as const,
  state: ['feedback', 'state'] as const,
  configuration: ['feedback', 'configuration'] as const,
  summary: ['feedback', 'summary'] as const,
  list: (filters: FeedbackFilters) => ['feedback', 'list', filters] as const,
  detail: (id: string) => ['feedback', 'detail', id] as const,
};
export const feedbackApi = {
  configuration: () => api.get<FeedbackConfiguration>('/admin/feedback/configuration'),
  saveConfiguration: (body: { expected_revision: string; config: Omit<FeedbackConfiguration, 'revision' | 'token_configured' | 'repository'>; token?: string; disconnect?: boolean }) => api.post<FeedbackConfiguration>('/admin/feedback/configuration', body),
  recheck: (id: string, expected_version: number) => api.post<{ queued: boolean }>(`/admin/feedback/${encodeURIComponent(id)}/recheck`, { expected_version }),
  state: () => api.get<{ enabled: boolean }>('/admin/feedback/state'),
  summary: () => api.get<{ open: number; in_progress: number; blocked: number }>('/admin/feedback/summary'),
  setEnabled: (enabled: boolean) => api.post<{ enabled: boolean }>('/admin/feedback/state', { enabled }),
  list: (filters: FeedbackFilters) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value));
    return api.get<{ feedback: FeedbackItem[]; next_offset: number | null }>(`/admin/feedback?${params}`);
  },
  get: (id: string) => api.get<{ feedback: FeedbackItem; events: FeedbackEvent[] }>(`/admin/feedback/${encodeURIComponent(id)}`),
  submit: (body: FeedbackSubmission) => api.post<{ feedback: FeedbackItem; replayed: boolean }>('/admin/feedback', body),
  update: (id: string, body: Record<string, unknown>) => api.post<{ feedback: FeedbackItem }>(`/admin/feedback/${encodeURIComponent(id)}`, body),
  remove: (id: string) => api.delete<{ deleted: number; cascaded_duplicates: number; ids: string[] }>(`/admin/feedback/${encodeURIComponent(id)}`),
  forceRelease: (id: string, reason: string) => api.post<{ feedback: FeedbackItem }>(`/admin/feedback/${encodeURIComponent(id)}/claim`, { action: 'force_release', reason }),
};
