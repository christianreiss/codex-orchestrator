<script lang="ts">
  import { toast } from "svelte-sonner";
  import { authStore } from "$lib/stores/auth";
  import {
    agentMessagingStateMutation,
    agentMessagingStateQuery,
  } from "$lib/api/agentMessaging";
  import { hostsListQuery } from "$lib/api/hosts";
  import SectionCard from "./SectionCard.svelte";
  import SwitchRow from "./SwitchRow.svelte";
  import AgentMessagingConfirmDialog from "./AgentMessagingConfirmDialog.svelte";
  import type { AgentMessagingBlastRadius } from "./agent-messaging-consequences";

  const query = agentMessagingStateQuery();
  let lastSavedAt = $state<Date | null>(null);
  /**
   * The position the operator has asked for but not yet confirmed.
   *
   * This is not a convenience. `SwitchRow` passes `checked` one way into
   * bits-ui's Switch, whose own `checked` is `$bindable` and flips internally on
   * click — nothing binds it back. If this expression stayed `data.enabled`, its
   * value would not change between opening and cancelling the dialog, so no prop
   * update would be pushed and the switch would sit visually flipped while the
   * fleet was unchanged. Routing intent through here makes the value genuinely
   * transition (false -> true -> false), which is what pushes the revert.
   */
  let pendingTarget = $state<boolean | null>(null);

  const mutation = agentMessagingStateMutation({
    onSuccess: (data) => {
      lastSavedAt = new Date();
      pendingTarget = null;
      toast.success(data.enabled
        ? "Agent Messaging enabled; hosts pick up the new instructions on their next launch"
        : "Agent Messaging disabled; open conversations and in-flight work canceled");
    },
    onError: (error) => {
      pendingTarget = null;
      toast.error(error.message);
    },
  });
  const data = $derived($query.data);
  const canMutate = $derived($authStore.can("agent_messaging.manage"));
  // Deliberately unconditional. Gating this on `canMutate` would capture that
  // value once at mount, and the auth store can resolve after it — a viewer
  // promoted mid-session, or simply a slow bootstrap, would leave the query
  // permanently disabled and every enable dialog stuck on the count-free copy,
  // silently. A non-admin instead gets one 403 the query swallows, `radius`
  // falls back to null, and the dialog they cannot open would have degraded
  // anyway. Shares the ["hosts","list"] key, so it is free once Hosts is visited.
  const hosts = hostsListQuery();
  const currentEnabled = $derived(data?.enabled ?? false);
  const confirmOpen = $derived(pendingTarget !== null && pendingTarget !== currentEnabled);
  const radius = $derived<AgentMessagingBlastRadius>({
    // null while loading or on error: the copy drops the number rather than
    // claiming zero hosts, and the dialog never blocks on this query.
    activeHosts:
      $hosts.data?.hosts?.filter((host) => host.status === "active").length ?? null,
    openConversations: data?.open_conversations ?? 0,
    pendingDeliveries: (data?.messages.queued ?? 0) + (data?.messages.leased ?? 0),
    acceptedDeliveries: data?.messages.accepted ?? 0,
    relays: data?.relays ?? 0,
  });
  const status = $derived.by(() => {
    if ($mutation.isPending) return "saving" as const;
    if ($mutation.isError) return "error" as const;
    if ($mutation.isSuccess) return "saved" as const;
    return "idle" as const;
  });
</script>

<SectionCard
  id="agent-messaging"
  title="Service state"
  description="Fleet-wide Codex ↔ Claude communication with stable addresses, automatic resume/fresh delivery, encrypted content, and ordered at-least-once semantics. The initial default is off."
  {status}
  savedAt={lastSavedAt}
  error={$mutation.error?.message}
>
  <SwitchRow
    id="agent-messaging-toggle"
    label="Enable agent-to-agent messaging"
    description={$query.isPending
      ? "Loading current state…"
      : data?.enabled
        ? `${data.live_addresses} live addresses · ${data.messages.queued + data.messages.leased + data.messages.accepted} pending deliveries`
        : "Discovery, send, reply, wake, resume, and relay polling are disabled."}
    checked={pendingTarget ?? currentEnabled}
    disabled={!canMutate || $query.isPending || $mutation.isPending}
    onCheckedChange={(next) => (pendingTarget = next)}
  />

  <p class="text-xs text-muted-foreground">
    Enabling adds an Agent Messaging section to every active host's AGENTS.md / CLAUDE.md, replacing
    the whole file on their next wrapper launch. Both directions confirm before applying.
  </p>

  <p class="text-xs text-muted-foreground">32 KiB text · 24h default TTL · 12 delivery attempts · no broadcast or attachments</p>
</SectionCard>

<AgentMessagingConfirmDialog
  open={confirmOpen}
  enabling={pendingTarget === true}
  {radius}
  busy={$mutation.isPending}
  onConfirm={() => {
    if (pendingTarget !== null) $mutation.mutate(pendingTarget);
  }}
  onCancel={() => (pendingTarget = null)}
/>
