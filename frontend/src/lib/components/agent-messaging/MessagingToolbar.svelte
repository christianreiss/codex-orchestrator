<script lang="ts">
  /** The one control row of Messages: a view switch, the delivery log, and the filters of the current view. */
  import SegmentedControl from "$lib/components/page/SegmentedControl.svelte";
  import { Toolbar } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Select, SelectContent, SelectItem, SelectTrigger } from "$lib/components/ui/select";
  import {
    CONVERSATION_STATUSES,
    LIMITS,
    MESSAGE_STATUSES,
    VIEWS,
    type ConversationStatusFilter,
    type MessageStatusFilter,
    type MessagingFilters,
    type MessagingView,
  } from "./messaging-filters.svelte";

  let { model }: { model: MessagingFilters } = $props();

  const VIEW_OPTIONS = [
    { value: "conversations", label: "Conversations" },
    { value: "addresses", label: "Addresses", hint: "Every agent that can be messaged" },
    { value: "groups", label: "Groups", hint: "Opt-in audiences and subscriptions" },
  ];
  const segment = $derived(VIEW_OPTIONS.some((option) => option.value === model.view) ? model.view : "");
  const showLimit = $derived(model.view !== "groups");
  const conversationLabel = $derived(CONVERSATION_STATUSES.find((option) => option.value === model.conversationStatus)?.label ?? "All conversations");
  const messageLabel = $derived(model.messageStatus === "all" ? "All deliveries" : model.messageStatus.charAt(0).toUpperCase() + model.messageStatus.slice(1));
</script>

<Toolbar class="items-end">
  {#snippet filters()}
    <SegmentedControl
      options={VIEW_OPTIONS}
      value={segment}
      label="Messages view"
      onChange={(value) => { if (VIEWS.includes(value as MessagingView)) model.view = value as MessagingView; }}
    />
    <Button
      size="sm"
      variant={model.view === "deliveries" ? "secondary" : "ghost"}
      aria-pressed={model.view === "deliveries"}
      title="Raw per-message delivery status"
      onclick={() => (model.view = model.view === "deliveries" ? "conversations" : "deliveries")}
    >Delivery log</Button>

    {#if model.view === "conversations"}
      <div class="flex w-full flex-col gap-1 sm:w-44">
      <Label for="message-conversation-status">Conversation status</Label>
      <Select
        type="single"
        value={model.conversationStatus}
        onValueChange={(value: unknown) => {
          if (CONVERSATION_STATUSES.some((option) => option.value === value)) model.conversationStatus = value as ConversationStatusFilter;
        }}
      >
        <SelectTrigger id="message-conversation-status" aria-label="Conversation status">{conversationLabel}</SelectTrigger>
        <SelectContent>
          {#each CONVERSATION_STATUSES as option (option.value)}<SelectItem value={option.value} label={option.label}>{option.label}</SelectItem>{/each}
        </SelectContent>
      </Select>
      </div>
    {:else if model.view === "deliveries"}
      <div class="flex w-full flex-col gap-1 sm:w-44">
      <Label for="message-delivery-status">Delivery status</Label>
      <Select
        type="single"
        value={model.messageStatus}
        onValueChange={(value: unknown) => {
          if (MESSAGE_STATUSES.includes(value as MessageStatusFilter)) model.messageStatus = value as MessageStatusFilter;
        }}
      >
        <SelectTrigger id="message-delivery-status" aria-label="Delivery status">{messageLabel}</SelectTrigger>
        <SelectContent>
          {#each MESSAGE_STATUSES as status (status)}
            <SelectItem value={status} label={status === "all" ? "All deliveries" : status}><span class="capitalize">{status === "all" ? "All deliveries" : status}</span></SelectItem>
          {/each}
        </SelectContent>
      </Select>
      </div>
      <div class="flex min-w-0 flex-col gap-1 sm:w-72">
        <Label for="message-conversation-id">Conversation UUID</Label>
        <Input
          id="message-conversation-id"
          aria-label="Filter deliveries by conversation UUID"
          aria-invalid={model.conversationId.trim() !== "" && !model.validConversationId}
          aria-describedby={model.conversationId.trim() !== "" && !model.validConversationId ? "message-conversation-id-error" : undefined}
          placeholder="Conversation UUID"
          bind:value={model.conversationId}
          class={model.conversationId.trim() !== "" && !model.validConversationId ? "border-destructive" : undefined}
        />
        {#if model.conversationId.trim() !== "" && !model.validConversationId}
          <p id="message-conversation-id-error" class="mt-1 text-caption text-destructive">Enter a complete conversation UUID.</p>
        {/if}
      </div>
    {/if}
  {/snippet}
  {#snippet actions()}
    {#if showLimit}
      <div class="flex flex-col gap-1">
      <Label for="message-result-limit">Result limit</Label>
      <Select
        type="single"
        value={String(model.limit)}
        onValueChange={(value: unknown) => {
          const next = Number(value);
          if ((LIMITS as readonly number[]).includes(next)) model.limit = next;
        }}
      >
        <SelectTrigger id="message-result-limit" class="w-28" aria-label="Result limit">{model.limit}</SelectTrigger>
        <SelectContent>
          {#each LIMITS as size (size)}<SelectItem value={String(size)} label={String(size)}>{size}</SelectItem>{/each}
        </SelectContent>
      </Select>
      </div>
    {/if}
  {/snippet}
</Toolbar>
