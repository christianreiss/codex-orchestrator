<script lang="ts">
  import { reactiveOptions } from '$lib/components/projects/reactive-options.svelte';
  import { createInfiniteQuery } from '@tanstack/svelte-query';
  import { goto } from '$app/navigation';
  import UsersIcon from '@lucide/svelte/icons/users';
  import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
  import HashIcon from '@lucide/svelte/icons/hash';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import RoomConversation from './RoomConversation.svelte';
  import NewRoom from './NewRoom.svelte';
  import { roomOptions, emptyRoomDraft, matchingRooms, roomKindLabel, type RoomDraft, type ChatRoom } from '$lib/api/roomChats';
  import { engineLabel } from "$lib/constants/engines";
  import { tick, untrack, type Snippet } from "svelte";
  import { base } from "$app/paths";
  import { hostDaemonsQuery } from "$lib/api/hostDaemons";
  import { remoteForAgent } from "$lib/portal/remote-sessions";
  import { useQueryClient } from "@tanstack/svelte-query";
  import BotIcon from "@lucide/svelte/icons/bot";
  import PowerOffIcon from "@lucide/svelte/icons/power-off";
  import SearchIcon from "@lucide/svelte/icons/search";
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
  import InfoIcon from "@lucide/svelte/icons/info";
  import { toast } from "svelte-sonner";
  import { page } from "$app/state";
  import RemoteSessions from "$lib/components/portal/RemoteSessions.svelte";
  import ChatUploads from "$lib/components/portal/ChatUploads.svelte";
  import type { UploadItem } from "$lib/portal/chat-files";
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
  import { shortAge } from "$lib/portal/browser";
  import { liveActivity } from "$lib/portal/activity";
  import { presenceView } from "$lib/portal/presence";
  import { listTime, visibleTimeline } from "$lib/portal/grouping";
  import { clientClock, snapshotIsStale, visibleClients, type ClientFilter } from "$lib/portal/clients";
  import { watchClientEvents, type ClientFeedState } from "$lib/portal/client-events";
  import type { TimelineSource } from "$lib/portal/types";
  import { reconnectReceiverMutation, agentSessionKeys, agentSessionsQuery, forceCloseMutation, requestCloseMutation, sendMutation, sessionEventsQuery, type AgentSessionRow } from "$lib/api/agentSessions";

  type Props = {
    embedded?: boolean;
    sessionId?: string | null;
    spawnHost?: number;
    spawnOpen?: boolean;
    /** Directory filters, owned by the Agents page toolbar. */
    search?: string;
    engine?: "all" | "codex" | "claude" | "grok";
    filter?: ClientFilter;
    /** "agents" or "remote" (daemon-launched sessions). */
    workspace?: "agents" | "remote";
    /** Open the "start remote session" dialog. */
    startRemote?: boolean;
    selectedId?: string | null;
    /** Show this agent's connection in the shared inspector. */
    oninspect?: (id: string) => void;
  };
  let {
    embedded = false,
    sessionId = null,
    spawnHost,
    spawnOpen = $bindable(false),
    search = $bindable(""),
    engine = $bindable("all"),
    filter = $bindable("active"),
    workspace = $bindable("agents"),
    startRemote = $bindable(false),
    selectedId = $bindable(null),
    oninspect,
  }: Props = $props();
  const sessions = agentSessionsQuery();
  const reconnectReceiver = reconnectReceiverMutation();
  const client = useQueryClient();
  const canManage = $derived($authStore.can("agent_portal.manage"));
  const canReadTranscript = $derived($authStore.can("agent_portal.reveal_transcript"));
  const canRemoteManage = $derived($authStore.can("agent_messaging.manage"));
  const sharedRooms = createInfiniteQuery(reactiveOptions(()=>roomOptions(!embedded && $authStore.can('agent_messaging.read'))));
  const roomData = $derived($sharedRooms.data ? {enabled:$sharedRooms.data.pages[0]?.enabled, rooms:$sharedRooms.data.pages.flatMap(p=>p.rooms ?? []), has_more:$sharedRooms.hasNextPage} : undefined);
  const selectedRoom = $derived(embedded ? null : page.url.searchParams.get('room'));
  const roomRows = $derived(matchingRooms(roomData?.rooms ?? [], search, engine));
  $effect(()=>{if(selectedRoom&&!roomDrafts[selectedRoom])roomDrafts[selectedRoom]=emptyRoomDraft();});
  let newRoomOpen = $state(false);
  let roomDrafts = $state<Record<string,RoomDraft>>({});
  async function selectRoom(id: string | null) {
    selectedId = null;
    const url = new URL(page.url); url.searchParams.delete('session');
    if(id) url.searchParams.set('room',id); else url.searchParams.delete('room');
    await goto(url,{keepFocus:true,noScroll:true});
    if(!id) await tick().then(()=>document.getElementById('shared-room-heading')?.focus());
  }
  const daemonHosts = hostDaemonsQuery(() => canRemoteManage);
  let remoteId = $state<string | null>(null);
  const remoteRows = $derived(($daemonHosts.data?.hosts ?? []).flatMap(host => host.sessions));
  let handledLink = $state("");
  $effect(() => {
    if (embedded) return;
    const link = page.url.search;
    if (link === handledLink) return;
    const id = page.url.searchParams.get("session");
    if (id && ($sessions.isPending || (canRemoteManage && $daemonHosts.isPending))) return;
    const remote = page.url.searchParams.get("remote");
    if (canRemoteManage && (remote || page.url.searchParams.get("view") === "remote")) {
      workspace = "remote"; remoteId = remote;
    }
    handledLink = link;
    if (id) {
      selectedId = id;
      const match = remoteForAgent(($sessions.data?.sessions ?? []).find(row => row.id === id), remoteRows);
      if (match && canRemoteManage) { workspace = "remote"; remoteId = match.id; }
    }
  });
  let embeddedSelection = $state<string | null | undefined>(undefined);
  $effect(() => {
    if (!embedded || !sessionId || embeddedSelection === sessionId || $sessions.isPending || (canRemoteManage && $daemonHosts.isPending)) return;
    embeddedSelection = sessionId;
    selectedId = sessionId;
    const match = remoteForAgent(($sessions.data?.sessions ?? []).find(row => row.id === sessionId), remoteRows);
    remoteId = match?.id ?? null;
    workspace = match && canRemoteManage ? "remote" : "agents";
  });
  $effect(() => { if (embedded && spawnOpen) { workspace = "remote"; startRemote = true; } });
  $effect(() => { if (embedded && !startRemote) spawnOpen = false; });
  let now = $state(Date.now());
  let detailHeading = $state<HTMLHeadingElement | null>(null);
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const allRows = $derived($sessions.data?.sessions ?? []);
  const rows = $derived(allRows.filter(row => !canRemoteManage || !remoteForAgent(row, remoteRows)));
  const enabled = $derived($sessions.data?.enabled ?? true);
  const timings = $derived($sessions.data?.timings ?? {});
  const serverNow = $derived(clientClock($sessions.data, $sessions.dataUpdatedAt, now));
  const stale = $derived(Boolean($sessions.data) && snapshotIsStale($sessions.dataUpdatedAt, now, timings));
  const visible = $derived(visibleClients(rows, { search, engine, filter, sort: "status" }, serverNow, timings));
  const selected = $derived(allRows.find((row) => row.id === selectedId) ?? null);
  const selectedView = $derived(selected ? presenceView(selected, serverNow, timings) : null);
  const actionsUnavailable = $derived(!enabled || stale || $sessions.isError);
  const disabledReason = $derived(!enabled ? "Agent sessions are disabled. Your draft is kept."
    : actionsUnavailable ? "Refresh client status before sending. Your draft is kept." : "");
  $effect(() => {
    if ($sessions.data && selectedId && !allRows.some((row) => row.id === selectedId)) selectedId = null;
  });

  async function selectClient(id: string) {
    if(selectedRoom) { const url=new URL(page.url);url.searchParams.delete('room');url.searchParams.set('session',id);await goto(url,{keepFocus:true,noScroll:true}); }
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
    if (workspace === "remote") remoteId = null;
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
  let uploads = $state<Record<string, UploadItem[]>>({});
  let replyTargets = $state<Record<string, number | undefined>>({});
  let drafts = $state<Record<string, string>>({});
  let failedSends = $state<Record<string, { content: string; prompt: { id: string; version: number } | null; metadata: {attachments?:string[];reply_to?:number;choice_value?:string}; actor: string }>>({});
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
    const items = uploads[id] ?? [];
    if (items.some(i => i.state !== 'ready')) { toast.warning('Finish or remove pending uploads before sending.'); return false; }
    if (!text.trim() && !items.length) return false;
    const metadata = {attachments: items.map(i => i.id), reply_to: replyTargets[id], choice_value: currentQuestion ? text : undefined};
    const previous = failedSends[id];
    // A lost answer response may be followed by pending_prompt=null. Retrying
    // unchanged composer text must not turn the original answer into a message.
    const intent = (!prompt || prompt.id === previous?.prompt?.id) && previous?.actor === actor && previous.content === text.trim() && JSON.stringify({...metadata,choice_value:undefined}) === JSON.stringify({...previous.metadata,choice_value:undefined})
      ? previous : { content: text.trim(), prompt: prompt ? { id: prompt.id, version: prompt.version } : null, metadata, actor };
    try {
      const result = await $send.mutateAsync({ id, content: intent.content, prompt: intent.prompt, metadata: intent.metadata });
      const retained = { ...failedSends }; delete retained[id]; failedSends = retained;
      if (deliveryFailed(result)) {
        toast.warning("This instruction was not delivered. Your draft is kept.");
        return false;
      }
      // Preserve any edits made while this request was in flight.
      if ((drafts[id] ?? "").trim() === text.trim()) drafts = { ...drafts, [id]: "" };
      uploads = {...uploads, [id]: []}; replyTargets = {...replyTargets,[id]:undefined};
      return true;
    } catch {
      // A later denial cannot prove an earlier ambiguous attempt was rejected.
      // Keep the original answer intent until success or an explicitly new send.
      failedSends = { ...failedSends, [id]: intent };
      return false;
    }
  }
  function onreply(option?: string) { if (option) void submit(option, true); else composerInput?.focus(); }
  function refresh() { void client.invalidateQueries({ queryKey: ["host-daemons"] }); void client.invalidateQueries({ queryKey: ["daemon-sessions"] }); void client.invalidateQueries({ queryKey: agentSessionKeys.all }); if (feedState === "reconnecting") feedRetry++; }
  function resetFilters() { search = ""; engine = "all"; filter = "active"; }
  function agentName(row: AgentSessionRow) { return row.launch_name || row.session_name || row.work.address_alias || `Session ${row.id.slice(0, 8)}`; }
  function age(value: string | null, clock = serverNow) { return value ? shortAge(value, clock) || "unknown" : "unknown"; }
  function exactTime(value: string | null) { const date = value ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date.toLocaleString() : "Not reported"; }
  let detailsOpen = $state(false);
  function preview(row: AgentSessionRow, ended: boolean) {
    const ask = row.pending_prompt?.question ?? row.attention?.summary;
    if (ask && !ended) return ask;
    return row.preview?.summary || row.task_title || row.work.task?.split("\n")[0] || "No summary reported";
  }
</script>

{#if canRemoteManage}
  <RemoteSessions active={workspace === "remote"} hosts={$daemonHosts.data?.hosts ?? []} loading={$daemonHosts.isPending} error={$daemonHosts.error} stale={!$daemonHosts.dataUpdatedAt || now - $daemonHosts.dataUpdatedAt > 45_000} agents={allRows} bind:selectedId={remoteId} bind:startOpen={startRemote} {refresh}
    onselect={(id) => { selectedId = id; }} fixedHost={embedded ? spawnHost : Number(page.url.searchParams.get("host")) || undefined} compact={embedded}>
    {#snippet conversation(id: string, controls: Snippet, live: boolean)}
      {#if selected?.id === id}{@render nativeConversation(controls, live)}{/if}
    {/snippet}
  </RemoteSessions>
{/if}

{#if embedded && workspace === "agents"}
  {#if selected}{@render nativeConversation()}{:else}<p class="p-4 text-body-sm text-muted-foreground">{$sessions.isPending ? "Loading conversation…" : "Session unavailable."}</p>{/if}
{:else if workspace === "agents"}
{#if $sessions.isPending && !$sessions.data && !roomData?.enabled}
  <div role="status" aria-label="Loading clients" class="space-y-2 lg:w-80">
    {#each Array(5) as _, i (i)}<div class="flex items-center gap-3"><Skeleton class="h-9 w-9 rounded-full" /><Skeleton class="h-9 flex-1 rounded-md" /></div>{/each}
  </div>
{:else if $sessions.isError && !$sessions.data && !roomData?.enabled}
  <div role="alert" class="rounded-md border border-destructive/30 bg-destructive/5 p-6">
    <h2 class="font-semibold">Clients could not be loaded</h2>
    <p class="mt-1 text-body-sm text-muted-foreground">{$sessions.error?.message ?? "The server is unreachable."}</p>
    <Button class="mt-4" variant="outline" onclick={refresh} disabled={$sessions.isFetching}>Retry clients</Button>
  </div>
{:else}
  {#if $sessions.isError || stale}
    <div role="status" class="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/30 bg-warning-muted px-4 py-2.5 text-body-sm">
      <div class="min-w-0"><p class="font-medium">{$sessions.isError ? "Client refresh failed" : "Client status is stale"}</p><p class="mt-0.5 text-caption text-muted-foreground">{$sessions.error?.message ?? "A recent status check has not completed."} Last known clients remain visible; refresh before sending instructions.</p></div>
      <Button variant="outline" size="sm" onclick={refresh} disabled={$sessions.isFetching}>Retry status</Button>
    </div>
  {/if}
  {#if !enabled && !roomData?.enabled}
    <EmptyState icon={PowerOffIcon} title="Agent sessions are off" description="Client registration is paused. Enable agent sessions in Fleet → Policies to record new sessions." />
    {#if canManage}<a class="text-body-sm text-primary underline" href={`${base}/settings#agents`}>Agent session settings</a>{/if}
  {:else if rows.length === 0 && !$authStore.can("agent_messaging.read")}
    <EmptyState icon={BotIcon} title="No recorded clients" description="A session appears when cdx, clx, or cgx registers its session. Clients that cannot reach the server may appear after reconnecting." />
  {:else}
    <!-- One Messages-style card: conversation list on the left, thread on the right. -->
    <div class="grid h-[calc(75dvh-4rem)] min-h-[28rem] grid-cols-1 overflow-hidden rounded-md border bg-card lg:h-[calc(100dvh-14rem)] lg:grid-cols-[20rem_minmax(0,1fr)]">
      <section class="min-h-0 min-w-0 flex-col border-r {selected || selectedRoom ? 'hidden lg:flex' : 'flex'}" aria-label="Client directory">
        <div class="flex items-center justify-between border-b px-3 py-2 text-caption text-muted-foreground">
          <h2 id="shared-room-heading" tabindex="-1" class="font-medium text-foreground">Conversations</h2>
          {#if canRemoteManage}<Button variant="ghost" size="icon" class="h-8 w-8" aria-label="New conversation" onclick={()=>newRoomOpen=true}><PlusIcon class="h-4 w-4"/></Button>{/if}
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
          <h3 class="px-3 pb-1 pt-3 text-caption font-medium text-muted-foreground">Direct messages <span class="ml-1 tabular-nums">{visible.length}</span></h3>
          {#if !visible.length}
            <div class="px-3 py-3 text-caption text-muted-foreground">{#if rows.length}<h3 class="font-medium">No clients match</h3>{:else}<p>No direct conversations yet.</p>{/if}{#if rows.length}<button type="button" class="mt-1 min-h-8 text-primary underline" onclick={resetFilters}>Clear filters</button>{/if}</div>
          {:else}
            {#each visible as row (row.id)}{@render sessionRow(row)}{/each}
          {/if}
          {#if $authStore.can('agent_messaging.read')}
            {#if $sharedRooms.isPending}<p role="status" class="p-3 text-caption text-muted-foreground">Loading shared conversations…</p>
            {:else if $sharedRooms.isError}<div role="alert" class="p-3 text-caption"><p>Shared conversations could not refresh.</p><Button variant="ghost" size="sm" onclick={()=> $sharedRooms.refetch()}>Retry rooms</Button></div>
            {:else if !roomData?.enabled}<p class="p-3 text-caption text-muted-foreground">Agent messaging is disabled.</p>{/if}
            {#each ['project','host','group','conference'] as kind}
              {@const rooms=roomRows.filter(r=>r.kind===kind)}
              {#if rooms.length}<h3 class="px-3 pb-1 pt-5 text-caption font-medium text-muted-foreground">{roomKindLabel(kind as ChatRoom['kind'])} <span class="ml-1 tabular-nums">{rooms.length}</span></h3>
                {#each rooms as room (room.id)}
                  <button id={`room-${room.id}`} type="button" class="flex w-full items-start gap-3 rounded-md px-3 py-3 text-left transition-colors hover:bg-muted/60 {selectedRoom===room.id?'bg-muted':''}" aria-pressed={selectedRoom===room.id} onclick={()=>selectRoom(room.id)}>
                    <span class="mt-0.5 grid h-9 w-9 shrink-0 place-content-center rounded-md border bg-background">{#if room.kind==='conference'}<MessagesSquareIcon class="h-4 w-4"/>{:else if room.kind==='group'}<UsersIcon class="h-4 w-4"/>{:else}<HashIcon class="h-4 w-4"/>{/if}</span>
                    <span class="min-w-0 flex-1"><span class="flex items-baseline justify-between gap-2"><span class="break-words text-body-sm font-medium">{room.title}</span>{#if room.unread}<span class="shrink-0 rounded bg-primary px-1.5 text-caption text-primary-foreground" aria-label={`${room.unread} unread messages`}>{room.unread}</span>{/if}</span><span class="mt-0.5 block truncate text-caption text-muted-foreground">{room.members.slice(0,3).map(m=>m.name).join(', ')||'No participants'}{room.members.length>3?` +${room.members.length-3}`:''}</span><span class="mt-1 block text-caption text-muted-foreground">{room.status==='open'?`${room.members.length} participants`:room.status}{#if room.last_activity_at} · {listTime(room.last_activity_at,new Date(serverNow))}{/if}</span></span>
                  </button>
                {/each}
              {/if}
            {/each}
            {#if roomData?.enabled&&!roomRows.length}<p class="p-3 text-caption text-muted-foreground">{search?'No shared conversations match.':'No shared conversations yet.'}</p>{/if}
            {#if roomData?.has_more}<Button variant="ghost" size="sm" class="m-2" disabled={$sharedRooms.isFetchingNextPage} onclick={()=> $sharedRooms.fetchNextPage()}>More conversations</Button>{/if}
          {/if}
        </div>
      </section>

      <section class="min-h-0 min-w-0 flex-col {selected || selectedRoom ? 'flex' : 'hidden lg:flex'}" aria-label="Client details">
        {#if selectedRoom && roomDrafts[selectedRoom]}
          {#key selectedRoom}<RoomConversation id={selectedRoom} bind:draft={roomDrafts[selectedRoom]} onclose={()=>selectRoom(null)}/>{/key}
        {:else if !selected || !selectedView}
          <div class="grid flex-1 place-content-center p-8 text-center"><BotIcon class="mx-auto h-8 w-8 text-muted-foreground/60" /><h2 class="mt-3 text-body-sm font-medium">Choose a conversation</h2><p class="mx-auto mt-1 max-w-xs text-caption leading-relaxed text-muted-foreground">Direct messages, shared rooms and conferences, together in one place.</p></div>
        {:else}
          {@render nativeConversation()}
        {/if}
      </section>
    </div>
  {/if}
{/if}

{/if}

{#snippet nativeConversation(remoteControls?: Snippet, remoteLive = false)}
  {#if selected && selectedView}
          <div id="client-detail" class="flex min-h-0 flex-1 flex-col">
            {#if remoteControls}
              <div class="flex shrink-0 items-center gap-2 border-b px-4 py-2">
                <EngineAvatar engine={selected.engine} presence={selectedView.presence} size="xs" logo />
                <p class="min-w-0 flex-1 truncate text-caption text-muted-foreground"><span class="font-medium text-foreground">{agentName(selected)}</span> · {selected.cwd}{#if remoteLive} · {selectedView.label}{/if}</p>
                <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0" aria-expanded={detailsOpen} aria-controls="client-info" aria-label="Session details" onclick={() => detailsOpen = !detailsOpen}><InfoIcon class="h-4 w-4" /></Button>
              </div>
            {:else}
            <header class="grid shrink-0 grid-cols-[5.5rem_1fr_5.5rem] items-center border-b px-2 py-1.5">
              <div><Button variant="ghost" size="sm" class="-ml-1 px-1.5 text-primary lg:hidden" onclick={closeDetail}><ChevronLeftIcon class="h-5 w-5" /> Agents</Button></div>
              <div class="flex min-w-0 flex-col items-center text-center">
                <EngineAvatar engine={selected.engine} presence={selectedView.presence} activity={liveActivity(selected, serverNow)} status={selectedView.label} size="xs" badge logo />
                <h2 bind:this={detailHeading} tabindex="-1" class="mt-0.5 max-w-full truncate text-caption font-semibold focus:outline-none">{agentName(selected)}</h2>
                <p class="max-w-full truncate text-caption text-muted-foreground" title={selected.cwd}>{selected.cwd}</p>
                <p class="max-w-full truncate text-caption text-muted-foreground">
                  {engineLabel(selected.engine)} · {selectedView.label}{selected.read_only ? " · Read-only" : ""}{#if selected.activity || selectedView.presence !== "listening"}{" · "}<span title={selectedView.detail}>{selectedView.detail}</span>{/if}{#if canReadTranscript}{" · "}<span>{feedState === "live" ? "Live timeline updates" : feedState === "connecting" ? "Connecting to live updates…" : "Live updates reconnecting"}</span>{/if}
                </p>
              </div>
              <div class="flex justify-end">
                <Button variant="ghost" size="icon" class="h-8 w-8 rounded-full {detailsOpen ? 'text-primary' : 'text-muted-foreground'}" aria-expanded={detailsOpen} aria-controls="client-info" aria-label="Session details" title="Session details" onclick={() => (detailsOpen = !detailsOpen)}><InfoIcon class="h-4 w-4" /></Button>
              </div>
            </header>
            {/if}
            {#if selected.reboot}
              <div class="border-b bg-muted/20 px-4 py-2 text-caption" role="status">
                Planned reboot · {selected.reboot.state}
                {#if selected.reboot.new_session_id && selected.reboot.new_session_id !== selected.id}
                  <button class="ml-2 underline" onclick={() => selectClient(selected!.reboot!.new_session_id!)}>Open resumed session</button>
                {:else if selected.reboot.old_session_id !== selected.id}
                  <button class="ml-2 underline" onclick={() => selectClient(selected!.reboot!.old_session_id)}>Open previous session</button>
                {/if}
              </div>
            {/if}
            {#if detailsOpen}
              <div id="client-info" class="max-h-[50%] shrink-0 overflow-y-auto border-b bg-muted/20 px-4 py-3 text-caption">
                <p class="leading-relaxed text-muted-foreground">{selectedView.detail}</p>
                <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                  <dt class="text-muted-foreground">Heartbeat</dt><dd title={exactTime(selected.heartbeat_at)}>{age(selected.heartbeat_at)} ago</dd>
                  <dt class="text-muted-foreground">Host</dt><dd>{selected.username} on {selected.host ?? `host ${selected.host_id}`}</dd>
                  <dt class="text-muted-foreground">Summary</dt><dd>{preview(selected, selectedView.presence === "ended")}</dd>
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
                {#if oninspect}<Button class="mt-3" variant="outline" size="sm" onclick={() => oninspect(selected!.id)}>Connection details</Button>{/if}
                {#if !remoteControls && canManage && !selected.ended_at && !selected.read_only}
                  <div class="mt-3 flex flex-wrap gap-2 border-t pt-3">{#if selectedView.canSend && !selected.close}<Button variant="outline" size="sm" disabled={$cooperativeClose.isPending || actionsUnavailable} onclick={() => $cooperativeClose.mutate({ id: selected.id })}>Ask to close</Button>{/if}<Button variant="outline" size="sm" class="text-destructive" disabled={$force.isPending || !enabled} onclick={() => { forceTarget = selected; forceOpen = true; }}>Force close</Button></div>
                {/if}
              </div>
            {/if}
            {#if !canReadTranscript}
              <div class="grid flex-1 place-content-center px-6 text-center"><h3 class="text-body-sm font-medium">Timeline hidden</h3><p class="mt-1 max-w-prose text-caption text-muted-foreground">Your account can view client status. Reading messages requires transcript access.</p></div>
            {:else}
              {#if $events.isError}<div role="status" class="flex items-center justify-between gap-2 border-b border-warning/20 bg-warning-muted px-4 py-1.5 text-caption"><span>{$events.data ? "Timeline refresh failed. Showing saved messages." : "Timeline could not be loaded."}</span><Button variant="ghost" size="sm" onclick={() => $events.refetch()} disabled={$events.isFetching}>Retry timeline</Button></div>{/if}
              {#if $events.isPending && !$events.data}<div class="flex-1 space-y-2 p-4" role="status" aria-label="Loading timeline">{#each Array(4) as _, i (i)}<Skeleton class="h-9 w-2/3 rounded-md {i % 2 ? 'ml-auto' : ''}" />{/each}</div>
              {:else if $events.data}{#key selected.id}<Timeline portal={timelineSource} agent={selected} onreply={remoteControls && !remoteLive ? undefined : cursor => { replyTargets = {...replyTargets,[selected.id]:cursor}; composerInput?.focus(); }} />{/key}
              {:else}<div class="flex-1"></div>{/if}
              <AttentionCard agent={selected} now={serverNow} {timings} {onreply} onresolved={refresh} busy={$send.isPending} readonly={!canManage || actionsUnavailable || (!!remoteControls && !remoteLive)} />
              {#if !remoteControls || remoteLive}{#if canManage}{#if retryingDraft}<p class="border-t bg-warning-muted px-4 py-1.5 text-caption text-muted-foreground">A previous send was not confirmed. Sending this draft again retries the same request.</p>{/if}{#if replyTargets[selected.id]}<p class="px-4 py-1 text-caption">Reply to message #{replyTargets[selected.id]} <button type="button" onclick={() => replyTargets = {...replyTargets,[selected.id]:undefined}}>Cancel</button></p>{/if}
                {#key selected.id}<ChatUploads session={selected.id} items={uploads[selected.id] ?? []} onitems={(id, items) => uploads = {...uploads,[id]:items}} disabled={$send.isPending} />{/key}
                {#if selected.pending_prompt?.answer_mode !== 'buttons'}<Composer hasAttachments={Boolean(uploads[selected.id]?.length)} agent={selected} now={serverNow} {timings} sending={$send.isPending} {draft} {disabledReason} ondraft={(text) => (drafts = { ...drafts, [selected.id]: text })} onsend={submit} bind:input={composerInput} />{/if}{/if}{/if}
            {/if}
            {#if remoteControls}{@render remoteControls()}{/if}
          </div>
  {/if}
{/snippet}

{#snippet sessionRow(row: AgentSessionRow)}
  {@const view = presenceView(row, serverNow, timings)}
  {@const ended = view.presence === "ended"}
  <ConversationRow
    id="client-{row.id}"
    engine={row.engine}
    presence={view.presence}
    title={agentName(row)}
    directory={row.cwd || "No directory reported"}
    status={view.label}
    activity={liveActivity(row, serverNow)}
    logo
    time={listTime(row.last_event_at ?? row.started_at, new Date(serverNow))}
    preview={preview(row, ended)}
    selected={row.id === selectedId}
    needsYou={Boolean(row.attention?.severity) || (Boolean(row.attention || row.pending_prompt) && !ended)}
    badge={(row.attention || row.pending_prompt) && !ended ? { kind: "attention" } : null}
    aria-pressed={row.id === selectedId}
    aria-controls={selected ? "client-detail" : undefined}
    onclick={() => selectClient(row.id)}
  />
{/snippet}

<Dialog.Root bind:open={forceOpen}>
  <Dialog.Content class="sm:max-w-md"><Dialog.Header><Dialog.Title>Force close this session?</Dialog.Title><Dialog.Description>End the portal session for {forceTarget?.username} on {forceTarget?.host}. This works when the relay cannot accept a close request. The local client may take time to observe it.</Dialog.Description></Dialog.Header><Dialog.Footer><Button variant="ghost" onclick={() => (forceOpen = false)} disabled={$force.isPending}>Cancel</Button><Button variant="destructive" disabled={!canManage || !enabled || $force.isPending || !forceTarget} onclick={() => { if (forceTarget && canManage && enabled) $force.mutate({ id: forceTarget.id }); }}>{$force.isPending ? "Ending…" : "Force close session"}</Button></Dialog.Footer></Dialog.Content>
</Dialog.Root>

{#if !embedded&&canRemoteManage}<NewRoom bind:open={newRoomOpen} oncreated={id=>selectRoom(id)}/>{/if}
