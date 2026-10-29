import { api } from './client';
import type { ChattyActionElement } from '$lib/components/chatty/actions';
export type Engine = 'codex' | 'claude' | 'grok';
export interface Selection { engine: Engine | null; model: string | null }
export interface ChattyStatus {
  visible: boolean; ready: boolean; enabled: boolean; knowledge_version: string;
  engines: Array<{ engine: Engine; ready: boolean; reason: string | null; default_model: string | null; models: Array<{ id: string; display_name: string }> }>;
}
/** Server-resolved reply elements; `path` is base-relative and built from an allowlisted template. */
export type ChattyElement =
  | { type: 'link'; kind: string; label: string; path: string }
  | { type: 'suggestion'; text: string }
  | ChattyActionElement;
/** Fresh server re-check of an action button for this admin session; nothing is executed. */
export type ChattyProposalCheck =
  | { available: false; reason: string; detail: string }
  | {
      available: true; action: string; risk: 'safe' | 'confirm' | 'danger'; label: string; title: string; summary: string[];
      confirm_label: string; confirm_text: string | null; target: { kind: string; id: number; name: string } | null;
      plan: unknown; params: Record<string, unknown>; expires_at: string;
    };
export const verifyChattyProposal = (proposal: string) => api.post<ChattyProposalCheck>('/admin/chatty/proposals/verify', { proposal });
export interface ChattyEvent {
  id: number; kind: string; runId: string | null; createdAt: string;
  body: { text?: string; id?: string; tool?: string; description?: string; arguments?: unknown; before?: unknown; result?: unknown; href?: string; status?: string; engine?: string; model?: string; options?: string[]; sources?: Array<{ id: string; title: string; heading: string; href: string; body: string }>; elements?: ChattyElement[]; elements_omitted?: number };
}
export interface ChattySnapshot {
  generation: number; selection: Selection; events: ChattyEvent[]; has_older: boolean;
  active: { id: string; status: string; generation: number; steps: number } | null;
}
export const chattyKeys = { status: ['chatty', 'status'] as const, session: ['chatty', 'session'] as const };
export const fetchChattyStatus = () => api.get<ChattyStatus>('/admin/chatty/status');
export const fetchChattySession = (before?: number) => api.get<ChattySnapshot>(`/admin/chatty/session${before ? `?before=${before}` : ''}`);
/** Only stable route identifiers; never DOM, query parameters or unsaved fields. */
export function chattyContext(path: string) {
  const route = path.slice('/admin'.length).split('/').filter(Boolean);
  const kinds = { hosts: 'host', projects: 'project', accounts: 'account' } as const;
  const kind = kinds[route[0] as keyof typeof kinds];
  if (kind && route[1]) return { page: route[0], kind, id: decodeURIComponent(route[1]) };
  if (route[0] === 'authoring' && route[1] === 'skills' && route[2]) return { page: 'authoring/skills', kind: 'skill', id: decodeURIComponent(route[2]) };
  return { page: route[0] ?? 'dashboard' };
}
