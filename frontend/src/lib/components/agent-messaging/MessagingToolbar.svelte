<script lang="ts">
  /** The one control row of Messages: a view switch, the delivery log, and the filters of the current view. */
  import SegmentedControl from "$lib/components/page/SegmentedControl.svelte";
  import { Toolbar } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "$lib/components/ui/select";
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
</script>

<Toolbar>
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
      <Select
        type="single"
        value={model.conversationStatus}
        onValueChange={(value: unknown) => {
          if (CONVERSATION_STATUSES.some((option) => option.value === value)) model.conversationStatus = value as ConversationStatusFilter;
        }}
      >
        <SelectTrigger class="w-full sm:w-44" aria-label="Conversation status"><SelectValue placeholder="Conversation status" /></SelectTrigger>
        <SelectContent>
          {#each CONVERSATION_STATUSES as option (option.value)}<SelectItem value={option.value} label={option.label}>{option.label}</SelectItem>{/each}
        </SelectContent>
      </Select>
    {:else if model.view === "deliveries"}
      <Select
        type="single"
        value={model.messageStatus}
        onValueChange={(value: unknown) => {
          if (MESSAGE_STATUSES.includes(value as MessageStatusFilter)) model.messageStatus = value as MessageStatusFilter;
        }}
      >
        <SelectTrigger class="w-full sm:w-44" aria-label="Delivery status"><SelectValue placeholder="Delivery status" /></SelectTrigger>
        <SelectContent>
          {#each MESSAGE_STATUSES as status (status)}
            <SelectItem value={status} label={status === "all" ? "All deliveries" : status}><span class="capitalize">{status === "all" ? "All deliveries" : status}</span></SelectItem>
          {/each}
        </SelectContent>
      </Select>
      <div class="min-w-0 sm:w-72">
        <Input
          aria-label="Filter deliveries by conversation UUID"
          placeholder="Conversation UUID"
          bind:value={model.conversationId}
          class={model.conversationId.trim() !== "" && !model.validConversationId ? "border-destructive" : undefined}
        />
        {#if model.conversationId.trim() !== "" && !model.validConversationId}
          <p class="mt-1 text-caption text-destructive">Enter a complete conversation UUID.</p>
        {/if}
      </div>
    {/if}
  {/snippet}
  {#snippet actions()}
    {#if showLimit}
      <Select
        type="single"
        value={String(model.limit)}
        onValueChange={(value: unknown) => {
          const next = Number(value);
          if ((LIMITS as readonly number[]).includes(next)) model.limit = next;
        }}
      >
        <SelectTrigger class="w-28" aria-label="Result limit"><SelectValue /></SelectTrigger>
        <SelectContent>
          {#each LIMITS as size (size)}<SelectItem value={String(size)} label={String(size)}>{size}</SelectItem>{/each}
        </SelectContent>
      </Select>
    {/if}
  {/snippet}
</Toolbar>
