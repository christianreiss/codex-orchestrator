import {
  createMutation,
  createQuery,
  useQueryClient,
  type CreateMutationOptions,
  type CreateQueryOptions,
} from "@tanstack/svelte-query";
import { api } from "./client";

export type AgentEngine = "codex" | "claude";
export type AgentConversationStatus = "open" | "canceled";
export type AgentMessageStatus =
  | "queued"
  | "leased"
  | "accepted"
  | "completed"
  | "dead"
  | "ambiguous"
  | "expired"
  | "canceled";

export interface AgentMessagingState {
  enabled: boolean;
  initial_default: boolean;
  addresses: number;
  live_addresses: number;
  relays: number;
  open_conversations: number;
  messages: {
    queued: number;
    leased: number;
    accepted: number;
    dead: number;
    ambiguous: number;
  };
  directions: Array<{
    source_engine: AgentEngine;
    target_engine: AgentEngine;
    total: number;
    pending: number;
    completed: number;
    dead: number;
    ambiguous: number;
  }>;
  delivery: "ordered_at_least_once" | string;
}

export interface AgentAddress {
  id: string;
  address: string;
  alias: string | null;
  engine: AgentEngine;
  host_id: number;
  fqdn?: string;
  username: string;
  cwd: string;
  enabled: boolean;
  continuity: "native" | "reset" | string;
  readiness: "live" | "resumable" | "offline" | "disabled" | string;
  adapter_protocol: string | null;
  adapter_capabilities: Record<string, unknown> | null;
  binding_generation: number;
  current_session_id: string | null;
  receive_heartbeat_at: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export type AgentAddressIneligibleReason =
  | "master_disabled"
  | "insecure_window_closed"
  | "host_inactive"
  | "engine_disabled";

/** Host-enriched address returned by the admin operations listing. */
export interface AgentAdminAddress extends AgentAddress {
  queue_depth: number;
  host_secure: boolean;
  host_status: string;
  host_window_until: string | null;
  host_engines: AgentEngine[];
  eligible: boolean;
  ineligible_reason: AgentAddressIneligibleReason | string | null;
}

export interface AgentConversationMetadata {
  id: string;
  address_a_id: string;
  address_b_id: string;
  created_by_address_id: string;
  status: AgentConversationStatus;
  next_sequence: number;
  last_activity_at: string;
  canceled_by: string | null;
  cancel_reason: string | null;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentConversation extends AgentConversationMetadata {
  address_a: AgentAddress;
  address_b: AgentAddress;
}

export interface AgentMessageMetadata {
  id: string;
  conversation_id: string;
  sequence: number;
  reply_to_message_id: string | null;
  redrive_of_message_id: string | null;
  sender: AgentAddress;
  target: AgentAddress;
  kind: string;
  content_bytes: number;
  status: AgentMessageStatus;
  attempts: number;
  expires_at: string;
  last_error_code: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  ambiguous_at: string | null;
  dead_at: string | null;
  expired_at: string | null;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentMessagingToggleResult {
  enabled: boolean;
  canceled: number;
  ambiguous: number;
  conversations: number;
  relays: number;
  bindings: number;
}

export interface AgentConversationFilters {
  status?: AgentConversationStatus;
  limit?: number;
}

export interface AgentMessageFilters {
  conversationId?: string;
  status?: AgentMessageStatus;
  limit?: number;
  /** TanStack query gate; false is used for an invalid non-empty UUID filter. */
  enabled?: boolean;
}

/** Trust the server's complete eligibility decision; disabling is always allowed. */
export function agentAddressToggleDisabled(
  address: Pick<AgentAdminAddress, "enabled" | "eligible">,
): boolean {
  return !address.enabled && !address.eligible;
}

export function agentAddressIneligibleReasonLabel(reason: string | null): string | null {
  if (reason === null) return null;
  if (reason === "master_disabled") return "Fleet switch is off";
  if (reason === "host_inactive") return "Host is not active";
  if (reason === "insecure_window_closed") {
    return "Insecure host — allowed window is closed";
  }
  if (reason === "engine_disabled") return "Address engine is disabled on this host";
  return "Address is not eligible";
}

type MutationOpts<T, V> = Omit<CreateMutationOptions<T, Error, V, unknown>, "mutationFn">;

export const agentMessagingKeys = {
  all: ["agent-messaging"] as const,
  state: ["agent-messaging", "state"] as const,
  addresses: ["agent-messaging", "addresses"] as const,
  conversations: ["agent-messaging", "conversations"] as const,
  messages: ["agent-messaging", "messages"] as const,
};

function normalizedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(500, Math.trunc(value)));
}

function normalizedText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export function agentMessagingStateQuery() {
  return createQuery<AgentMessagingState>({
    queryKey: agentMessagingKeys.state,
    queryFn: () => api.get<AgentMessagingState>("/admin/agent-messaging/state"),
  });
}

export function agentMessagingAddressesQuery() {
  return createQuery<{ addresses: AgentAdminAddress[] }>({
    queryKey: agentMessagingKeys.addresses,
    queryFn: () => api.get<{ addresses: AgentAdminAddress[] }>("/admin/agent-messaging/addresses"),
  });
}

export function agentMessagingConversationsQuery(
  filters: AgentConversationFilters = {},
): CreateQueryOptions<{ conversations: AgentConversation[] }, Error> {
  const status = normalizedText(filters.status) as AgentConversationStatus | undefined;
  const limit = normalizedLimit(filters.limit);
  const query = queryString({ status, limit });
  return {
    queryKey: [...agentMessagingKeys.conversations, { status: status ?? null, limit }] as const,
    queryFn: () =>
      api.get<{ conversations: AgentConversation[] }>(
        `/admin/agent-messaging/conversations${query}`,
      ),
  };
}

export function agentMessagingMessagesQuery(
  filters: AgentMessageFilters = {},
): CreateQueryOptions<{ messages: AgentMessageMetadata[] }, Error> {
  const conversationId = normalizedText(filters.conversationId);
  const status = normalizedText(filters.status) as AgentMessageStatus | undefined;
  const limit = normalizedLimit(filters.limit);
  const enabled = filters.enabled !== false;
  const query = queryString({ conversation_id: conversationId, status, limit });
  return {
    queryKey: [
      ...agentMessagingKeys.messages,
      { conversation_id: conversationId ?? null, status: status ?? null, limit, enabled },
    ] as const,
    queryFn: () =>
      api.get<{ messages: AgentMessageMetadata[] }>(`/admin/agent-messaging/messages${query}`),
    enabled,
  };
}

function invalidateAll() {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: agentMessagingKeys.all });
}

export function agentMessagingStateMutation(
  opts: MutationOpts<AgentMessagingToggleResult, boolean> = {},
) {
  const invalidate = invalidateAll();
  return createMutation<AgentMessagingToggleResult, Error, boolean>({
    mutationFn: (enabled) =>
      api.post<AgentMessagingToggleResult>("/admin/agent-messaging/state", { enabled }),
    ...opts,
    onSettled: (...args) => {
      invalidate();
      opts.onSettled?.(...args);
    },
  });
}

export function agentAddressEnabledMutation(opts: MutationOpts<unknown, { id: string; enabled: boolean }> = {}) {
  const invalidate = invalidateAll();
  return createMutation<unknown, Error, { id: string; enabled: boolean }>({
    mutationFn: ({ id, enabled }) => api.post(`/admin/agent-messaging/addresses/${id}/enabled`, { enabled }),
    ...opts,
    onSettled: (...args) => {
      invalidate();
      opts.onSettled?.(...args);
    },
  });
}

export function agentAddressAliasMutation(opts: MutationOpts<unknown, { id: string; alias: string | null }> = {}) {
  const invalidate = invalidateAll();
  return createMutation<unknown, Error, { id: string; alias: string | null }>({
    mutationFn: ({ id, alias }) => api.patch(`/admin/agent-messaging/addresses/${id}`, { alias }),
    ...opts,
    onSettled: (...args) => {
      invalidate();
      opts.onSettled?.(...args);
    },
  });
}

export function agentConversationCancelMutation(opts: MutationOpts<unknown, { id: string; reason?: string }> = {}) {
  const invalidate = invalidateAll();
  return createMutation<unknown, Error, { id: string; reason?: string }>({
    mutationFn: ({ id, reason }) => api.post(`/admin/agent-messaging/conversations/${id}/cancel`, { reason: reason ?? null }),
    ...opts,
    onSettled: (...args) => {
      invalidate();
      opts.onSettled?.(...args);
    },
  });
}

export function agentMessageRedriveMutation(opts: MutationOpts<unknown, string> = {}) {
  const invalidate = invalidateAll();
  return createMutation<unknown, Error, string>({
    mutationFn: (id) => api.post(`/admin/agent-messaging/messages/${id}/redrive`),
    ...opts,
    onSettled: (...args) => {
      invalidate();
      opts.onSettled?.(...args);
    },
  });
}

export async function revealAgentMessage(id: string): Promise<string> {
  const result = await api.post<{ message_id: string; content: string }>(`/admin/agent-messaging/messages/${id}/reveal`);
  return result.content;
}
