import { api } from './client';
export type Engine = 'codex' | 'claude' | 'grok';
export interface Selection { engine: Engine | null; model: string | null }
export interface ChattyStatus {
  visible: boolean; ready: boolean; enabled: boolean; knowledge_version: string;
  engines: Array<{ engine: Engine; ready: boolean; reason: string | null; default_model: string | null; models: Array<{ id: string; display_name: string }> }>;
}
export interface ChattyEvent {
  id: number; kind: string; runId: string | null; createdAt: string;
  body: { text?: string; id?: string; tool?: string; description?: string; arguments?: unknown; before?: unknown; result?: unknown; href?: string; status?: string; engine?: string; model?: string; options?: string[]; sources?: Array<{ id: string; title: string; heading: string; href: string; body: string }> };
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
