<script lang="ts">
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { writable } from "svelte/store";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import MessageSquareShare from "@lucide/svelte/icons/message-square-share";
  import { toast } from "svelte-sonner";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import LogToolbar from "$lib/components/logs/LogToolbar.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Input } from "$lib/components/ui/input";
  import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
  } from "$lib/components/ui/select";
  import { Switch } from "$lib/components/ui/switch";
  import { authStore } from "$lib/stores/auth";
  import { formatBytes, relativeTime } from "$lib/utils/format";
  import {
    agentAddressAliasMutation,
    agentAddressEnabledMutation,
    agentAddressIneligibleReasonLabel,
    agentAddressToggleDisabled,
    agentConversationCancelMutation,
    agentMessageRedriveMutation,
    agentMessagingAddressesQuery,
    agentMessagingConversationsQuery,
    agentMessagingKeys,
    agentMessagingMessagesQuery,
    agentMessagingStateQuery,
    revealAgentMessage,
    type AgentAdminAddress,
    type AgentAddress,
    type AgentConversation,
    type AgentMessageMetadata,
  } from "$lib/api/agentMessaging";

  const CONVERSATION_STATUSES = [
    { value: "all", label: "All conversations" },
    { value: "open", label: "Open conversations" },
    { value: "canceled", label: "Canceled conversations" },
  ] as const;
  const MESSAGE_STATUSES = [
    "all",
    "queued",
    "leased",
    "accepted",
    "completed",
    "dead",
    "ambiguous",
    "expired",
    "canceled",
  ] as const;
  const LIMITS = [50, 100, 250, 500] as const;
  type ConversationStatusFilter = (typeof CONVERSATION_STATUSES)[number]["value"];
  type MessageStatusFilter = (typeof MESSAGE_STATUSES)[number];

  function initialConversationStatus(): ConversationStatusFilter {
    const value = page.url.searchParams.get("conversation_status");
    return CONVERSATION_STATUSES.some((option) => option.value === value)
      ? (value as ConversationStatusFilter)
      : "all";
  }

  function initialMessageStatus(): MessageStatusFilter {
    const value = page.url.searchParams.get("message_status");
    return MESSAGE_STATUSES.includes(value as MessageStatusFilter)
      ? (value as MessageStatusFilter)
      : "all";
  }

  function initialLimit(): number {
    const value = Number(page.url.searchParams.get("limit"));
    return (LIMITS as readonly number[]).includes(value) ? value : 100;
  }

  function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  }

  let conversationStatus = $state<ConversationStatusFilter>(initialConversationStatus());
  let messageStatus = $state<MessageStatusFilter>(initialMessageStatus());
  let messageConversationId = $state(page.url.searchParams.get("conversation_id") ?? "");
  let limit = $state(initialLimit());
  const validConversationId = $derived.by(() => {
    const value = messageConversationId.trim();
    return isUuid(value) ? value : undefined;
  });
  const messageConversationFilterValid = $derived(
    messageConversationId.trim() === "" || validConversationId !== undefined,
  );

  $effect(() => {
    const url = new URL(page.url);
    const setOrDelete = (key: string, value: string, fallback = "") => {
      if (value === fallback) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    };
    setOrDelete("conversation_status", conversationStatus, "all");
    setOrDelete("message_status", messageStatus, "all");
    setOrDelete("conversation_id", messageConversationId.trim());
    setOrDelete("limit", String(limit), "100");
    if (url.search !== page.url.search) {
      void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
    }
  });

  const queryClient = useQueryClient();
  const stateQuery = agentMessagingStateQuery();
  const addresses = agentMessagingAddressesQuery();
  // eslint-disable-next-line svelte/no-unused-svelte-ignore
  // svelte-ignore state_referenced_locally
  const conversationOptions = writable(
    agentMessagingConversationsQuery({
      status: conversationStatus === "all" ? undefined : conversationStatus,
      limit,
    }),
  );
  $effect(() => {
    conversationOptions.set(
      agentMessagingConversationsQuery({
        status: conversationStatus === "all" ? undefined : conversationStatus,
        limit,
      }),
    );
  });
  const conversations = createQuery<{ conversations: AgentConversation[] }, Error>(
    conversationOptions,
  );
  // eslint-disable-next-line svelte/no-unused-svelte-ignore
  // svelte-ignore state_referenced_locally
  const messageOptions = writable(
    agentMessagingMessagesQuery({
      conversationId: validConversationId,
      status: messageStatus === "all" ? undefined : messageStatus,
      limit,
      enabled: messageConversationFilterValid,
    }),
  );
  $effect(() => {
    messageOptions.set(
      agentMessagingMessagesQuery({
        conversationId: validConversationId,
        status: messageStatus === "all" ? undefined : messageStatus,
        limit,
        enabled: messageConversationFilterValid,
      }),
    );
  });
  const messages = createQuery<{ messages: AgentMessageMetadata[] }, Error>(messageOptions);
  const addressEnabled = agentAddressEnabledMutation();
  const addressAlias = agentAddressAliasMutation();
  const cancelConversation = agentConversationCancelMutation();
  const redrive = agentMessageRedriveMutation();
  let revealed = $state<{ messageId: string; content: string } | null>(null);
  let busyMessage = $state<string | null>(null);
  const revealGuard = { generation: 0 };

  const accessLevel = $derived(
    ($authStore.user as (typeof $authStore.user & { access_level?: string }) | null)?.access_level,
  );
  const canMutate = $derived(
    [...$authStore.roles, accessLevel ?? ""]
      .map((role) => role.trim().toLowerCase())
      .some((role) => role === "owner" || role === "admin"),
  );
  const roleSignature = $derived(
    [...$authStore.roles, accessLevel ?? ""]
      .map((role) => role.trim().toLowerCase())
      .sort()
      .join("\u0000"),
  );
  const revealFilterSignature = $derived(
    [conversationStatus, messageStatus, messageConversationId.trim(), String(limit)].join("\u0000"),
  );
  const pending = $derived(
    ($stateQuery.data?.messages.queued ?? 0) +
      ($stateQuery.data?.messages.leased ?? 0) +
      ($stateQuery.data?.messages.accepted ?? 0),
  );

  $effect(() => {
    void roleSignature;
    clearReveal();
  });

  $effect(() => {
    void revealFilterSignature;
    clearReveal();
  });

  $effect(() => {
    void $messages.data;
    clearReveal();
  });

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: agentMessagingKeys.all });
    toast.success("Agent Messaging state refreshed");
  }

  async function setAddress(address: AgentAdminAddress, enabled: boolean) {
    if (enabled && addressEnableBlocked(address)) {
      toast.error(agentAddressIneligibleReasonLabel(address.ineligible_reason) ?? "Address is not eligible");
      return;
    }
    try {
      await $addressEnabled.mutateAsync({ id: address.id, enabled });
      toast.success(enabled ? "Address enabled" : "Address disabled; related pending work canceled");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Address update failed");
    }
  }

  async function editAlias(address: AgentAdminAddress) {
    const next = prompt("Agent alias (lowercase letters, digits, dot, underscore or dash). Empty clears it.", address.alias?.replace(/^agent:/, "") ?? "");
    if (next === null) return;
    try {
      await $addressAlias.mutateAsync({ id: address.id, alias: next.trim() || null });
      toast.success(next.trim() ? "Alias updated" : "Alias cleared");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Alias update failed");
    }
  }

  async function cancel(item: AgentConversation) {
    if (!confirm(`Cancel conversation ${item.id.slice(0, 8)} and all undelivered work?`)) return;
    try {
      await $cancelConversation.mutateAsync({ id: item.id, reason: "Canceled from Agent Messaging operations" });
      toast.success("Conversation canceled");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Conversation cancellation failed");
    }
  }

  async function reveal(item: AgentMessageMetadata) {
    if (!confirm(`Reveal decrypted content for message ${item.id.slice(0, 8)}? This action is audited.`)) return;
    const generation = ++revealGuard.generation;
    revealed = null;
    busyMessage = item.id;
    try {
      const content = await revealAgentMessage(item.id);
      const stillListed = ($messages.data?.messages ?? []).some((message) => message.id === item.id);
      if (generation === revealGuard.generation && canMutate && stillListed) {
        revealed = { messageId: item.id, content };
      }
    } catch (error) {
      if (generation === revealGuard.generation) {
        toast.error(error instanceof Error ? error.message : "Message reveal failed");
      }
    } finally {
      if (generation === revealGuard.generation) busyMessage = null;
    }
  }

  function clearReveal() {
    revealGuard.generation += 1;
    revealed = null;
    busyMessage = null;
  }

  async function redriveMessage(item: AgentMessageMetadata) {
    if (!confirm(`Create an explicit redrive of ${item.id.slice(0, 8)}? The original remains terminal for audit.`)) return;
    try {
      await $redrive.mutateAsync(item.id);
      toast.success("Message redriven as a new ordered delivery");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Redrive failed");
    }
  }

  function routeLabel(address: AgentAddress | undefined): string {
    if (!address) return "unknown";
    return address.alias ?? address.address;
  }

  function addressEnableBlocked(address: AgentAdminAddress): boolean {
    return agentAddressToggleDisabled(address);
  }

  function statusTone(status: string): string {
    if (status === "dead" || status === "ambiguous") return "border-destructive/40 bg-destructive/10 text-destructive";
    if (status === "leased" || status === "accepted") return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    return "border-border bg-muted/40 text-muted-foreground";
  }
</script>

<PageHeader
  title="Agent Messaging"
  subtitle="Operate direct Codex ↔ Claude conversations, stable addresses, relays, retries, and audited content reveal."
>
  {#snippet actions()}
    <Button variant="outline" onclick={refresh}>
      <RefreshCw class="h-4 w-4" /> Refresh
    </Button>
  {/snippet}
</PageHeader>

{#if $stateQuery.data && !$stateQuery.data.enabled}
  <div class="mb-4 rounded-xl border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
    Agent Messaging is off. Discovery, send, reply, wake, resume, and relay polling are blocked; retained metadata and audit history remain readable.
  </div>
{/if}

<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
  {#each [
    ["Addresses", $stateQuery.data?.addresses ?? 0],
    ["Live", $stateQuery.data?.live_addresses ?? 0],
    ["Relays", $stateQuery.data?.relays ?? 0],
    ["Open conversations", $stateQuery.data?.open_conversations ?? 0],
    ["Pending", pending],
  ] as metric (metric[0])}
    <Card.Root>
      <Card.Content class="p-4">
        <p class="text-xs text-muted-foreground">{metric[0]}</p>
        <p class="mt-1 text-2xl font-semibold tabular-nums">{metric[1]}</p>
      </Card.Content>
    </Card.Root>
  {/each}
</div>

<Card.Root class="mt-4">
  <Card.Header>
    <Card.Title class="flex items-center gap-2 text-base"><MessageSquareShare class="h-4 w-4" /> Direction matrix</Card.Title>
    <Card.Description>All four engine paths use the same ordered at-least-once contract.</Card.Description>
  </Card.Header>
  <Card.Content>
    <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
      {#each $stateQuery.data?.directions ?? [] as direction (`${direction.source_engine}-${direction.target_engine}`)}
        <div class="rounded-md border bg-muted/20 p-3">
          <p class="text-sm font-medium capitalize">{direction.source_engine} → {direction.target_engine}</p>
          <p class="mt-1 text-xs text-muted-foreground">
            {direction.total} total · {direction.pending} pending · {direction.completed} completed
          </p>
          {#if direction.dead || direction.ambiguous}
            <p class="mt-1 text-xs text-destructive">{direction.dead} dead · {direction.ambiguous} ambiguous</p>
          {/if}
        </div>
      {/each}
    </div>
  </Card.Content>
</Card.Root>

<LogToolbar class="mt-4">
  <Select
    type="single"
    value={conversationStatus}
    onValueChange={(value: unknown) => {
      if (CONVERSATION_STATUSES.some((option) => option.value === value)) {
        conversationStatus = value as ConversationStatusFilter;
      }
    }}>
    <SelectTrigger class="h-9 w-full sm:w-[190px]" aria-label="Conversation status">
      <SelectValue placeholder="Conversation status" />
    </SelectTrigger>
    <SelectContent>
      {#each CONVERSATION_STATUSES as option (option.value)}
        <SelectItem value={option.value} label={option.label}>{option.label}</SelectItem>
      {/each}
    </SelectContent>
  </Select>

  <Select
    type="single"
    value={messageStatus}
    onValueChange={(value: unknown) => {
      if (MESSAGE_STATUSES.includes(value as MessageStatusFilter)) {
        messageStatus = value as MessageStatusFilter;
      }
    }}>
    <SelectTrigger class="h-9 w-full sm:w-[175px]" aria-label="Delivery status">
      <SelectValue placeholder="Delivery status" />
    </SelectTrigger>
    <SelectContent>
      {#each MESSAGE_STATUSES as status (status)}
        <SelectItem value={status} label={status === "all" ? "All deliveries" : status}>
          <span class="capitalize">{status === "all" ? "All deliveries" : status}</span>
        </SelectItem>
      {/each}
    </SelectContent>
  </Select>

  <div class="min-w-0 flex-1 sm:min-w-[260px]">
    <Input
      aria-label="Filter deliveries by conversation UUID"
      placeholder="Conversation UUID"
      bind:value={messageConversationId}
      class={messageConversationId.trim() !== "" && !validConversationId
        ? "border-destructive"
        : undefined}
    />
    {#if messageConversationId.trim() !== "" && !validConversationId}
      <p class="mt-1 text-xs text-destructive">Enter a complete conversation UUID.</p>
    {/if}
  </div>

  <Select
    type="single"
    value={String(limit)}
    onValueChange={(value: unknown) => {
      const next = Number(value);
      if ((LIMITS as readonly number[]).includes(next)) limit = next;
    }}>
    <SelectTrigger class="h-9 w-full sm:w-[92px]" aria-label="Result limit">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {#each LIMITS as size (size)}
        <SelectItem value={String(size)} label={String(size)}>{size}</SelectItem>
      {/each}
    </SelectContent>
  </Select>
</LogToolbar>

<Card.Root class="mt-4">
  <Card.Header>
    <Card.Title class="text-base">Addresses</Card.Title>
    <Card.Description>Created automatically from eligible secure managed sessions. Aliases are optional; raw stable addresses always work.</Card.Description>
  </Card.Header>
  <Card.Content class="space-y-2">
    {#each $addresses.data?.addresses ?? [] as address (address.id)}
      {@const ineligibleLabel = agentAddressIneligibleReasonLabel(address.ineligible_reason)}
      <div class="grid gap-3 rounded-md border p-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] lg:items-center">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <strong class="font-mono text-sm">{routeLabel(address)}</strong>
            <span class="rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] uppercase">{address.engine}</span>
            <span class="rounded-full border px-2 py-0.5 text-[10px] uppercase {address.readiness === 'live' ? 'border-emerald-500/40 text-emerald-600' : 'text-muted-foreground'}">{address.readiness}</span>
            {#if !address.eligible}
              <span class="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase text-amber-700 dark:text-amber-300">Ineligible</span>
            {/if}
          </div>
          <p class="mt-1 truncate text-xs text-muted-foreground">{address.fqdn ?? `Host #${address.host_id}`} · {address.username} · {address.cwd}</p>
        </div>
        <div class="text-xs text-muted-foreground">
          <p>{address.queue_depth ?? 0} queued · continuity {address.continuity}</p>
          <p>{address.host_status} · {address.host_secure ? "secure" : "insecure"} · {address.host_engines.join(" + ") || "no engines"}</p>
          <p>{address.last_seen_at ? `Seen ${relativeTime(address.last_seen_at)}` : "Never seen"}</p>
          {#if ineligibleLabel}<p class="text-amber-700 dark:text-amber-300">{ineligibleLabel}</p>{/if}
        </div>
        <div class="flex items-center justify-end gap-2">
          {#if canMutate}<Button size="sm" variant="outline" onclick={() => editAlias(address)}>Alias</Button>{/if}
          <Switch
            checked={address.enabled}
            disabled={!canMutate || $addressEnabled.isPending || addressEnableBlocked(address)}
            title={!address.enabled && !address.eligible ? (ineligibleLabel ?? undefined) : undefined}
            aria-label={address.enabled
              ? `Disable ${routeLabel(address)}`
              : address.eligible
                ? `Enable ${routeLabel(address)}`
                : `Cannot enable ${routeLabel(address)}: ${ineligibleLabel ?? "address is not eligible"}`}
            onCheckedChange={(enabled) => setAddress(address, enabled)}
          />
        </div>
      </div>
    {:else}
      <p class="text-sm text-muted-foreground">No agent addresses observed yet.</p>
    {/each}
  </Card.Content>
</Card.Root>

<div class="mt-4 grid items-start gap-4 xl:grid-cols-2">
  <Card.Root>
    <Card.Header>
      <Card.Title class="text-base">Conversations</Card.Title>
      <Card.Description>Open until a participant, administrator, or the master switch cancels them.</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-2">
      {#each $conversations.data?.conversations ?? [] as conversation (conversation.id)}
        <div class="rounded-md border p-3">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="truncate text-sm font-medium">{routeLabel(conversation.address_a)} ↔ {routeLabel(conversation.address_b)}</p>
              <p class="text-xs text-muted-foreground">{conversation.id.slice(0, 8)} · {conversation.next_sequence - 1} messages · {relativeTime(conversation.last_activity_at)}</p>
            </div>
            <span class="rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] uppercase">{conversation.status}</span>
          </div>
          {#if canMutate && conversation.status === "open"}
            <div class="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onclick={() => (messageConversationId = conversation.id)}>Deliveries</Button>
              <Button size="sm" variant="outline" onclick={() => cancel(conversation)}>Cancel</Button>
            </div>
          {:else}
            <Button class="mt-2" size="sm" variant="outline" onclick={() => (messageConversationId = conversation.id)}>Deliveries</Button>
          {/if}
        </div>
      {:else}
        <p class="text-sm text-muted-foreground">No conversations.</p>
      {/each}
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title class="text-base">Deliveries</Card.Title>
      <Card.Description>Metadata only by default. Owner/admin content reveal is explicit and audited.</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-2">
      {#if !messageConversationFilterValid}
        <p class="text-sm text-muted-foreground">Enter a complete conversation UUID to load deliveries.</p>
      {:else}
        {#each $messages.data?.messages ?? [] as message (message.id)}
          <div class="rounded-md border p-3">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="truncate text-sm font-medium">{routeLabel(message.sender)} → {routeLabel(message.target)}</p>
                <p class="text-xs text-muted-foreground">#{message.sequence} · {message.kind} · {formatBytes(message.content_bytes)} · attempt {message.attempts} · {relativeTime(message.created_at)}</p>
              </div>
              <span class="rounded-full border px-2 py-0.5 text-[10px] uppercase {statusTone(message.status)}">{message.status}</span>
            </div>
            {#if message.last_error_code}<p class="mt-1 text-xs text-destructive">{message.last_error_code}</p>{/if}
            {#if revealed?.messageId === message.id}
              <div class="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{revealed.content}</pre>
                <Button class="mt-2" size="sm" variant="outline" onclick={clearReveal}>Close content</Button>
              </div>
            {/if}
            {#if canMutate}
              <div class="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={busyMessage !== null} onclick={() => reveal(message)}>{busyMessage === message.id ? "Revealing…" : "Reveal content"}</Button>
                {#if message.status === "dead" || message.status === "ambiguous"}
                  <Button size="sm" variant="outline" disabled={$redrive.isPending || !$stateQuery.data?.enabled} onclick={() => redriveMessage(message)}>Redrive</Button>
                {/if}
              </div>
            {/if}
          </div>
        {:else}
          <p class="text-sm text-muted-foreground">No deliveries.</p>
        {/each}
      {/if}
    </Card.Content>
  </Card.Root>
</div>
