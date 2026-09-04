<script lang="ts">
  import { useQueryClient } from "@tanstack/svelte-query";
  import BotIcon from "@lucide/svelte/icons/bot";
  import PowerOffIcon from "@lucide/svelte/icons/power-off";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import { toast } from "svelte-sonner";
  import { base } from "$app/paths";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import Composer from "$lib/components/portal/Composer.svelte";
  import EngineAvatar from "$lib/components/portal/EngineAvatar.svelte";
  import PresenceDot from "$lib/components/portal/PresenceDot.svelte";
  import Timeline from "$lib/components/portal/Timeline.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { EmptyState } from "$lib/components/ui/empty-state";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { authStore } from "$lib/stores/auth";
  import { shortAge, shortPath } from "$lib/portal/browser";
  import { GROUP_LABEL, groupAgents, presenceView, setHeartbeatFreshMs } from "$lib/portal/presence";
  import type { TimelineSource } from "$lib/portal/types";
  import {
    agentSessionKeys,
    agentSessionsQuery,
    forceCloseMutation,
    requestCloseMutation,
    sendMutation,
    sessionEventsQuery,
    type AgentSessionRow,
  } from "$lib/api/agentSessions";

  const sessions = agentSessionsQuery();
  const client = useQueryClient();

  const canManage = $derived($authStore.can("agent_portal.manage"));
  const canReadTranscript = $derived($authStore.can("agent_portal.reveal_transcript"));

  let selectedId = $state<string | null>(null);
  // One clock for the whole page. Presence ages are relative, so without a tick
  // a row would keep claiming "started 4m ago" until the next poll landed.
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  const rows = $derived($sessions.data?.sessions ?? []);
  const enabled = $derived($sessions.data?.enabled ?? true);
  const groups = $derived(groupAgents(rows, now));

  // The server owns the freshness window; adopting it keeps the client from
  // aging a heartbeat out on a different schedule than the API that served it.
  $effect(() => {
    setHeartbeatFreshMs($sessions.data?.timings.heartbeat_fresh_seconds);
  });

  const selected = $derived(rows.find((row) => row.id === selectedId) ?? null);
  $effect(() => {
    // A selection that ages out of the retention window must not strand the pane.
    if (selectedId && !rows.some((row) => row.id === selectedId)) selectedId = null;
  });

  const events = sessionEventsQuery(() => (canReadTranscript ? selectedId : null));

  /**
   * Live updates come from the portal's own event feed, not the console's
   * WebSocket: nothing publishes a WS event when a wrapper registers,
   * heartbeats, or appends an event, and one frame per agent per 15 seconds
   * would be traffic nobody reads.
   *
   * Frames re-fetch rather than being merged into the timeline by hand. It
   * costs one round trip and removes a whole class of bug -- an optimistic
   * merge has to reconcile ordering, gaps after a reconnect, and the
   * server-side decoding of encrypted payloads, and `EventSource` already
   * resumes from `Last-Event-ID` on its own.
   */
  $effect(() => {
    // Only while a timeline is actually open. The stream costs the server a
    // one-second read-and-decrypt over the whole fleet's events per connected
    // tab, and an admin parked on this page with nothing selected would pay
    // that for frames it discards -- the list has its own 15s poll.
    if (!canReadTranscript || !selectedId) return;
    // Absolute, not base-prefixed: `lib/api/client.ts` addresses the backend
    // at /admin/* directly, and SvelteKit's base happens to be the same
    // string -- prefixing it would ask for /admin/admin/...
    const stream = new EventSource("/admin/agent-sessions/events");
    let pending: ReturnType<typeof setTimeout> | null = null;
    const refresh = (sessionId: string | null) => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        // Any frame is evidence presence moved, so the list refreshes ahead of
        // its poll; the timeline only when the frame belongs to this session.
        void client.invalidateQueries({ queryKey: agentSessionKeys.list });
        if (sessionId && sessionId === selectedId) {
          void client.invalidateQueries({ queryKey: agentSessionKeys.events(sessionId) });
        }
      }, 400);
    };
    stream.addEventListener("agent", (event) => {
      try {
        const row = JSON.parse((event as MessageEvent<string>).data) as { session_id?: string };
        refresh(row.session_id ?? null);
      } catch {
        // A frame we cannot parse is still evidence something moved.
        refresh(null);
      }
    });
    return () => {
      if (pending) clearTimeout(pending);
      stream.close();
    };
  });

  let atBottom = $state(true);
  let scrollToBottom: ((smooth: boolean) => void) | null = null;
  const timelineSource: TimelineSource = {
    get timeline() {
      return $events.data?.events ?? [];
    },
    get now() {
      return now;
    },
    get atBottom() {
      return atBottom;
    },
    // The console re-fetches rather than streaming into an open list, so there
    // is never a backlog of events the reader has scrolled past.
    get missed() {
      return 0;
    },
    setAtBottom(value: boolean) {
      atBottom = value;
    },
    setScroller(fn: (smooth: boolean) => void) {
      scrollToBottom = fn;
    },
  };
  $effect(() => {
    // Jump to the newest event whenever the pane switches sessions.
    if (selectedId && $events.data) scrollToBottom?.(false);
  });

  const force = forceCloseMutation({
    onSuccess: (result) =>
      result.already_ended
        ? toast.info("That session had already ended")
        : toast.success("Session ended"),
    onError: (error) => toast.error(error.message),
  });

  const cooperativeClose = requestCloseMutation({
    onSuccess: () => toast.success("Close requested; the agent will pick it up"),
    onError: (error) => toast.error(error.message),
  });

  // The draft is keyed by session so switching panes does not hand one agent's
  // half-written instruction to another, and never cleared on failure -- losing
  // the text along with the send leaves nothing to retry.
  let drafts = $state<Record<string, string>>({});
  let composerInput = $state<HTMLTextAreaElement | null>(null);
  const draft = $derived(selectedId ? (drafts[selectedId] ?? "") : "");

  const send = sendMutation({
    onError: (error) => toast.error(error.message),
  });

  async function submit(text: string): Promise<boolean> {
    if (!selected) return false;
    const prompt = selected.pending_prompt;
    try {
      await $send.mutateAsync({
        id: selected.id,
        content: text,
        prompt: prompt ? { id: prompt.id, version: prompt.version } : null,
      });
      drafts = { ...drafts, [selected.id]: "" };
      return true;
    } catch {
      return false;
    }
  }

  /** Timeline affordances: an option answers directly, no option focuses the box. */
  function onreply(option?: string) {
    if (option) {
      void submit(option);
      return;
    }
    composerInput?.focus();
  }

  function refresh() {
    void client.invalidateQueries({ queryKey: agentSessionKeys.all });
  }

  /** Where the agent is, preferring the worktree it registered over its cwd. */
  function place(row: AgentSessionRow): string {
    return shortPath(row.work.worktree_path ?? row.cwd);
  }

  function subtitleFor(row: AgentSessionRow): string {
    const parts = [row.username, row.host ?? `host ${row.host_id}`];
    if (row.work.branch) parts.push(row.work.branch);
    return parts.filter(Boolean).join(" · ");
  }
</script>

<PageHeader
  title="Active Clients"
  subtitle="Every wrapper running against this fleet: where it is, whether it is reachable, and what it said it is working on."
>
  {#snippet actions()}
    <Button variant="outline" onclick={refresh}>
      <RefreshCwIcon class="h-4 w-4" /> Refresh
    </Button>
  {/snippet}
</PageHeader>

{#if $sessions.isPending}
  <div class="space-y-2">
    {#each Array(5) as _, i (i)}
      <Skeleton class="h-16 w-full rounded-md" />
    {/each}
  </div>
{:else if $sessions.isError}
  <div class="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
    Failed to load sessions: {$sessions.error?.message ?? "unknown error"}
  </div>
{:else if !enabled}
  <!--
    An empty list has two meanings and only one of them is "nobody is working".
    With the module off, `registerAgent` discards every registration server-side,
    so no wrapper can ever appear here however many are running.
  -->
  <EmptyState
    icon={PowerOffIcon}
    title="The Agent Portal is off"
    description="Sessions are only recorded while the module is on, so nothing can appear here until it is switched back on."
  >
    {#snippet action()}
      <Button href="{base}/agent-portal" variant="outline">Open Agent Portal settings</Button>
    {/snippet}
  </EmptyState>
{:else if rows.length === 0}
  <EmptyState
    icon={BotIcon}
    title="No agents running"
    description="A session appears the moment someone starts cdx or clx on a registered host."
  />
{:else}
  <div class="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
    <div class="space-y-5">
      {#each groups as group (group.key)}
        {@const live = group.key !== "ended"}
        {#if live}
          <section class="space-y-1.5">
            <h2 class="eyebrow">{GROUP_LABEL[group.key]} · {group.agents.length}</h2>
            {#each group.agents as row (row.id)}
              {@render sessionRow(row as AgentSessionRow)}
            {/each}
          </section>
        {/if}
      {/each}

      <!--
        Kept rather than dropped, for the reason the Git Director keeps its
        reclaimed registrations: a row that simply vanishes reads as "nobody was
        ever here", which is a worse lie than a stale one.
      -->
      {#each groups.filter((g) => g.key === "ended") as group (group.key)}
        <details class="rounded-lg border px-3 py-2">
          <summary class="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Recently ended ({group.agents.length})
          </summary>
          <div class="mt-2 space-y-1.5">
            {#each group.agents as row (row.id)}
              {@render sessionRow(row as AgentSessionRow)}
            {/each}
          </div>
        </details>
      {/each}
    </div>

    <div class="min-w-0">
      {#if !selected}
        <EmptyState
          icon={BotIcon}
          size="sm"
          title="Select a client"
          description="Pick a session to see what it has been doing."
        />
      {:else}
        {@const view = presenceView(selected, now)}
        <div class="flex h-[70vh] min-h-[420px] flex-col overflow-hidden rounded-lg border">
          <header class="flex flex-wrap items-start justify-between gap-3 border-b bg-muted/30 px-4 py-3">
            <div class="min-w-0">
              <p class="flex items-center gap-2 font-medium">
                <PresenceDot presence={view.presence} />
                {selected.username}
                <span class="text-muted-foreground">on {selected.host ?? `host ${selected.host_id}`}</span>
              </p>
              <p class="mt-0.5 truncate font-mono text-xs text-muted-foreground">{selected.cwd}</p>
              <p class="mt-1 text-xs text-muted-foreground">{view.detail}</p>
              {#if selected.work.task}
                <p class="mt-2 max-w-prose text-xs italic text-muted-foreground">{selected.work.task}</p>
              {/if}
              {#if selected.work.declared_paths.length > 0}
                <p class="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                  {selected.work.declared_paths.slice(0, 4).join(", ")}{selected.work.declared_paths.length > 4
                    ? ` +${selected.work.declared_paths.length - 4}`
                    : ""}
                </p>
              {/if}
              {#if selected.work.address}
                <p class="mt-1 font-mono text-[11px] text-muted-foreground">
                  reachable as {selected.work.address_alias ?? selected.work.address}
                </p>
              {/if}
            </div>
            {#if canManage && !selected.ended_at}
              <div class="flex shrink-0 gap-2">
                <!-- Ask first, insist second. A cooperative close is queued for
                     the agent to honour and needs an open relay; force needs
                     nothing, which is why it is the one that still works on a
                     session that has gone quiet. -->
                {#if view.canSend && !selected.close}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={$cooperativeClose.isPending}
                    title="Ask the agent to wrap up and exit when it reaches a stopping point."
                    onclick={() => $cooperativeClose.mutate({ id: selected.id })}
                  >
                    Ask to close
                  </Button>
                {/if}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={$force.isPending}
                  title="End this session now. Works even when the agent is offline and cannot accept a cooperative close."
                  onclick={() => $force.mutate({ id: selected.id })}
                >
                  Force close
                </Button>
              </div>
            {/if}
          </header>

          {#if !canReadTranscript}
            <div class="grid flex-1 place-content-center px-6 text-center">
              <p class="text-sm font-medium">Timeline hidden</p>
              <p class="mx-auto mt-1 max-w-prose text-xs text-muted-foreground">
                Reading a session's messages needs <code>agent_portal.reveal_transcript</code>. Everything
                above is available without it.
              </p>
            </div>
          {:else if $events.isPending}
            <div class="space-y-2 p-4">
              {#each Array(4) as _, i (i)}
                <Skeleton class="h-12 w-full rounded-md" />
              {/each}
            </div>
          {:else if $events.isError}
            <p class="p-4 text-sm text-destructive">
              Failed to load the timeline: {$events.error?.message ?? "unknown error"}
            </p>
          {:else}
            <Timeline portal={timelineSource} agent={selected} {onreply} readonly={!canManage} />
          {/if}

          {#if canReadTranscript && canManage}
            <!-- The same composer the portal uses, so the two surfaces cannot
                 drift on what "can I send right now" means. -->
            <Composer
              agent={selected}
              {now}
              sending={$send.isPending}
              {draft}
              ondraft={(text) => (drafts = { ...drafts, [selected.id]: text })}
              onsend={submit}
              bind:input={composerInput}
            />
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

{#snippet sessionRow(row: AgentSessionRow)}
  {@const view = presenceView(row, now)}
  <button
    type="button"
    class="flex w-full items-start gap-2.5 rounded-md border px-3 py-2.5 text-left transition
           hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring
           {row.id === selectedId ? 'border-primary bg-muted' : 'bg-card'}"
    onclick={() => (selectedId = row.id)}
  >
    <EngineAvatar engine={row.engine} />
    <span class="min-w-0 flex-1">
      <span class="flex items-center gap-1.5">
        <PresenceDot presence={view.presence} />
        <span class="truncate font-mono text-xs">{place(row)}</span>
      </span>
      <span class="mt-0.5 block truncate text-[11px] text-muted-foreground">{subtitleFor(row)}</span>
      {#if row.work.task}
        <span class="mt-1 line-clamp-2 block text-[11px] italic text-muted-foreground">{row.work.task}</span>
      {/if}
    </span>
    <span class="flex shrink-0 flex-col items-end gap-1">
      {#if row.attention}
        <Badge variant="destructive">Needs you</Badge>
      {/if}
      <span class="text-[11px] text-muted-foreground">
        {shortAge(row.last_event_at ?? row.started_at, now)}
      </span>
    </span>
  </button>
{/snippet}
