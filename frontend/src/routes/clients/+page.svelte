<script lang="ts">
  import { tick, untrack } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import BotIcon from "@lucide/svelte/icons/bot";
  import PowerOffIcon from "@lucide/svelte/icons/power-off";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import SearchIcon from "@lucide/svelte/icons/search";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import XIcon from "@lucide/svelte/icons/x";
  import ActivityIcon from "@lucide/svelte/icons/activity";
  import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
  import WifiOffIcon from "@lucide/svelte/icons/wifi-off";
  import CheckCheckIcon from "@lucide/svelte/icons/check-check";
  import { toast } from "svelte-sonner";
  import { base } from "$app/paths";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import Composer from "$lib/components/portal/Composer.svelte";
  import EngineAvatar from "$lib/components/portal/EngineAvatar.svelte";
  import PresenceDot from "$lib/components/portal/PresenceDot.svelte";
  import Timeline from "$lib/components/portal/Timeline.svelte";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { EmptyState } from "$lib/components/ui/empty-state";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { authStore } from "$lib/stores/auth";
  import { shortAge, shortPath } from "$lib/portal/browser";
  import { presenceView } from "$lib/portal/presence";
  import { clientClock, clientCounts, snapshotIsStale, visibleClients, type ClientFilter, type ClientSort } from "$lib/portal/clients";
  import { watchClientEvents, type ClientFeedState } from "$lib/portal/client-events";
  import type { TimelineSource } from "$lib/portal/types";
  import { agentSessionKeys, agentSessionsQuery, forceCloseMutation, requestCloseMutation, sendMutation, sessionEventsQuery, type AgentSessionRow } from "$lib/api/agentSessions";

  const sessions = agentSessionsQuery();
  const client = useQueryClient();
  const canManage = $derived($authStore.can("agent_portal.manage"));
  const canReadTranscript = $derived($authStore.can("agent_portal.reveal_transcript"));
  const canOpenSettings = $derived($authStore.can("agent_portal.manage"));
  let selectedId = $state<string | null>(null);
  let search = $state("");
  let engine = $state<"all" | "codex" | "claude">("all");
  let filter = $state<ClientFilter>("active");
  let sort = $state<ClientSort>("status");
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
  const visible = $derived(visibleClients(rows, { search, engine, filter, sort }, serverNow, timings));
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
      const count = data.events.filter((event) => event.cursor > lastCursor).length;
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
  function resetFilters() { search = ""; engine = "all"; filter = "all"; }
  function place(row: AgentSessionRow) { return shortPath(row.work.worktree_path ?? row.cwd) || "No directory reported"; }
  function age(value: string | null, clock = serverNow) { return value ? shortAge(value, clock) || "unknown" : "unknown"; }
  function exactTime(value: string | null) { const date = value ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date.toLocaleString() : "Not reported"; }
  const cards = $derived([
    { key: "online" as ClientFilter, label: "Online", count: counts.online, detail: "Recent client heartbeat", icon: ActivityIcon },
    { key: "attention" as ClientFilter, label: "Needs attention", count: counts.attention, detail: "An answer is outstanding", icon: CircleAlertIcon },
    { key: "offline" as ClientFilter, label: "Offline", count: counts.offline, detail: "No confirmed connection", icon: WifiOffIcon },
    { key: "ended" as ClientFilter, label: "Recently ended", count: counts.ended, detail: "Retained session history", icon: CheckCheckIcon },
  ]);
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
  <div role="status" aria-label="Loading clients" class="space-y-4">
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">{#each Array(4) as _, i (i)}<Skeleton class="h-24 rounded-xl" />{/each}</div>
    {#each Array(4) as _, i (i)}<Skeleton class="h-24 w-full rounded-lg" />{/each}
  </div>
{:else if $sessions.isError && !$sessions.data}
  <div role="alert" class="rounded-xl border border-destructive/30 bg-destructive/5 p-6">
    <h2 class="font-semibold">Clients could not be loaded</h2>
    <p class="mt-1 text-sm text-muted-foreground">{$sessions.error?.message ?? "The server is unreachable."}</p>
    <Button class="mt-4" variant="outline" onclick={refresh} disabled={$sessions.isFetching}>Retry clients</Button>
  </div>
{:else}
  <div class="mb-4 flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground {selected ? 'hidden lg:flex' : 'flex'}">
    <p class="flex items-center gap-2">
      <span class="h-1.5 w-1.5 rounded-full {stale || $sessions.isError ? 'bg-warning' : 'bg-success'}" aria-hidden="true"></span>
      {stale || $sessions.isError ? "Showing last known clients" : "Status checked every 15 seconds"}
      <span class="text-border" aria-hidden="true">/</span>
      Last success {age(new Date($sessions.dataUpdatedAt).toISOString(), now)} ago
    </p>
    <p>{counts.codex} Codex <span class="mx-1 text-border" aria-hidden="true">·</span> {counts.claude} Claude</p>
  </div>
  {#if $sessions.isError || stale}
    <div role="status" class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-muted px-4 py-3 text-sm">
      <div class="min-w-0"><p class="font-medium">{$sessions.isError ? "Client refresh failed" : "Client status is stale"}</p><p class="mt-0.5 text-xs text-muted-foreground">{$sessions.error?.message ?? "A recent status check has not completed."} Last known clients remain visible; refresh before sending instructions.</p></div>
      <Button variant="outline" size="sm" onclick={refresh} disabled={$sessions.isFetching}>Retry status</Button>
    </div>
  {/if}
  {#if !enabled}
    <EmptyState icon={PowerOffIcon} title="The Agent Portal is off" description="Client registration is paused. Enable the Agent Portal to record new Codex and Claude sessions.">
      {#snippet action()}{#if canOpenSettings}<Button href="{base}/agent-portal" variant="outline">Open Agent Portal settings</Button>{/if}{/snippet}
    </EmptyState>
  {:else}
    <div class="mb-5 grid-cols-2 gap-3 lg:grid-cols-4 {selected ? 'hidden lg:grid' : 'grid'}" aria-label="Client status summary">
      {#each cards as card (card.key)}
        <button type="button" onclick={() => (filter = filter === card.key ? "all" : card.key)} aria-pressed={filter === card.key}
          class="rounded-xl border bg-card p-3.5 text-left transition-colors hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {filter === card.key ? 'border-primary ring-1 ring-primary/20' : ''}">
          <span class="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">{card.label}<card.icon class="h-4 w-4" /></span>
          <span class="mt-2 block text-2xl font-semibold tabular-nums tracking-tight">{card.count}</span>
          <span class="mt-1 block text-[11px] text-muted-foreground">{card.detail}</span>
        </button>
      {/each}
    </div>
    <div class="mb-5 flex-wrap items-end gap-3 rounded-xl border bg-card p-3 {selected ? 'hidden lg:flex' : 'flex'}">
      <div class="min-w-[12rem] flex-1"><label for="client-search" class="mb-1.5 block text-xs font-medium">Find a client</label><div class="relative"><SearchIcon class="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><Input id="client-search" type="search" class="pl-8" bind:value={search} placeholder="Host, task, branch, directory…" /></div></div>
      <div class="flex-1 sm:flex-none"><label for="client-engine" class="mb-1.5 block text-xs font-medium">Engine</label><select id="client-engine" bind:value={engine} class="client-select"><option value="all">Both engines</option><option value="codex">Codex</option><option value="claude">Claude</option></select></div>
      <div class="flex-1 sm:flex-none"><label for="client-status" class="mb-1.5 block text-xs font-medium">Status</label><select id="client-status" bind:value={filter} class="client-select"><option value="all">All sessions</option><option value="active">Current sessions</option><option value="online">Online</option><option value="attention">Needs attention</option><option value="working">Working</option><option value="listening">Listening</option><option value="idle">Not listening</option><option value="offline">Offline</option><option value="ended">Recently ended</option></select></div>
      <div class="flex-1 sm:flex-none"><label for="client-sort" class="mb-1.5 block text-xs font-medium">Sort</label><select id="client-sort" bind:value={sort} class="client-select"><option value="status">Status priority</option><option value="recent">Recent activity</option><option value="host">Host and user</option></select></div>
    </div>
    {#if rows.length === 0}
      <EmptyState icon={BotIcon} title="No recorded clients" description="A session appears when cdx or clx registers with the Agent Portal. Clients that cannot reach the server may appear after reconnecting." />
    {:else}
      <div class="grid items-start gap-5 lg:grid-cols-[minmax(19rem,0.85fr)_minmax(0,1.4fr)]">
        <section class="min-w-0 {selected ? 'hidden lg:block' : ''}" aria-label="Client directory">
          <div class="mb-2.5 flex items-center justify-between gap-3"><h2 class="text-xs font-semibold text-muted-foreground">{visible.length} of {rows.length} sessions</h2>{#if search || engine !== "all" || filter !== "all"}<button type="button" class="text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onclick={resetFilters}>Clear filters</button>{/if}</div>
          {#if !visible.length}
            <div class="rounded-xl border border-dashed p-7 text-center"><SearchIcon class="mx-auto h-6 w-6 text-muted-foreground" /><h3 class="mt-3 text-sm font-medium">No clients match</h3><p class="mt-1 text-xs text-muted-foreground">Try another host, engine, or status.</p><Button variant="outline" size="sm" class="mt-3" onclick={resetFilters}>Clear filters</Button></div>
          {:else}
            <div class="space-y-2">{#each visible as row (row.id)}{@render sessionRow(row)}{/each}</div>
          {/if}
        </section>
        <section class="min-w-0 {selected ? '' : 'hidden lg:block'}" aria-label="Client details">
          {#if !selected || !selectedView}
            <div class="grid min-h-[25rem] place-content-center rounded-xl border border-dashed bg-muted/15 p-8 text-center"><BotIcon class="mx-auto h-9 w-9 text-muted-foreground/60" /><h2 class="mt-4 text-base font-medium">Select a client</h2><p class="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">See reported work, heartbeat details, and the session timeline.</p><p class="mx-auto mt-4 max-w-xs text-xs leading-relaxed text-muted-foreground">Online means a recent heartbeat. A client accepts instructions only while listening or working.</p></div>
          {:else}
            <div id="client-detail" class="flex h-[75dvh] min-h-[32rem] flex-col overflow-hidden rounded-xl border bg-card lg:sticky lg:top-4">
              <header class="max-h-[55%] shrink-0 overflow-y-auto border-b bg-muted/20 p-4">
                <div class="mb-3 flex items-center justify-between gap-2"><Button variant="ghost" size="sm" class="-ml-2 lg:hidden" onclick={closeDetail}><ArrowLeftIcon class="h-4 w-4" /> Clients</Button><span class="text-xs font-medium text-muted-foreground">{selected.engine === "codex" ? "Codex" : "Claude"} · {selected.invocation_kind}</span><Button variant="ghost" size="icon" class="ml-auto h-7 w-7" aria-label="Close client details" onclick={closeDetail}><XIcon class="h-4 w-4" /></Button></div>
                <div class="flex items-start gap-3"><EngineAvatar engine={selected.engine} presence={selectedView.presence} /><div class="min-w-0 flex-1"><h2 bind:this={detailHeading} tabindex="-1" class="break-words text-sm font-semibold focus:outline-none">{selected.username} <span class="font-normal text-muted-foreground">on</span> {selected.host ?? `host ${selected.host_id}`}</h2><p class="mt-1 flex items-center gap-2 text-xs font-medium"><PresenceDot presence={selectedView.presence} />{selectedView.label}{#if selected.read_only}<Badge variant="secondary">Read-only</Badge>{/if}</p></div></div>
                <p class="mt-3 text-xs leading-relaxed text-muted-foreground">{selectedView.detail}</p>
                <div class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-3 text-[11px]"><p><span class="block text-muted-foreground">Heartbeat</span><span title={exactTime(selected.heartbeat_at)}>{age(selected.heartbeat_at)} ago</span></p><p><span class="block text-muted-foreground">Last activity</span><span title={exactTime(selected.last_event_at ?? selected.started_at)}>{age(selected.last_event_at ?? selected.started_at)} ago</span></p></div>
                <details class="mt-3 rounded-md border bg-background/60 px-3 py-2"><summary class="cursor-pointer text-xs font-medium">Reported work and session details</summary><dl class="mt-2 space-y-2 text-xs"><div><dt class="text-muted-foreground">Directory</dt><dd class="mt-0.5 break-all font-mono">{selected.work.worktree_path ?? selected.cwd}</dd></div>{#if selected.work.task}<div><dt class="text-muted-foreground">Task</dt><dd class="mt-0.5 whitespace-pre-wrap leading-relaxed">{selected.work.task}</dd></div>{/if}{#if selected.work.branch}<div><dt class="text-muted-foreground">Branch</dt><dd class="break-all font-mono">{selected.work.branch}{selected.work.target_branch ? ` → ${selected.work.target_branch}` : ""}</dd></div>{/if}{#if selected.work.address}<div><dt class="text-muted-foreground">Messaging address</dt><dd class="break-all font-mono">{selected.work.address_alias ?? selected.work.address}</dd></div>{/if}{#if selected.work.declared_paths.length}<div><dt class="text-muted-foreground">Declared paths</dt><dd class="whitespace-pre-wrap break-all font-mono">{selected.work.declared_paths.join("\n")}</dd></div>{/if}<div><dt class="text-muted-foreground">Relay heartbeat</dt><dd title={exactTime(selected.relay_heartbeat_at ?? null)}>{selected.relay_enabled === false ? "Relay disabled" : selected.relay_heartbeat_at ? `${age(selected.relay_heartbeat_at)} ago · ${exactTime(selected.relay_heartbeat_at)}` : "Not reported"}</dd></div><div><dt class="text-muted-foreground">Session ID</dt><dd class="break-all font-mono">{selected.id}</dd></div><div><dt class="text-muted-foreground">Started</dt><dd>{exactTime(selected.started_at)}</dd></div></dl></details>
                {#if canManage && !selected.ended_at && !selected.read_only}
                  <div class="mt-3 flex flex-wrap gap-2">{#if selectedView.canSend && !selected.close}<Button variant="outline" size="sm" disabled={$cooperativeClose.isPending || actionsUnavailable} onclick={() => $cooperativeClose.mutate({ id: selected.id })}>Ask to close</Button>{/if}<Button variant="outline" size="sm" disabled={$force.isPending || !enabled} onclick={() => { forceTarget = selected; forceOpen = true; }}>Force close</Button></div>
                {/if}
              </header>
              {#if !canReadTranscript}
                <div class="grid flex-1 place-content-center px-6 text-center"><h3 class="text-sm font-medium">Timeline hidden</h3><p class="mt-1 max-w-prose text-xs text-muted-foreground">Your account can view client status. Reading messages requires transcript access.</p></div>
              {:else}
                <div class="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-[11px] text-muted-foreground"><span>{feedState === "live" ? "Live timeline updates" : feedState === "connecting" ? "Connecting to live updates…" : "Live updates reconnecting"}</span><span>{feedState !== "live" ? "Polling every 15s" : "Polling fallback enabled"}</span></div>
                {#if $events.isError}<div role="status" class="flex items-center justify-between gap-2 border-b border-warning/20 bg-warning-muted px-4 py-2 text-xs"><span>{$events.data ? "Timeline refresh failed. Showing saved messages." : "Timeline could not be loaded."}</span><Button variant="ghost" size="sm" onclick={() => $events.refetch()} disabled={$events.isFetching}>Retry timeline</Button></div>{/if}
                {#if $events.isPending && !$events.data}<div class="space-y-2 p-4" role="status" aria-label="Loading timeline">{#each Array(4) as _, i (i)}<Skeleton class="h-12 w-full rounded-md" />{/each}</div>
                {:else if $events.data}{#key selected.id}<Timeline portal={timelineSource} agent={selected} {onreply} readonly={!canManage || actionsUnavailable || !selectedView.canSend} />{/key}
                {:else}<div class="flex-1"></div>{/if}
                {#if canManage}{#if retryingDraft}<p class="border-t bg-warning-muted px-4 py-2 text-xs text-muted-foreground">A previous send was not confirmed. Sending this draft again retries the same request.</p>{/if}<Composer agent={selected} now={serverNow} {timings} sending={$send.isPending} {draft} {disabledReason} ondraft={(text) => (drafts = { ...drafts, [selected.id]: text })} onsend={submit} bind:input={composerInput} />{/if}
              {/if}
            </div>
          {/if}
        </section>
      </div>
    {/if}
  {/if}
{/if}

{#snippet sessionRow(row: AgentSessionRow)}
  {@const view = presenceView(row, serverNow, timings)}
  <button id="client-{row.id}" type="button" aria-pressed={row.id === selectedId} aria-controls={selected ? "client-detail" : undefined} onclick={() => selectClient(row.id)}
    class="group flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition-colors hover:border-foreground/25 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {row.id === selectedId ? 'border-primary bg-primary/5 ring-1 ring-primary/15' : 'bg-card'}">
    <EngineAvatar engine={row.engine} presence={view.presence} size="sm" />
    <span class="min-w-0 flex-1"><span class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"><span class="truncate text-xs font-semibold">{row.host ?? `host ${row.host_id}`}</span><span class="flex items-center gap-1.5 text-[11px] text-muted-foreground"><PresenceDot presence={view.presence} />{view.label}</span></span><span class="mt-1 block truncate text-[11px] text-muted-foreground">{row.engine === "codex" ? "Codex" : "Claude"} · {row.username}{row.work.branch ? ` · ${row.work.branch}` : ""}</span><span class="mt-1.5 block truncate font-mono text-[11px]" title={row.work.worktree_path ?? row.cwd}>{place(row)}</span>{#if row.work.task}<span class="mt-1 block line-clamp-2 text-xs leading-relaxed text-muted-foreground">{row.work.task}</span>{/if}<span class="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2">{#if row.attention && view.presence !== "ended"}<Badge variant="destructive">Needs you</Badge>{:else}<span class="text-[10px] text-muted-foreground">{row.read_only ? "Read-only session" : row.invocation_kind}</span>{/if}<span class="text-[10px] text-muted-foreground" title={exactTime(row.heartbeat_at)}>Heartbeat {age(row.heartbeat_at)} ago</span></span></span>
  </button>
{/snippet}

<Dialog.Root bind:open={forceOpen}>
  <Dialog.Content class="sm:max-w-md"><Dialog.Header><Dialog.Title>Force close this session?</Dialog.Title><Dialog.Description>End the portal session for {forceTarget?.username} on {forceTarget?.host}. This works when the relay cannot accept a close request. The local client may take time to observe it.</Dialog.Description></Dialog.Header><Dialog.Footer><Button variant="ghost" onclick={() => (forceOpen = false)} disabled={$force.isPending}>Cancel</Button><Button variant="destructive" disabled={!canManage || !enabled || $force.isPending || !forceTarget} onclick={() => { if (forceTarget && canManage && enabled) $force.mutate({ id: forceTarget.id }); }}>{$force.isPending ? "Ending…" : "Force close session"}</Button></Dialog.Footer></Dialog.Content>
</Dialog.Root>

<style>
  .client-select { height: 2.25rem; width: 100%; min-width: 8rem; border: 1px solid hsl(var(--input)); border-radius: calc(var(--radius) - 2px); background: hsl(var(--card)); padding: .375rem 2rem .375rem .625rem; font-size: .75rem; }
  .client-select:focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 2px; }
</style>
