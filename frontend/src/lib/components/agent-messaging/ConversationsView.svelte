<script lang="ts">
  /** The default Messages view: who is talking to whom, newest first. */
  import { createQuery } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import * as Table from "$lib/components/ui/table";
  import MessageSquare from "@lucide/svelte/icons/message-square";
  import { DataTable, ListDetail } from "$lib/components/page";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { authStore } from "$lib/stores/auth";
  import { relativeTime } from "$lib/utils/format";
  import { agentConversationCancelMutation, agentMessagingConversationsQuery } from "$lib/api/agentMessaging";
  import type { AgentConversation } from "$lib/api/agentMessaging";
  import { routeLabel } from "./messaging-labels";
  import type { MessagingFilters } from "./messaging-filters.svelte";

  let { filters }: { filters: MessagingFilters } = $props();

  const conversations = createQuery(
    reactiveOptions(() =>
      agentMessagingConversationsQuery({
        status: filters.conversationStatus === "all" ? undefined : filters.conversationStatus,
        limit: filters.limit,
      }),
    ),
  );
  const cancel = agentConversationCancelMutation();
  const canMutate = $derived($authStore.can("agent_messaging.manage"));

  let selected = $state<AgentConversation | null>(null);
  let detailOpen = $state(false);
  let cancelTarget = $state<AgentConversation | null>(null);

  function inspect(item: AgentConversation) {
    selected = item;
    detailOpen = true;
  }
  async function confirmCancel() {
    const item = cancelTarget;
    if (!item) return;
    try {
      await $cancel.mutateAsync({ id: item.id, reason: "Canceled from the Messages page" });
      toast.success("Conversation canceled");
      detailOpen = false;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Conversation cancellation failed");
    } finally {
      cancelTarget = null;
    }
  }
  const title = (item: AgentConversation) => `${routeLabel(item.address_a)} ↔ ${routeLabel(item.address_b)}`;
  const items = $derived($conversations.data?.conversations);
</script>

<ListDetail bind:open={detailOpen} title={selected ? title(selected) : "Conversation"} description={selected ? `Conversation ${selected.id.slice(0, 8)}` : undefined}>
  {#snippet list()}
    <DataTable
      {items}
      loading={$conversations.isPending}
      error={$conversations.isError ? $conversations.error.message : null}
      onRetry={() => $conversations.refetch()}
      key={(item) => item.id}
      emptyTitle="No conversations"
      emptyDescription="Conversations start when one agent messages another."
      emptyIcon={MessageSquare}
      filtered={filters.conversationStatus !== "all"}
      caption="Conversations"
    >
      {#snippet head()}
        <Table.Head>Between</Table.Head>
        <Table.Head>Status</Table.Head>
        <Table.Head class="text-right">Messages</Table.Head>
        <Table.Head>Last activity</Table.Head>
        <Table.Head class="w-24"><span class="sr-only">Actions</span></Table.Head>
      {/snippet}
      {#snippet row(item)}
        <Table.Row class="cursor-pointer" onclick={() => inspect(item)}>
          <Table.Cell class="max-w-[22rem] truncate font-medium">{title(item)}</Table.Cell>
          <Table.Cell><Badge variant={item.status === "open" ? "success" : "secondary"} class="uppercase">{item.status}</Badge></Table.Cell>
          <Table.Cell class="text-right tabular-nums">{item.next_sequence - 1}</Table.Cell>
          <Table.Cell class="text-muted-foreground">{relativeTime(item.last_activity_at)}</Table.Cell>
          <Table.Cell onclick={(event: MouseEvent) => event.stopPropagation()}>
            <Button size="sm" variant="outline" onclick={() => filters.openDeliveries(item.id)}>Deliveries</Button>
          </Table.Cell>
        </Table.Row>
      {/snippet}
    </DataTable>
  {/snippet}
  {#snippet detail()}
    {#if selected}
      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-body-sm">
        <dt class="text-muted-foreground">Status</dt><dd>{selected.status}</dd>
        <dt class="text-muted-foreground">Messages</dt><dd>{selected.next_sequence - 1}</dd>
        <dt class="text-muted-foreground">Started</dt><dd>{relativeTime(selected.created_at)}</dd>
        <dt class="text-muted-foreground">Last activity</dt><dd>{relativeTime(selected.last_activity_at)}</dd>
        {#if selected.canceled_at}
          <dt class="text-muted-foreground">Canceled</dt><dd>{relativeTime(selected.canceled_at)}{selected.canceled_by ? ` by ${selected.canceled_by}` : ""}{selected.cancel_reason ? ` · ${selected.cancel_reason}` : ""}</dd>
        {/if}
        <dt class="text-muted-foreground">ID</dt><dd class="break-all font-mono text-caption">{selected.id}</dd>
      </dl>
      <p class="mt-3 text-body-sm text-muted-foreground">Open until a participant, an administrator, or the master switch cancels it.</p>
    {/if}
  {/snippet}
  {#snippet footer()}
    {#if selected}
      <Button variant="outline" onclick={() => { detailOpen = false; filters.openDeliveries(selected!.id); }}>Open delivery log</Button>
      {#if canMutate && selected.status === "open"}
        <Button variant="destructive" onclick={() => (cancelTarget = selected)}>Cancel conversation</Button>
      {/if}
    {/if}
  {/snippet}
</ListDetail>

<ConfirmDialog
  open={cancelTarget !== null}
  onClose={() => (cancelTarget = null)}
  title="Cancel this conversation?"
  description={cancelTarget ? `Cancel conversation ${cancelTarget.id.slice(0, 8)} and all undelivered work.` : ""}
  confirmLabel="Cancel conversation"
  cancelLabel="Keep it"
  destructive
  busy={$cancel.isPending}
  onConfirm={confirmCancel}
/>
