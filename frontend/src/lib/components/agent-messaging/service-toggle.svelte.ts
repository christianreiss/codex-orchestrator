/**
 * The messaging service switch, driven from the page header.
 *
 * `pendingTarget` is the position the operator asked for but has not confirmed.
 * Routing the intent through it (rather than the server value) makes the
 * header switch genuinely transition false -> true -> false when the dialog is
 * cancelled, which is what pushes the visual revert into bits-ui's Switch.
 *
 * Must be called during component initialisation (it owns queries/mutations).
 */
import { fromStore } from "svelte/store";
import { toast } from "svelte-sonner";
import { authStore } from "$lib/stores/auth";
import { agentMessagingStateMutation, agentMessagingStateQuery } from "$lib/api/agentMessaging";
import { hostsListQuery } from "$lib/api/hosts";
import type { AgentMessagingBlastRadius } from "$lib/components/settings/agent-messaging-consequences";

export function createServiceToggle() {
  const query = fromStore(agentMessagingStateQuery());
  // Unconditional on purpose: gating on a capability captured at mount would
  // leave the query disabled if the auth store resolves later. Shares the
  // ["hosts","list"] key, so it is free once Hosts has been visited.
  const hosts = fromStore(hostsListQuery());
  const auth = fromStore(authStore);
  let pendingTarget = $state<boolean | null>(null);

  const mutation = fromStore(
    agentMessagingStateMutation({
      onSuccess: (data) => {
        pendingTarget = null;
        toast.success(
          data.enabled
            ? "Messages enabled; hosts pick up the new instructions on their next launch"
            : "Messages disabled; open conversations and in-flight work canceled",
        );
      },
      onError: (error) => {
        pendingTarget = null;
        toast.error(error.message);
      },
    }),
  );

  const data = $derived(query.current.data);
  const currentEnabled = $derived(data?.enabled ?? false);
  const radius = $derived<AgentMessagingBlastRadius>({
    activeHosts: hosts.current.data?.hosts?.filter((host) => host.status === "active").length ?? null,
    openConversations: data?.open_conversations ?? 0,
    pendingDeliveries: (data?.messages.queued ?? 0) + (data?.messages.leased ?? 0),
    acceptedDeliveries: data?.messages.accepted ?? 0,
    relays: data?.relays ?? 0,
  });

  return {
    get state() {
      return data;
    },
    get pending() {
      return query.current.isPending;
    },
    get canManage() {
      return auth.current.can("agent_messaging.manage");
    },
    get checked() {
      return pendingTarget ?? currentEnabled;
    },
    get disabled() {
      return !auth.current.can("agent_messaging.manage") || query.current.isPending || mutation.current.isPending;
    },
    request(next: boolean) {
      pendingTarget = next;
    },
    /** Props for AgentMessagingConfirmDialog. */
    get dialog() {
      return {
        open: pendingTarget !== null && pendingTarget !== currentEnabled,
        enabling: pendingTarget === true,
        radius,
        busy: mutation.current.isPending,
        onConfirm: () => {
          if (pendingTarget !== null) mutation.current.mutate(pendingTarget);
        },
        onCancel: () => {
          pendingTarget = null;
        },
      };
    },
  };
}
