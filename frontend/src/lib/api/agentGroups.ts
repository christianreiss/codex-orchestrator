import { createMutation, useQueryClient } from "@tanstack/svelte-query";
import { api } from "./client";
import { agentMessagingKeys, type AgentEngine } from "./agentMessaging";

export const SERVER_TOPIC = "agent:00000000-0000-4000-8000-000000000001";
export const MAX_PUBLICATION_CONTENT_BYTES = 30 * 1024;
export interface AgentGroup {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  topic: string;
  member_count: number;
  created_at: string;
  updated_at: string;
}
export interface AgentGroupMember {
  address_id: string;
  address: string;
  alias: string | null;
  engine: AgentEngine;
  host_id: number;
  joined_at: string;
}
export interface AgentSubscription {
  topic: string;
  subscriber_address_id: string;
  subscriber_address: string;
  subscriber_engine: AgentEngine;
  created_at: string;
}
export interface AgentPublication {
  publication_id: string;
  topic: string;
  created: boolean;
  recipient_count: number;
  deliveries: Array<{ address_id: string; message_id: string }>;
  skipped: Array<{ address_id: string; reason: string }>;
}
export interface AgentPublishInput {
  topic: string;
  content: string;
  client_message_id: string;
  ttl_seconds?: number;
}
export function agentGroupsOptions() {
  return {
    queryKey: [...agentMessagingKeys.all, "groups"],
    queryFn: ({ signal }: { signal: AbortSignal }) => api.get<{ groups: AgentGroup[]; max_publication_content_bytes?: number }>("/admin/agent-messaging/groups", { signal }),
    refetchInterval: 15_000,
  };
}
export function agentGroupOptions(slug: string) {
  return {
    queryKey: [...agentMessagingKeys.all, "groups", slug],
    queryFn: ({ signal }: { signal: AbortSignal }) => api.get<{ group: AgentGroup; members: AgentGroupMember[] }>(`/admin/agent-messaging/groups/${encodeURIComponent(slug)}`, { signal }),
    enabled: slug.length > 0,
    refetchInterval: 15_000,
  };
}
export function agentSubscriptionsOptions() {
  return {
    queryKey: [...agentMessagingKeys.all, "subscriptions"],
    queryFn: ({ signal }: { signal: AbortSignal }) => api.get<{ subscriptions: AgentSubscription[] }>("/admin/agent-messaging/subscriptions", { signal }),
    refetchInterval: 15_000,
  };
}
export function agentGroupCreateMutation() {
  const client = useQueryClient();
  return createMutation({
    mutationFn: (input: { slug: string; title: string; description?: string }) => api.post<{ created: boolean; group: AgentGroup }>("/admin/agent-messaging/groups", input),
    onSettled: () => void client.invalidateQueries({ queryKey: agentMessagingKeys.all }),
  });
}
export function agentPublishMutation() {
  const client = useQueryClient();
  return createMutation({
    mutationFn: (input: AgentPublishInput) => api.post<AgentPublication>("/admin/agent-messaging/publish", input),
    // The operator's draft is never placed in a query cache.
    onSettled: () => void client.invalidateQueries({ queryKey: agentMessagingKeys.all }),
  });
}
