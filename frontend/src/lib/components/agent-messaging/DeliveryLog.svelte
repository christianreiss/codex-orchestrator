<script lang="ts">
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  /**
   * The delivery log: raw per-message plumbing (status, attempts, errors) with
   * audited content reveal, redrive and one-time fresh-start approval. A
   * secondary view of Messages; most questions are answered by Conversations.
   */
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import { StateBlock } from "$lib/components/page";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { authStore } from "$lib/stores/auth";
  import { formatBytes } from "$lib/utils/format";
  import {
    agentMessageRedriveMutation,
    agentMessagingKeys,
    agentMessagingMessagesQuery,
    approveAgentFreshStart,
    revealAgentMessage,
    type AgentMessageMetadata,
  } from "$lib/api/agentMessaging";
  import ReasonDialog from "./ReasonDialog.svelte";
  import { routeLabel, statusVariant } from "./messaging-labels";
  import type { MessagingFilters } from "./messaging-filters.svelte";

  let { filters, enabled }: { filters: MessagingFilters; enabled: boolean } = $props();

  const queryClient = useQueryClient();
  const messageId = $derived(page.url.searchParams.get("message_id") ?? undefined);
  const messages = createQuery(
    reactiveOptions(() =>
      agentMessagingMessagesQuery({
        conversationId: filters.validConversationId,
        messageId,
        status: filters.messageStatus === "all" ? undefined : filters.messageStatus,
        limit: filters.limit,
        enabled: filters.conversationIdValid,
      }),
    ),
  );
  const redrive = agentMessageRedriveMutation();
  const canMutate = $derived($authStore.can("agent_messaging.manage"));
  const canReveal = $derived($authStore.can("agent_messaging.reveal_content"));

  let revealed = $state<{ messageId: string; content: string } | null>(null);
  let busyMessage = $state<string | null>(null);
  const guard = { generation: 0 };
  let revealTarget = $state<AgentMessageMetadata | null>(null);
  let redriveTarget = $state<AgentMessageMetadata | null>(null);
  let freshTarget = $state<AgentMessageMetadata | null>(null);
  let freshReason = $state("");

  function clearReveal() {
    guard.generation += 1;
    revealed = null;
    busyMessage = null;
  }
  // Revealed text must not outlive the view, the filters, the data or the grant.
  const signature = $derived(
    [[...$authStore.capabilities].sort().join("\u0000"), filters.messageStatus, filters.conversationId.trim(), messageId, filters.limit].join("|"),
  );
  $effect(() => {
    void signature;
    void $messages.data;
    clearReveal();
    return clearReveal;
  });

  function clearMessageLink() {
    const url = new URL(page.url);
    url.searchParams.delete("message_id");
    void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  }

  async function reveal(item: AgentMessageMetadata) {
    revealTarget = null;
    const generation = ++guard.generation;
    revealed = null;
    busyMessage = item.id;
    try {
      const content = await revealAgentMessage(item.id);
      const stillListed = ($messages.data?.messages ?? []).some((message) => message.id === item.id);
      if (generation === guard.generation && canReveal && stillListed) revealed = { messageId: item.id, content };
    } catch (error) {
      if (generation === guard.generation) toast.error(error instanceof Error ? error.message : "Message reveal failed");
    } finally {
      if (generation === guard.generation) busyMessage = null;
    }
  }

  async function redriveMessage(item: AgentMessageMetadata) {
    try {
      await $redrive.mutateAsync(item.id);
      toast.success("Message redriven as a new ordered delivery");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Redrive failed");
    } finally {
      redriveTarget = null;
    }
  }

  async function approveFresh(item: AgentMessageMetadata, reason: string) {
    try {
      await approveAgentFreshStart(item.id, item.execution_version ?? 1, reason);
      await queryClient.invalidateQueries({ queryKey: agentMessagingKeys.all });
      toast.success("One replacement session approved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Approval failed");
    } finally {
      freshTarget = null;
    }
  }

  const needsFreshStart = (m: AgentMessageMetadata) =>
    canMutate && m.work_kind && m.kind !== "schedule" && m.last_error_code === "native_transcript_missing" && (m.status === "dead" || m.status === "ambiguous");
  const canRedrive = (m: AgentMessageMetadata) =>
    canMutate && m.kind !== "schedule" && m.kind !== "presence_notice" && (m.status === "dead" || m.status === "ambiguous");
  const retained = (id: string) => `${base}/agent-messaging?view=deliveries&message_id=${id}`;
</script>

<section aria-labelledby="deliveries-heading" class="space-y-2">
  <div>
    <h2 id="deliveries-heading" class="text-h3">Delivery log</h2>
    <p class="text-body-sm text-muted-foreground">Every message with its delivery status. Content stays hidden until an owner or admin reveals it, and each reveal is audited.</p>
    {#if messageId}
      <p class="mt-1 text-caption text-muted-foreground">Showing linked message history · {messageId} <Button size="sm" variant="ghost" onclick={clearMessageLink}>Clear filter</Button></p>
    {/if}
  </div>
  {#if !filters.conversationIdValid}
    <StateBlock state="empty" message="Enter a complete conversation UUID to load deliveries." />
  {:else if $messages.isPending}
    <StateBlock state="loading" />
  {:else if $messages.isError}
    <StateBlock state="error" message={$messages.error.message} onRetry={() => $messages.refetch()} />
  {:else if !$messages.data?.messages.length}
    <StateBlock state="empty" message="No deliveries" />
  {:else}
    <div class="divide-y rounded-md border">
      {#each $messages.data.messages as message (message.id)}
        <article class="space-y-1 px-3 py-2.5">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="truncate text-body font-medium">{routeLabel(message.sender)} → {routeLabel(message.target)}</p>
              <p class="text-caption text-muted-foreground">#{message.sequence} · {message.kind} · {message.delivery_class ?? "information"} · {formatBytes(message.content_bytes)} · attempt {message.attempts} · <Timestamp value={message.created_at} /></p>
              <p class="text-caption text-muted-foreground">Requested delivery: {message.delivery_timing === "immediate" ? "During the current turn" : "After the current turn"}</p>
              {#if message.timing_fallback_reason === "receiver_capability_missing"}<p class="text-caption text-warning-muted-foreground">Waiting for a receiver update; immediate delivery is not available yet.</p>{/if}
              {#if (message.event_count ?? 1) > 1}<p class="text-caption text-muted-foreground">{message.event_count} grouped events · first <Timestamp value={message.event_first_at ?? message.created_at} /> · last <Timestamp value={message.event_last_at ?? message.created_at} /></p>{/if}
              {#if message.kind === "digest"}<a data-sveltekit-reload class="text-caption underline" href={retained(message.id)}>View retained originals</a>{/if}
              {#if message.digest_id}<p class="text-caption text-muted-foreground">Retained original · <a data-sveltekit-reload class="underline" href={retained(message.digest_id)}>digest and originals</a> · presentation is not a read receipt</p>{/if}
              {#if message.superseded_by_id}<p class="text-caption text-muted-foreground">Superseded by <a data-sveltekit-reload class="underline" href={retained(message.superseded_by_id)}>{message.superseded_by_id}</a> · original retained</p>{/if}
            </div>
            <div class="flex shrink-0 flex-col items-end gap-1">
              <Badge variant={statusVariant(message.status)}>{message.status}</Badge>
              {#if message.work_kind || message.kind === "request" || message.kind === "schedule"}<span class="text-caption text-muted-foreground">Task: {message.task_result_status ?? "unknown"} · agent report</span>{/if}
            </div>
          </div>
          {#if message.kind === "presence_notice"}<p class="text-caption text-muted-foreground">Recipient returned · informational · only for the sender’s current session · no reply required</p>{/if}
          {#if message.last_error_code}<p class="text-caption text-destructive">{message.last_error_code}</p>{/if}
          {#if revealed?.messageId === message.id}
            <div class="rounded-md border border-warning/25 bg-warning-muted p-3">
              <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words text-body-sm">{revealed.content}</pre>
              <Button class="mt-2" size="sm" variant="outline" onclick={clearReveal}>Close content</Button>
            </div>
          {/if}
          {#if canReveal || canMutate}
            <div class="flex flex-wrap gap-2 pt-1">
              {#if canReveal}<Button size="sm" variant="outline" disabled={busyMessage !== null} onclick={() => (revealTarget = message)}>{busyMessage === message.id ? "Revealing…" : "Reveal content"}</Button>{/if}
              {#if needsFreshStart(message)}<Button size="sm" variant="outline" onclick={() => { freshReason = ""; freshTarget = message; }}>Approve one fresh start</Button>{/if}
              {#if canRedrive(message)}<Button size="sm" variant="outline" disabled={$redrive.isPending || !enabled} onclick={() => (redriveTarget = message)}>Redrive</Button>{/if}
            </div>
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</section>

<ConfirmDialog
  open={revealTarget !== null}
  onClose={() => (revealTarget = null)}
  title="Reveal message content?"
  description={revealTarget ? `Show the decrypted content of message ${revealTarget.id.slice(0, 8)}. This action is audited.` : ""}
  confirmLabel="Reveal content"
  onConfirm={() => { if (revealTarget) void reveal(revealTarget); }}
/>
<ConfirmDialog
  open={redriveTarget !== null}
  onClose={() => (redriveTarget = null)}
  title="Redrive this message?"
  description={redriveTarget ? `Create an explicit redrive of ${redriveTarget.id.slice(0, 8)}. The original remains terminal for audit.` : ""}
  confirmLabel="Redrive"
  busy={$redrive.isPending}
  onConfirm={() => { if (redriveTarget) void redriveMessage(redriveTarget); }}
/>
<ReasonDialog
  open={freshTarget !== null}
  title="Approve one fresh start"
  description="Approve one replacement session for this work only."
  label="Why is a fresh start authorized?"
  bind:value={freshReason}
  onClose={() => (freshTarget = null)}
  confirmLabel="Approve"
  onConfirm={(reason) => { if (freshTarget) void approveFresh(freshTarget, reason); }}
/>
