import { api } from './client';
import type { AgentAddress, AgentMessageMetadata } from './agentMessaging';

export interface Conference {
  id: string;
  topic: string | null;
  purpose: string | null;
  status: string;
  deadline_at: string;
  created_at: string;
  adjourned_at: string | null;
  adjourn_reason: string | null;
  max_members: number;
  chair?: AgentAddress | null;
  member_count?: number;
  total_members?: number;
  last_activity_at?: string;
}
export interface ConferenceMember {
  id: string;
  address_id: string;
  peer: AgentAddress | null;
  role: string;
  purpose: string | null;
  mode: string;
  state: string;
  messages_used: number;
  messages_budget: number;
  dispatched_at: string | null;
  dispatch_deadline_at: string | null;
  last_report_at: string | null;
  joined_at: string;
  left_at: string | null;
  conversation_id: string | null;
  conversation_status: string | null;
  dispatch_message_id: string | null;
  dispatch_status: string | null;
  dispatch_error: string | null;
}
export interface ConferenceDetail { conference: Conference; members: ConferenceMember[] }
export interface ConferenceMessage extends AgentMessageMetadata { dispatch_order: number; content?: string }
export interface ConferenceMessages {
  messages: ConferenceMessage[];
  oldest_cursor: number | null;
  newest_cursor: number | null;
  has_more: boolean;
}
export const conferenceKeys = ['agent-messaging', 'conferences'] as const;
const root = '/admin/agent-messaging/conferences';
export function conferencesOptions(status: string, limit: number) {
  return {
    queryKey: [...conferenceKeys, { status, limit }],
    queryFn: ({ signal }: { signal: AbortSignal }) => api.get<{ conferences: Conference[] }>(`${root}?limit=${limit}${status === 'all' ? '' : `&status=${status}`}`, { signal }),
    refetchInterval: 15_000,
  };
}
export function conferenceOptions(id: string) {
  return { queryKey: [...conferenceKeys, id], queryFn: ({ signal }: { signal: AbortSignal }) => api.get<ConferenceDetail>(`${root}/${id}`, { signal }), refetchInterval: 15_000 };
}
export function conferenceMessagesOptions(id: string) {
  return {
    queryKey: [...conferenceKeys, id, 'messages'],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }: { pageParam: number | undefined; signal: AbortSignal }) => api.get<ConferenceMessages>(`${root}/${id}/messages${pageParam === undefined ? '' : `?before=${pageParam}`}`, { signal }),
    getNextPageParam: (last: ConferenceMessages) => last.has_more ? last.oldest_cursor ?? undefined : undefined,
    refetchInterval: 15_000,
  };
}
export function revealConference(id: string, messageIds: string[], signal: AbortSignal) {
  return api.post<ConferenceMessages>(`${root}/${id}/reveal`, { message_ids: messageIds }, { signal });
}
