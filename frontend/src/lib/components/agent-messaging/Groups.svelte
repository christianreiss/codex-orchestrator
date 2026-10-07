<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { writable } from "svelte/store";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import Users from "@lucide/svelte/icons/users";
  import Send from "@lucide/svelte/icons/send";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { authStore } from "$lib/stores/auth";
  import { relativeTime } from "$lib/utils/format";
  import {
    agentGroupCreateMutation, agentGroupOptions, agentGroupsOptions,
    agentPublishMutation, agentSubscriptionsOptions, SERVER_TOPIC, MAX_PUBLICATION_CONTENT_BYTES,
    type AgentPublication, type AgentPublishInput,
  } from "$lib/api/agentGroups";
  import { agentMessagingAddressesQuery } from "$lib/api/agentMessaging";

  let { enabled = false }: { enabled?: boolean } = $props();
  const groups = createQuery(agentGroupsOptions());
  const subscriptions = createQuery(agentSubscriptionsOptions());
  const addresses = agentMessagingAddressesQuery();
  const selectedSlug = $derived(page.url.searchParams.get("group") ?? $groups.data?.groups[0]?.slug ?? "");
  const options = writable(agentGroupOptions(""));
  $effect(() => { options.set(agentGroupOptions(selectedSlug)); });
  const detail = createQuery(options);
  const createGroup = agentGroupCreateMutation();
  const publish = agentPublishMutation();
  const canManage = $derived($authStore.can("agent_messaging.manage"));
  const canMessageAgent = $derived($authStore.can("agent_portal.read") && $authStore.can("agent_portal.manage"));
  let slug = $state("");
  let title = $state("");
  let description = $state("");
  let createOpen = $state(false);
  let content = $state("");
  let recipientMode = $state("group");
  let subscriptionSearch = $state("");
  let receipt = $state<AgentPublication | null>(null);
  let sendError = $state<string | null>(null);
  let pendingAttempt = $state<AgentPublishInput | null>(null);
  const validSlug = $derived(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug.trim()));
  const topic = $derived(recipientMode === "server" ? SERVER_TOPIC : selectedSlug ? `group:${selectedSlug}` : "");
  const maxContentBytes = $derived($groups.data?.max_publication_content_bytes ?? MAX_PUBLICATION_CONTENT_BYTES);
  const contentBytes = $derived(new TextEncoder().encode(content.trim()).byteLength);
  const contentTooLarge = $derived(contentBytes > maxContentBytes);
  const filteredSubscriptions = $derived(($subscriptions.data?.subscriptions ?? []).filter((item) => {
    const text = [item.topic, item.subscriber_address, item.subscriber_engine, addressLabel(item.subscriber_address_id), topicLabel(item.topic)].join(" ").toLowerCase();
    return text.includes(subscriptionSearch.trim().toLowerCase());
  }));
  const draftChanged = $derived(pendingAttempt !== null && (pendingAttempt.topic !== topic || pendingAttempt.content !== content.trim()));
  const composeUnavailable = $derived(!enabled || !topic || (recipientMode === "group" && (!$detail.data || $detail.data.group.slug !== selectedSlug || $detail.isError || $groups.isError)));

  function selectGroup(value: string) {
    const url = new URL(page.url);
    url.searchParams.set("group", value);
    void goto(url, { keepFocus: true, noScroll: true });
  }
  function addressLabel(id: string): string {
    const peer = $addresses.data?.addresses.find((item) => item.id === id);
    if (id === SERVER_TOPIC.slice(6)) return "Server";
    return peer?.alias ?? peer?.address ?? `agent:${id}`;
  }
  function topicLabel(value: string): string {
    if (value === SERVER_TOPIC) return "Server updates";
    if (value.startsWith("group:")) {
      const group = $groups.data?.groups.find((item) => item.topic === value);
      return group?.title ?? value;
    }
    return value.startsWith("agent:") ? addressLabel(value.slice(6)) : value;
  }
  async function saveGroup(event: SubmitEvent) {
    event.preventDefault();
    if (!canManage || !enabled || !validSlug || !title.trim()) return;
    try {
      const result = await $createGroup.mutateAsync({ slug: slug.trim(), title: title.trim(), ...(description.trim() ? { description: description.trim() } : {}) });
      selectGroup(result.group.slug);
      slug = ""; title = ""; description = ""; createOpen = false;
      toast.success(result.created ? "Group created; agents can subscribe" : "Group already exists");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not create group"); }
  }
  async function send(event: SubmitEvent) {
    event.preventDefault();
    if (!canManage || composeUnavailable || !content.trim() || contentTooLarge || $publish.isPending) return;
    if (!pendingAttempt || draftChanged) pendingAttempt = { topic, content: content.trim(), client_message_id: crypto.randomUUID() };
    const attempt = pendingAttempt;
    sendError = null;
    try {
      const result = await $publish.mutateAsync(attempt);
      receipt = result;
      // An edit made while a request is in flight belongs to the next message.
      if (topic === attempt.topic && content.trim() === attempt.content) content = "";
      pendingAttempt = null;
      toast.success(`${result.recipient_count} ${result.recipient_count === 1 ? "recipient" : "recipients"} queued`);
    } catch (error) { sendError = error instanceof Error ? error.message : "Publish failed"; }
  }
</script>

<section aria-label="Groups and subscriptions" class="space-y-5">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div><h2 class="flex items-center gap-2 font-semibold"><Users class="h-4 w-4" /> Groups &amp; subscriptions</h2><p class="mt-1 text-sm text-muted-foreground">Persistent audiences across Codex, Claude, and Grok. Agents choose which groups and individual agents they follow.</p></div>
    {#if canManage}<Button variant="outline" disabled={!enabled} aria-expanded={createOpen} onclick={() => createOpen = !createOpen}>{createOpen ? "Close new group" : "New group"}</Button>{/if}
  </div>

  {#if createOpen && canManage}
    <form onsubmit={saveGroup} class="grid gap-3 rounded-lg border p-4 sm:grid-cols-2" aria-label="Create group">
      <label class="text-sm">Group slug<Input class="mt-1" bind:value={slug} maxlength={64} placeholder="release-review" required /></label>
      <label class="text-sm">Group title<Input class="mt-1" bind:value={title} maxlength={120} placeholder="Release review" required /></label>
      <label class="text-sm sm:col-span-2">Description <span class="text-muted-foreground">(optional)</span><Input class="mt-1" bind:value={description} maxlength={1000} /></label>
      <p class="text-xs text-muted-foreground">Slugs use lowercase letters, digits, dot, underscore, or dash. Creating a group does not subscribe anyone.</p>
      <Button class="sm:justify-self-end" type="submit" disabled={!enabled || !validSlug || !title.trim() || $createGroup.isPending}>{$createGroup.isPending ? "Creating…" : "Create group"}</Button>
    </form>
  {/if}

  {#if $groups.isError}<p role="alert" class="text-sm text-destructive">Could not load groups: {$groups.error.message} <Button size="sm" variant="outline" onclick={() => $groups.refetch()}>Retry groups</Button></p>{/if}
  {#if $groups.isPending}<p class="text-sm text-muted-foreground">Loading groups…</p>
  {:else if !$groups.isError && !$groups.data?.groups.length}<p class="rounded-lg border p-4 text-sm text-muted-foreground">No groups yet. Create an audience, then agents can opt in.</p>{/if}

  <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
    {#each $groups.data?.groups ?? [] as group (group.id)}
      <button type="button" class="min-w-0 rounded-lg border p-4 text-left hover:bg-muted/40 {selectedSlug === group.slug ? 'border-primary bg-muted/30' : 'border-border'}" aria-pressed={selectedSlug === group.slug} onclick={() => selectGroup(group.slug)}>
        <div class="flex flex-wrap items-start justify-between gap-2"><span class="break-words font-semibold">{group.title}</span><span class="rounded-full border px-2 py-0.5 text-xs">{group.member_count} {group.member_count === 1 ? "subscriber" : "subscribers"}</span></div>
        <p class="mt-1 break-all font-mono text-xs text-muted-foreground">{group.topic}</p>
        {#if group.description}<p class="mt-2 break-words text-sm text-muted-foreground">{group.description}</p>{/if}
      </button>
    {/each}
  </div>

  <div class="grid items-start gap-4 lg:grid-cols-2">
    <section class="min-w-0 rounded-lg border p-4" aria-label="Group subscribers">
      <h3 class="font-semibold">{$detail.data?.group.title ?? "Group"} subscribers</h3>
      <p class="mt-1 text-xs text-muted-foreground">Membership belongs to each stable agent address. Reconnecting keeps the subscription.</p>
      {#if selectedSlug && $detail.isError}<p role="alert" class="mt-3 text-sm text-destructive">Could not load subscribers: {$detail.error.message}</p>
      {:else if selectedSlug && $detail.isPending}<p class="mt-3 text-sm text-muted-foreground">Loading subscribers…</p>
      {:else}
        <ul class="mt-3 divide-y divide-border">
          {#each $detail.data?.members ?? [] as member (member.address_id)}
            <li class="py-2"><p class="flex flex-wrap items-center gap-2"><span class="break-all text-sm font-medium">{member.alias ?? member.address}</span><span class="rounded border px-1.5 py-0.5 text-[10px] uppercase">{member.engine}</span></p><p class="mt-0.5 text-xs text-muted-foreground">Subscribed {relativeTime(member.joined_at)}</p></li>
          {:else}<li class="py-2 text-sm text-muted-foreground">{selectedSlug ? "No subscribers yet. Publications go only to agents who opt in." : "Select a group to inspect its audience."}</li>{/each}
        </ul>
      {/if}
    </section>

    {#if canManage}
      <section class="min-w-0 rounded-lg border p-4" aria-labelledby="publish-heading">
        <h3 id="publish-heading" class="flex items-center gap-2 font-semibold"><Send class="h-4 w-4" /> Publish from Server</h3>
        <p class="mt-1 text-xs text-muted-foreground">Each publication snapshots its subscribers and queues a separate ordered delivery per recipient.</p>
        <form onsubmit={send} class="mt-3 space-y-3">
          <label class="block text-sm">Audience
            <select aria-label="Publication audience" class="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm" bind:value={recipientMode} disabled={$publish.isPending}>
              <option value="group">Selected group{selectedSlug ? `: ${$detail.data?.group.title ?? selectedSlug}` : " (choose a group)"}</option>
              <option value="server">Agents following Server</option>
            </select>
          </label>
          <p class="break-all font-mono text-xs text-muted-foreground">{topic || "Choose a group above"}</p>
          <label class="block text-sm">Message to subscribers<Textarea class="mt-1" bind:value={content} placeholder="Share a scoped update…" maxlength={maxContentBytes} aria-describedby="publication-size" aria-invalid={contentTooLarge} rows={4} /></label>
          <p id="publication-size" class="text-xs" class:text-destructive={contentTooLarge} class:text-muted-foreground={!contentTooLarge}>{contentBytes.toLocaleString()} / {maxContentBytes.toLocaleString()} UTF-8 bytes{contentTooLarge ? " · Message exceeds the publication limit." : " · 24h delivery expiry"}</p>
          {#if sendError}<p role="alert" class="text-sm text-destructive">{sendError}</p><p class="text-xs text-muted-foreground">Retrying this unchanged draft reuses its receipt ID to prevent duplicate publications.</p>{/if}
          {#if !enabled}<p class="text-xs text-warning-muted-foreground">Agent Messaging is off. Sending resumes when the fleet switch is enabled.</p>{/if}
          <div class="flex flex-wrap items-center justify-end gap-2">{#if canMessageAgent}<a class="mr-auto text-xs text-primary underline underline-offset-2" href={`${base}/clients`}>Message one agent in Active Clients</a>{/if}<Button type="submit" disabled={composeUnavailable || !content.trim() || contentTooLarge || $publish.isPending}>{$publish.isPending ? "Publishing…" : sendError && !draftChanged ? "Retry publication" : "Publish to subscribers"}</Button></div>
        </form>
        {#if receipt}
          <div class="mt-4 rounded-md border bg-muted/25 p-3" role="status" aria-label="Publication receipt">
            <p class="text-sm font-medium">{receipt.recipient_count} {receipt.recipient_count === 1 ? "recipient" : "recipients"} queued{!receipt.created ? " · Existing publication" : ""}</p>
            <p class="mt-1 break-all font-mono text-xs text-muted-foreground">{receipt.publication_id}</p>
            <p class="mt-1 text-xs text-muted-foreground">{topicLabel(receipt.topic)} · {receipt.skipped.length} skipped · Queued means waiting for engine acceptance.</p>
            <details class="mt-2"><summary class="cursor-pointer text-xs font-medium">Recipient receipts</summary><ul class="mt-2 space-y-1 text-xs">
              {#each receipt.deliveries as delivery (delivery.address_id)}<li class="break-all">{addressLabel(delivery.address_id)} · queued · {delivery.message_id}</li>{/each}
              {#each receipt.skipped as skipped (skipped.address_id)}<li class="break-all text-warning-muted-foreground">{addressLabel(skipped.address_id)} · skipped: {skipped.reason}</li>{/each}
            </ul></details>
          </div>
        {/if}
      </section>
    {/if}
  </div>

  <section class="rounded-lg border p-4" aria-labelledby="subscriptions-heading">
    <div class="flex flex-wrap items-start justify-between gap-3"><div><h3 id="subscriptions-heading" class="font-semibold">Subscription directory</h3><p class="mt-1 text-xs text-muted-foreground">Group memberships, individual agent follows, and Server followers. Direct messages remain available without a subscription.</p></div><Input class="w-full sm:w-64" aria-label="Find subscriptions" bind:value={subscriptionSearch} placeholder="Group, agent, or engine…" /></div>
    {#if $subscriptions.isError}<p role="alert" class="mt-3 text-sm text-destructive">Could not load subscriptions: {$subscriptions.error.message}</p>
    {:else if $subscriptions.isPending}<p class="mt-3 text-sm text-muted-foreground">Loading subscriptions…</p>
    {:else}<ul class="mt-3 grid gap-x-6 divide-y divide-border sm:grid-cols-2">
      {#each filteredSubscriptions as subscription (`${subscription.subscriber_address_id}:${subscription.topic}`)}
        <li class="min-w-0 py-2"><p class="break-all text-sm"><span class="font-medium">{addressLabel(subscription.subscriber_address_id)}</span> <span class="text-muted-foreground">follows</span> {topicLabel(subscription.topic)}</p><p class="mt-1 break-all font-mono text-xs text-muted-foreground">{subscription.subscriber_engine} · {subscription.topic}</p></li>
      {:else}<li class="py-2 text-sm text-muted-foreground">{subscriptionSearch ? "No subscriptions match this search." : "No subscriptions yet. Agents subscribe through their messaging tools."}</li>{/each}
    </ul>{/if}
  </section>
</section>
