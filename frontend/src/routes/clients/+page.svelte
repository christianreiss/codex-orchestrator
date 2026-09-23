<script lang="ts">
  import { tick, untrack } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import BotIcon from "@lucide/svelte/icons/bot";
  import PowerOffIcon from "@lucide/svelte/icons/power-off";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import SearchIcon from "@lucide/svelte/icons/search";
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
  import InfoIcon from "@lucide/svelte/icons/info";
  import { toast } from "svelte-sonner";
  import { base } from "$app/paths";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import Composer from "$lib/components/portal/Composer.svelte";
  import AttentionCard from "$lib/components/portal/AttentionCard.svelte";
  import ConversationRow from "$lib/components/portal/ConversationRow.svelte";
  import EngineAvatar from "$lib/components/portal/EngineAvatar.svelte";
  import Timeline from "$lib/components/portal/Timeline.svelte";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { EmptyState } from "$lib/components/ui/empty-state";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { authStore } from "$lib/stores/auth";
  import { shortAge, shortPath } from "$lib/portal/browser";
  import { presenceView } from "$lib/portal/presence";
  import { listTime, visibleTimeline } from "$lib/portal/grouping";
  import { clientClock, clientCounts, snapshotIsStale, visibleClients, type ClientFilter } from "$lib/portal/clients";
  import { watchClientEvents, type ClientFeedState } from "$lib/portal/client-events";
  import type { TimelineSource } from "$lib/portal/types";
  import { reconnectReceiverMutation, agentSessionKeys, agentSessionsQuery, forceCloseMutation, requestCloseMutation, sendMutation, sessionEventsQuery, type AgentSessionRow } from "$lib/api/agentSessions";

  const sessions = agentSessionsQuery();
  const reconnectReceiver = reconnectReceiverMutation();
  const client = useQueryClient();
  const canManage = $derived($authStore.can("agent_portal.manage"));
  const canReadTranscript = $derived($authStore.can("agent_portal.reveal_transcript"));
  const canOpenSettings = $derived($authStore.can("agent_portal.manage"));
  let selectedId = $state<string | null>(null);
  let search = $state("");
  let engine = $state<"all" | "codex" | "claude">("all");
  let filter = $state<ClientFilter>("active");
  let now = $state(Date.now());
  let detailHeading = $state<HTMLHeadingElement | null>(null);
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const rows = $derived($sessions.data?.sessions ?? []);
  const enabled = $derived($sessions.data?.enabled ?? true);
  const timings = $derived($sessions.data?.timings ?? {});
  const serverNow = $derived(clientClock($sessions.data, $sessions.dataUpdatedAt, now));
  const stale = $derived(Boolean($sessions.data) && snapshotIsStale($sessions.dataUpdatedAt, now, timings));
  const counts = $derived(clientCounts(rows, serverNow, timings));
  const visible = $derived(visibleClients(rows, { search, engine, filter, sort: "status" }, serverNow, timings));
  const selected = $derived(rows.find((row) => row.id === selectedId) ?? null);
  const selectedView = $derived(selected ? presenceView(selected, serverNow, timings) : null);
  const actionsUnavailable = $derived(!enabled || stale || $sessions.isError);
  const disabledReason = $derived(!enabled ? "Agent Portal is disabled. Your draft is kept."
    : actionsUnavailable ? "Refresh client status before sending. Your draft is kept." : "");
  $effect(() => {
    if ($sessions.data && selectedId && !rows.some((row) => row.id === selectedId)) selectedId = null;
  });

  async function selectClient(id: string) {
    selectedId = id;
    atBottom = true;
    missed = 0;
    await tick();
    detailHeading?.focus({ preventScroll: true });
    detailHeading?.scrollIntoView({ block: "nearest" });
  }
  async function closeDetail() {
    const id = selectedId;
    selectedId = null;
    await tick();
    if (id) document.getElementById(`client-${id}`)?.focus();
  }

  const events = sessionEventsQuery(() => canReadTranscript && enabled ? selectedId : null);
  let feedState = $state<ClientFeedState | "idle">("idle");
  let feedRetry = $state(0);
  $effect(() => {
    const id = selectedId;
    feedRetry;
    if (!canReadTranscript || !id || !enabled) { feedState = "idle"; return; }
    try {
      return watchClientEvents({
        sessionId: id,
        status: (state) => (feedState = state),
        refresh: (timeline) => {
          void client.invalidateQueries({ queryKey: agentSessionKeys.list });
          if (timeline) void client.invalidateQueries({ queryKey: agentSessionKeys.events(id) });
        },
      });
    } catch {
      feedState = "reconnecting";
    }
  });

  let atBottom = $state(true);
  let missed = $state(0);
  let scrollToBottom: ((smooth: boolean) => void) | null = null;
  let lastTimelineSession: string | null = null;
  let lastCursor = 0;
  const timelineSource: TimelineSource = {
    get timeline() { return canReadTranscript ? ($events.data?.events ?? []) : []; },
    get now() { return serverNow; },
    get atBottom() { return atBottom; },
    get missed() { return missed; },
    setAtBottom(value) { atBottom = value; if (value) missed = 0; },
    setScroller(fn) { scrollToBottom = fn; },
  };
  $effect(() => {
    const id = selectedId;
    const data = $events.data;
    if (!id || !data) return;
    const tail = data.events.at(-1)?.cursor ?? 0;
    const changedSession = id !== lastTimelineSession;
    const follow = changedSession || untrack(() => atBottom);
    if (!changedSession && !follow && tail > lastCursor) {
      const count = visibleTimeline(data.events, selected?.pending_prompt ?? null).filter((event) => event.cursor > lastCursor).length;
      missed = untrack(() => missed) + count;
    }
    lastTimelineSession = id;
    lastCursor = tail;
    if (follow) void tick().then(() => scrollToBottom?.(false));
  });

  let forceTarget = $state<AgentSessionRow | null>(null);
  let forceOpen = $state(false);
  const force = forceCloseMutation({
    onSuccess: (result) => { forceOpen = false; result.already_ended ? toast.info("That session had already ended") : toast.success("Session ended"); },
    onError: (error) => toast.error(error.message),
  });
  const cooperativeClose = requestCloseMutation({
    onSuccess: (result) => deliveryFailed(result) ? toast.warning("The close request was not delivered. Try again if it is still needed.") : toast.success("Close request recorded"),
    onError: (error) => toast.error(error.message),
  });
  let drafts = $state<Record<string, string>>({});
  let failedSends = $state<Record<string, { content: string; prompt: { id: string; version: number } | null; actor: string }>>({});
  let composerInput = $state<HTMLTextAreaElement | null>(null);
  const draft = $derived(selectedId ? (drafts[selectedId] ?? "") : "");
  const retryingDraft = $derived(selectedId && failedSends[selectedId]?.content === draft.trim() && failedSends[selectedId]?.actor === String($authStore.user?.id ?? ""));
  const send = sendMutation({ onError: (error) => toast.error(error.message) });
  function deliveryFailed(result: unknown) {
    return typeof result === "object" && result !== null && "status" in result
      && (result.status === "canceled" || result.status === "dead");
  }
  async function submit(text: string, currentQuestion = false): Promise<boolean> {
    const target = selected;
    if (!target || !canManage || !canReadTranscript || actionsUnavailable || $send.isPending || !presenceView(target, serverNow, timings).canSend) return false;
    const { id, pending_prompt: prompt } = target;
    const actor = String($authStore.user?.id ?? "");
    const previous = failedSends[id];
    // A lost answer response may be followed by pending_prompt=null. Retrying
    // unchanged composer text must not turn the original answer into a message.
    const intent = !currentQuestion && previous?.actor === actor && previous.content === text.trim()
      ? previous : { content: text.trim(), prompt: prompt ? { id: prompt.id, version: prompt.version } : null, actor };
    try {
      const result = await $send.mutateAsync({ id, content: intent.content, prompt: intent.prompt });
      const retained = { ...failedSends }; delete retained[id]; failedSends = retained;
      if (deliveryFailed(result)) {
        toast.warning("This instruction was not delivered. Your draft is kept.");
        return false;
      }
      // Preserve any edits made while this request was in flight.
      if ((drafts[id] ?? "").trim() === text.trim()) drafts = { ...drafts, [id]: "" };
      return true;
    } catch {
      // A later denial cannot prove an earlier ambiguous attempt was rejected.
      // Keep the original answer intent until success or an explicitly new send.
      failedSends = { ...failedSends, [id]: intent };
      return false;
    }
  }
  function onreply(option?: string) { if (option) void submit(option, true); else composerInput?.focus(); }
  function refresh() { void client.invalidateQueries({ queryKey: agentSessionKeys.all }); if (feedState === "reconnecting") feedRetry++; }
  function resetFilters() { search = ""; engine = "all"; filter = "active"; }
  function place(row: AgentSessionRow) { return shortPath(row.work.worktree_path ?? row.cwd) || "No directory reported"; }
  function age(value: string | null, clock = serverNow) { return value ? shortAge(value, clock) || "unknown" : "unknown"; }
  function exactTime(value: string | null) { const date = value ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date.toLocaleString() : "Not reported"; }
  // Messages-style scope chips; the counts that used to live on four summary cards ride on them.
  const chips = $derived([
    { key: "active" as ClientFilter, label: "Current", count: null },
    { key: "attention" as ClientFilter, label: "Needs you", count: counts.attention },
    { key: "online" as ClientFilter, label: "Online", count: counts.online },
    { key: "ended" as ClientFilter, label: "Ended", count: counts.ended },
    { key: "all" as ClientFilter, label: "All", count: null },
  ]);
  let detailsOpen = $state(false);
  function preview(row: AgentSessionRow, label: string, ended: boolean) {
    const ask = row.pending_prompt?.question ?? row.attention?.summary;
    if (ask && !ended) return ask;
    return `${label} · ${row.work.task?.split("\n")[0] || place(row)}`;
  }
</script>

<PageHeader class={selected ? "hidden lg:flex" : ""} title="Active Clients" subtitle="Codex and Claude sessions, reported work, and the latest evidence that each client is reachable.">
  {#snippet actions()}
    <Button variant="outline" onclick={refresh} disabled={$sessions.isFetching} aria-label="Refresh clients">
      <RefreshCwIcon class="h-4 w-4 {$sessions.isFetching ? 'motion-safe:animate-spin' : ''}" />
      {$sessions.isFetching ? "Refreshing…" : "Refresh"}
    </Button>
  {/snippet}
</PageHeader>

{#if $sessions.isPending && !$sessions.data}
  <div role="status" aria-label="Loading clients" class="space-y-2 lg:w-80">
    {#each Array(5) as _, i (i)}<div class="flex items-center gap-3"><Skeleton class="h-11 w-11 rounded-full" /><Skeleton class="h-9 flex-1 rounded-lg" /></div>{/each}
  </div>
{:else if $sessions.isError && !$sessions.data}
  <div role="alert" class="rounded-xl border border-destructive/30 bg-destructive/5 p-6">
    <h2 class="font-semibold">Clients could not be loaded</h2>
    <p class="mt-1 text-sm text-muted-foreground">{$sessions.error?.message ?? "The server is unreachable."}</p>
    <Button class="mt-4" variant="outline" onclick={refresh} disabled={$sessions.isFetching}>Retry clients</Button>
  </div>
{:else}
  {#if $sessions.isError || stale}
    <div role="status" class="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-muted px-4 py-2.5 text-sm">
      <div class="min-w-0"><p class="font-medium">{$sessions.isError ? "Client refresh failed" : "Client status is stale"}</p><p class="mt-0.5 text-xs text-muted-foreground">{$sessions.error?.message ?? "A recent status check has not completed."} Last known clients remain visible; refresh before sending instructions.</p></div>
      <Button variant="outline" size="sm" onclick={refresh} disabled={$sessions.isFetching}>Retry status</Button>
    </div>
  {/if}
  {#if !enabled}
    <EmptyState icon={PowerOffIcon} title="The Agent Portal is off" description="Client registration is paused. Enable the Agent Portal to record new Codex and Claude sessions.">
      {#snippet action()}{#if canOpenSettings}<Button href="{base}/agent-portal" variant="outline">Open Agent Portal settings</Button>{/if}{/snippet}
    </EmptyState>
  {:else if rows.length === 0}
    <EmptyState icon={BotIcon} title="No recorded clients" description="A session appears when cdx or clx registers with the Agent Portal. Clients that cannot reach the server may appear after reconnecting." />
  {:else}
    <!-- One Messages-style card: conversation list on the left, thread on the right. -->
    <div class="grid h-[75dvh] min-h-[28rem] overflow-hidden rounded-xl border bg-card lg:h-[calc(100dvh-15.5rem)] lg:grid-cols-[22rem_minmax(0,1fr)]">
      <section class="min-h-0 flex-col border-r {selected ? 'hidden lg:flex' : 'flex'}" aria-label="Client directory">
        <div class="space-y-2 border-b px-3 pb-2.5 pt-3">
          <div class="flex items-center gap-2">
            <label class="relative block min-w-0 flex-1">
              <span class="sr-only">Find a client</span>
              <SearchIcon class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input type="search" bind:value={search} placeholder="Search" title="Host, task, branch, directory…"
                class="h-8 w-full rounded-lg border-0 bg-muted pl-8 pr-2 text-xs outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring/30" />
            </label>
            <label for="client-engine" class="sr-only">Engine</label>
            <select id="client-engine" bind:value={engine} class="client-select shrink-0"><option value="all">Both</option><option value="codex">Codex</option><option value="claude">Claude</option></select>
          </div>
          <div class="flex flex-wrap gap-1" role="group" aria-label="Show sessions">
            {#each chips as chip (chip.key)}
              <button type="button" aria-pressed={filter === chip.key} onclick={() => (filter = chip.key)}
                class="rounded-full px-2.5 py-0.5 text-[11px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                       {filter === chip.key ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}">
                {chip.label}{#if chip.count}{" "}<span class="ml-0.5 {chip.key === 'attention' && filter !== chip.key ? 'text-destructive' : ''}">{chip.count}</span>{/if}
              </button>
            {/each}
          </div>
          <p class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span class="h-1.5 w-1.5 rounded-full {stale || $sessions.isError ? 'bg-warning' : 'bg-success'}" aria-hidden="true"></span>
            <span class="truncate">{visible.length} of {rows.length} · {counts.codex} Codex · {counts.claude} Claude · checked {age(new Date($sessions.dataUpdatedAt).toISOString(), now)} ago</span>
            {#if search || engine !== "all" || filter !== "active"}<button type="button" class="ml-auto shrink-0 text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onclick={resetFilters}>Clear filters</button>{/if}
          </p>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
          {#if !visible.length}
            <div class="px-4 py-8 text-center"><SearchIcon class="mx-auto h-5 w-5 text-muted-foreground" /><h3 class="mt-2 text-sm font-medium">No clients match</h3><p class="mt-1 text-xs text-muted-foreground">Try another host, engine, or status.</p><Button variant="outline" size="sm" class="mt-3" onclick={resetFilters}>Clear filters</Button></div>
          {:else}
            {#each visible as row (row.id)}{@render sessionRow(row)}{/each}
          {/if}
        </div>
      </section>

      <section class="min-h-0 flex-col {selected ? 'flex' : 'hidden lg:flex'}" aria-label="Client details">
        {#if !selected || !selectedView}
          <div class="grid flex-1 place-content-center p-8 text-center"><BotIcon class="mx-auto h-8 w-8 text-muted-foreground/60" /><h2 class="mt-3 text-sm font-medium">Select a client</h2><p class="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">Online means a recent heartbeat. A client accepts instructions only while listening or working.</p></div>
        {:else}
          <div id="client-detail" class="flex min-h-0 flex-1 flex-col">
            <header class="grid shrink-0 grid-cols-[5.5rem_1fr_5.5rem] items-center border-b px-2 py-1.5">
              <div><Button variant="ghost" size="sm" class="-ml-1 px-1.5 text-primary lg:hidden" onclick={closeDetail}><ChevronLeftIcon class="h-5 w-5" /> Clients</Button></div>
              <div class="flex min-w-0 flex-col items-center text-center">
                <EngineAvatar engine={selected.engine} presence={selectedView.presence} size="xs" badge />
                <h2 bind:this={detailHeading} tabindex="-1" class="mt-0.5 max-w-full truncate text-xs font-semibold focus:outline-none">{selected.username} <span class="font-normal text-muted-foreground">on</span> {selected.host ?? `host ${selected.host_id}`}</h2>
                <p class="max-w-full truncate text-[11px] text-muted-foreground">
                  {selected.engine === "codex" ? "Codex" : "Claude"} · {selectedView.label}{selected.read_only ? " · Read-only" : ""}{#if selectedView.presence !== "listening"}{" · "}<span title={selectedView.detail}>{selectedView.detail}</span>{/if}{#if canReadTranscript}{" · "}<span>{feedState === "live" ? "Live timeline updates" : feedState === "connecting" ? "Connecting to live updates…" : "Live updates reconnecting"}</span>{/if}
                </p>
              </div>
              <div class="flex justify-end">
                <Button variant="ghost" size="icon" class="h-8 w-8 rounded-full {detailsOpen ? 'text-primary' : 'text-muted-foreground'}" aria-expanded={detailsOpen} aria-controls="client-info" aria-label="Session details" title="Session details" onclick={() => (detailsOpen = !detailsOpen)}><InfoIcon class="h-4 w-4" /></Button>
              </div>
            </header>
            {#if detailsOpen}
              <div id="client-info" class="max-h-[50%] shrink-0 overflow-y-auto border-b bg-muted/20 px-4 py-3 text-xs">
                <p class="leading-relaxed text-muted-foreground">{selectedView.detail}</p>
                <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                  <dt class="text-muted-foreground">Heartbeat</dt><dd title={exactTime(selected.heartbeat_at)}>{age(selected.heartbeat_at)} ago</dd>
                  <dt class="text-muted-foreground">Last activity</dt><dd title={exactTime(selected.last_event_at ?? selected.started_at)}>{age(selected.last_event_at ?? selected.started_at)} ago</dd>
                  <dt class="text-muted-foreground">Directory</dt><dd class="break-all font-mono">{selected.work.worktree_path ?? selected.cwd}</dd>
                  {#if selected.work.task}<dt class="text-muted-foreground">Task</dt><dd class="whitespace-pre-wrap leading-relaxed">{selected.work.task}</dd>{/if}
                  {#if selected.work.branch}<dt class="text-muted-foreground">Branch</dt><dd class="break-all font-mono">{selected.work.branch}{selected.work.target_branch ? ` → ${selected.work.target_branch}` : ""}</dd>{/if}
                  {#if selected.work.address}<dt class="text-muted-foreground">Address</dt><dd class="break-all font-mono">{selected.work.address_alias ?? selected.work.address}</dd>{/if}
                  {#if selected.work.declared_paths.length}<dt class="text-muted-foreground">Paths</dt><dd class="whitespace-pre-wrap break-all font-mono">{selected.work.declared_paths.join("\n")}</dd>{/if}
                  <dt class="text-muted-foreground">Relay</dt><dd title={exactTime(selected.relay_heartbeat_at ?? null)}>{selected.relay_enabled === false ? "Relay disabled" : selected.relay_heartbeat_at ? `${age(selected.relay_heartbeat_at)} ago` : "Not reported"}</dd>
                  <dt class="text-muted-foreground">Invocation</dt><dd>{selected.invocation_kind}</dd>
                  <dt class="text-muted-foreground">Session</dt><dd class="break-all font-mono">{selected.id}</dd>
                  <dt class="text-muted-foreground">Started</dt><dd>{exactTime(selected.started_at)}</dd>
                </dl>
                {#if selected.receiver}
                  <div class="mt-3 border-t pt-2">
                    <p class="font-medium">Reception: {selected.receiver.state}</p>
                    <p class="text-muted-foreground">{selected.receiver.protocol} · Native session {selected.receiver.native_session_id} · last response {age(selected.receiver.heartbeat_at)} ago</p>
                    {#if selected.receiver.failure}<p class="text-destructive">{selected.receiver.failure}</p>{/if}
                    {#each selected.receiver.sources as proof}
                      <p class="text-muted-foreground">{proof.source}: {proof.state} · transport health</p>
                    {/each}
                    {#if canManage && !selected.ended_at}<Button class="mt-2" variant="outline" size="sm" disabled={$reconnectReceiver.isPending || actionsUnavailable} onclick={() => $reconnectReceiver.mutate(selected.id, { onError: (error) => toast.error(error.message) })}>Reconnect receiver</Button>{/if}
                  </div>
                {/if}
                {#if canManage && !selected.ended_at && !selected.read_only}
                  <div class="mt-3 flex flex-wrap gap-2 border-t pt-3">{#if selectedView.canSend && !selected.close}<Button variant="outline" size="sm" disabled={$cooperativeClose.isPending || actionsUnavailable} onclick={() => $cooperativeClose.mutate({ id: selected.id })}>Ask to close</Button>{/if}<Button variant="outline" size="sm" class="text-destructive" disabled={$force.isPending || !enabled} onclick={() => { forceTarget = selected; forceOpen = true; }}>Force close</Button></div>
                {/if}
              </div>
            {/if}
            {#if !canReadTranscript}
              <div class="grid flex-1 place-content-center px-6 text-center"><h3 class="text-sm font-medium">Timeline hidden</h3><p class="mt-1 max-w-prose text-xs text-muted-foreground">Your account can view client status. Reading messages requires transcript access.</p></div>
            {:else}
              {#if $events.isError}<div role="status" class="flex items-center justify-between gap-2 border-b border-warning/20 bg-warning-muted px-4 py-1.5 text-xs"><span>{$events.data ? "Timeline refresh failed. Showing saved messages." : "Timeline could not be loaded."}</span><Button variant="ghost" size="sm" onclick={() => $events.refetch()} disabled={$events.isFetching}>Retry timeline</Button></div>{/if}
              {#if $events.isPending && !$events.data}<div class="flex-1 space-y-2 p-4" role="status" aria-label="Loading timeline">{#each Array(4) as _, i (i)}<Skeleton class="h-10 w-2/3 rounded-2xl {i % 2 ? 'ml-auto' : ''}" />{/each}</div>
              {:else if $events.data}{#key selected.id}<Timeline portal={timelineSource} agent={selected} />{/key}
              {:else}<div class="flex-1"></div>{/if}
              <AttentionCard agent={selected} now={serverNow} {timings} {onreply} busy={$send.isPending} readonly={!canManage || actionsUnavailable} />
              {#if canManage}{#if retryingDraft}<p class="border-t bg-warning-muted px-4 py-1.5 text-xs text-muted-foreground">A previous send was not confirmed. Sending this draft again retries the same request.</p>{/if}<Composer agent={selected} now={serverNow} {timings} sending={$send.isPending} {draft} {disabledReason} ondraft={(text) => (drafts = { ...drafts, [selected.id]: text })} onsend={submit} bind:input={composerInput} />{/if}
            {/if}
          </div>
        {/if}
      </section>
    </div>
  {/if}
{/if}

{#snippet sessionRow(row: AgentSessionRow)}
  {@const view = presenceView(row, serverNow, timings)}
  {@const ended = view.presence === "ended"}
  <ConversationRow
    id="client-{row.id}"
    engine={row.engine}
    presence={view.presence}
    title={row.host ?? `host ${row.host_id}`}
    subtitle={row.username}
    time={listTime(row.last_event_at ?? row.started_at, new Date(serverNow))}
    preview={preview(row, view.label, ended)}
    selected={row.id === selectedId}
    needsYou={Boolean(row.attention || row.pending_prompt) && !ended}
    badge={(row.attention || row.pending_prompt) && !ended ? { kind: "attention" } : null}
    aria-pressed={row.id === selectedId}
    aria-controls={selected ? "client-detail" : undefined}
    onclick={() => selectClient(row.id)}
  />
{/snippet}

<Dialog.Root bind:open={forceOpen}>
  <Dialog.Content class="sm:max-w-md"><Dialog.Header><Dialog.Title>Force close this session?</Dialog.Title><Dialog.Description>End the portal session for {forceTarget?.username} on {forceTarget?.host}. This works when the relay cannot accept a close request. The local client may take time to observe it.</Dialog.Description></Dialog.Header><Dialog.Footer><Button variant="ghost" onclick={() => (forceOpen = false)} disabled={$force.isPending}>Cancel</Button><Button variant="destructive" disabled={!canManage || !enabled || $force.isPending || !forceTarget} onclick={() => { if (forceTarget && canManage && enabled) $force.mutate({ id: forceTarget.id }); }}>{$force.isPending ? "Ending…" : "Force close session"}</Button></Dialog.Footer></Dialog.Content>
</Dialog.Root>

<style>
  .client-select { height: 2rem; border: 0; border-radius: .5rem; background: hsl(var(--muted)); padding: 0 1.75rem 0 .625rem; font-size: .75rem; }
  .client-select:focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 2px; }
</style>
