<script lang="ts">
  import { base } from "$app/paths";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { tick, onDestroy, untrack } from "svelte";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import Users from "@lucide/svelte/icons/users";
  import Info from "@lucide/svelte/icons/info";
  import PinIcon from "@lucide/svelte/icons/pin";
  import SmilePlus from "@lucide/svelte/icons/smile-plus";
  import * as Popover from "$lib/components/ui/popover";
  import {
    MAX_ROOM_PINS,
    QUICK_REACTIONS,
    reactionLabel,
    type PinnedEntry,
    type ReactionSummary,
  } from "$lib/portal/room-annotations";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Sheet from "$lib/components/ui/sheet";
  import { authStore } from "$lib/stores/auth";
  import { api } from "$lib/api/client";
  import {
    roomHistoryOptions,
    roomKeys,
    roomRoot,
    emptyRoomDraft,
    type RoomDraft,
    type RoomEvent,
    type RoomHistory,
  } from "$lib/api/roomChats";
  import type { AgentAddress } from "$lib/api/agentMessaging";
  import MarkdownBody from "./MarkdownBody.svelte";
  import AttachmentList from "./AttachmentList.svelte";
  import ChatUploads from "./ChatUploads.svelte";
  let {
    id,
    draft = $bindable(emptyRoomDraft()),
    onclose,
  }: { id: string; draft?: RoomDraft; onclose: () => void } = $props();
  const client = useQueryClient();
  const canRead = $derived($authStore.can("agent_messaging.reveal_content"));
  const canWrite = $derived($authStore.can("agent_messaging.manage"));
  const history = createQuery(
    reactiveOptions(() => roomHistoryOptions(id, canRead)),
  );
  const candidates = createQuery(
    reactiveOptions(() => ({
      queryKey: ["agent-messaging", "chat-candidates"],
      queryFn: () =>
        api.get<{ addresses: AgentAddress[] }>(
          "/admin/agent-messaging/addresses",
        ),
      enabled: canWrite,
    })),
  );
  const room = $derived($history.data?.room);
  // Reactions and pins (servers with migration 0119). A confirmed toggle result overrides
  // the last read until the history refreshes; events on older pages keep their copy.
  let confirmedReactions = $state<Record<string, ReactionSummary[]>>({}),
    confirmedPins = $state<string[] | null>(null),
    annotating = $state<string | null>(null),
    pinsOpen = $state(false),
    pickerFor = $state<string | null>(null);
  $effect(() => {
    void $history.dataUpdatedAt;
    const fresh = new Set(($history.data?.events ?? []).map((e) => e.id));
    confirmedPins = null;
    confirmedReactions = Object.fromEntries(
      Object.entries(untrack(() => confirmedReactions)).filter(([eventId]) => !fresh.has(eventId)),
    );
  });
  const pinned = $derived(confirmedPins ?? $history.data?.pinned ?? []);
  const annotationsSupported = $derived(Array.isArray($history.data?.pinned));
  const pins = createQuery(
    reactiveOptions(() => ({
      queryKey: [...roomKeys, id, "pins"],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get<{ room_id: string; pins: PinnedEntry[] }>(
          `${roomRoot}/${encodeURIComponent(id)}/pins`,
          { signal },
        ),
      enabled: canRead && pinsOpen,
    })),
  );
  let older = $state<RoomEvent[]>([]),
    before = $state<string | null | undefined>(undefined),
    busy = $state(false),
    loadingOlder = $state(false),
    error = $state(""),
    details = $state(false),
    closeOpen = $state(false),
    invite = $state("");

  let scroller = $state<HTMLDivElement>(),
    input = $state<HTMLTextAreaElement>(),
    heading = $state<HTMLHeadingElement>();
  let following = $state(true),
    missed = $state(0),
    lastId = "",
    restored = false;
  const events = $derived(
    [
      ...new Map(
        [...older, ...($history.data?.events ?? [])].map((e) => [e.id, e]),
      ).values(),
    ].sort(
      (a, b) =>
        a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
    ),
  );
  const writable = $derived(
    canWrite && canRead && room?.status === "open" && !$history.isError,
  );
  const selectedNames = $derived(
    draft.recipients.map(
      (id) => room?.members.find((m) => m.id === id)?.name ?? "Former member",
    ),
  );
  $effect(() => {
    const newest = events.at(-1)?.id;
    if (!newest || newest === lastId) return;
    lastId = newest;
    void tick().then(() => {
      if (!scroller) return;
      if (!restored) {
        scroller.scrollTop = draft.scrollTop ?? scroller.scrollHeight;
        restored = true;
        following =
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <
          60;
      } else if (following) scroller.scrollTop = scroller.scrollHeight;
      else missed++;
      if (following) markRead();
    });
  });
  $effect(() => {
    if (heading) heading.focus({ preventScroll: true });
  });
  function markRead() {
    const newest = events.at(-1);
    if (newest)
      void api
        .post(`${roomRoot}/seen`, { room_id: id, through: newest.created_at })
        .then(() =>
          client.invalidateQueries({ queryKey: roomKeys, exact: true }),
        )
        .catch(() => {});
  }
  function scroll() {
    if (!scroller) return;
    following =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    draft.scrollTop = scroller.scrollTop;
    if (following && missed) {
      missed = 0;
      markRead();
    }
  }
  function latest() {
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
      following = true;
      missed = 0;
      markRead();
    }
  }
  async function earlier() {
    if (loadingOlder) return;
    loadingOlder = true;
    error = "";
    const height = scroller?.scrollHeight ?? 0,
      top = scroller?.scrollTop ?? 0;
    try {
      const page = await api.post<RoomHistory>(`${roomRoot}/read`, {
        room_id: id,
        before: before === undefined ? $history.data?.next_before : before,
      });
      older = [...page.events, ...older];
      before = page.next_before;
      await tick();
      if (scroller) scroller.scrollTop = top + scroller.scrollHeight - height;
    } catch (e) {
      error = String(e);
    } finally {
      loadingOlder = false;
    }
  }
  async function send(askAll = false) {
    if (busy || !writable || draft.uploads.some((u) => u.state !== "ready"))
      return;
    draft.pending ??= {
      room_id: id,
      client_request_id: crypto.randomUUID(),
      content: draft.text,
      attachments: draft.uploads.map((u) => u.id),
      reply_to: draft.replyTo,
      recipients: askAll ? [] : draft.recipients,
      ask_all: askAll,
    };
    busy = true;
    error = "";
    try {
      await api.post(`${roomRoot}/send`, draft.pending);
      draft = { ...emptyRoomDraft(), manageRequest: draft.manageRequest };
      following = true;
      await client.invalidateQueries({ queryKey: roomKeys });
    } catch (e) {
      error = e instanceof Error ? e.message : "Message could not be confirmed";
    } finally {
      busy = false;
    }
  }
  function mention(memberId: string) {
    if (!memberId || draft.pending) return;
    const member = room?.members.find((m) => m.id === memberId);
    if (!member) return;
    draft.recipients = [...new Set([...draft.recipients, memberId])];
    input?.focus();
  }
  async function manage(
    action: "invite" | "remove" | "close",
    addressId?: string,
  ) {
    if (busy || room?.workflow_managed || room?.workflow_run_id) return;
    draft.manageRequest ??= {
      room_id: id,
      client_request_id: crypto.randomUUID(),
      action,
      address_id: addressId,
    };
    busy = true;
    error = "";
    try {
      await api.post(`${roomRoot}/manage`, draft.manageRequest);
      draft.manageRequest = null;
      invite = "";
      closeOpen = false;
      await client.invalidateQueries({ queryKey: roomKeys });
    } catch (e) {
      error =
        e instanceof Error ? e.message : "Operation could not be confirmed";
    } finally {
      busy = false;
    }
  }
  const reactionsOf = (event: RoomEvent) =>
    confirmedReactions[event.id] ?? event.reactions ?? [];
  const pinnedPreview = $derived(events.find((e) => e.id === pinned[0])?.content ?? "");
  async function react(event: RoomEvent, emoji: string, on: boolean) {
    if (annotating || !writable) return;
    annotating = `${event.id}:${emoji}`;
    error = "";
    try {
      // Set semantics on the server: a retry after an unconfirmed response is harmless.
      const result = await api.post<{ reactions: ReactionSummary[] }>(
        `${roomRoot}/${encodeURIComponent(id)}/events/${encodeURIComponent(event.id)}/reactions`,
        { emoji, on, client_request_id: crypto.randomUUID() },
      );
      confirmedReactions = { ...confirmedReactions, [event.id]: result.reactions };
      pickerFor = null;
    } catch (e) {
      error = e instanceof Error ? e.message : "Reaction could not be confirmed";
    } finally {
      annotating = null;
    }
  }
  async function pin(eventId: string, on: boolean) {
    if (annotating || !writable) return;
    annotating = `${eventId}:pin`;
    error = "";
    try {
      const result = await api.post<{ pinned: string[] }>(
        `${roomRoot}/${encodeURIComponent(id)}/events/${encodeURIComponent(eventId)}/pin`,
        { on, client_request_id: crypto.randomUUID() },
      );
      confirmedPins = result.pinned;
      await client.invalidateQueries({ queryKey: [...roomKeys, id, "pins"] });
    } catch (e) {
      error = e instanceof Error ? e.message : "Pin could not be confirmed";
    } finally {
      annotating = null;
    }
  }
  async function jumpTo(eventId: string) {
    pinsOpen = false;
    await tick();
    const target = document.getElementById(`room-event-${eventId}`);
    if (target) {
      target.scrollIntoView({ block: "center" });
      target.focus({ preventScroll: true });
    } else
      error =
        "That message is older than the loaded history. Use Earlier messages to load it.";
  }
  onDestroy(() => {
    if (scroller) draft.scrollTop = scroller.scrollTop;
  });
</script>

<div class="flex h-full min-h-0 flex-col" aria-label="Shared conversation">
  <header class="flex min-h-16 shrink-0 items-center gap-3 border-b px-4 py-3">
    <Button
      variant="ghost"
      size="icon"
      class="lg:hidden"
      aria-label="Back to conversations"
      onclick={onclose}><ArrowLeft class="h-4 w-4" /></Button
    >
    <span class="grid h-9 w-9 shrink-0 place-content-center rounded-md bg-muted"
      ><Users class="h-5 w-5" /></span
    >
    <div class="min-w-0 flex-1">
      <h2
        bind:this={heading}
        tabindex="-1"
        class="break-words text-body font-semibold focus:outline-none"
      >
        {room?.title ?? "Conversation"}
      </h2>
      <p class="text-caption text-muted-foreground">
        {room?.kind === "conference"
          ? "Conference"
          : room?.kind === "group"
            ? "Group"
            : room?.kind === "host"
              ? "Host room"
              : room?.kind === "project"
                ? "Project room"
                : "Room"}{#if room}
          · {room.members.length}
          {room.members.length === 1
            ? "participant"
            : "participants"}{#if room.status !== "open"}
            · {room.status}{/if}{/if}{#if room?.owner_admin_id}
          · Operator chaired{/if}
      </p>
    </div>
    <Button
      variant="ghost"
      size="icon"
      aria-label="Conversation details"
      aria-expanded={details}
      onclick={() => (details = !details)}><Info class="h-4 w-4" /></Button
    >
  </header>
  {#if room?.workflow_run_id}<div class="flex flex-wrap items-center justify-between gap-2 border-b bg-muted px-4 py-2 text-body-sm"><p>{room.status === "closed" ? "Completed run group · retained history" : "Workflow run group · membership follows the run"}</p><a class="underline" href={`${base}/workflows/runs/${encodeURIComponent(room.workflow_run_id)}`}>Run report and controls</a></div>{/if}
  {#if canRead && pinned.length}<div
      class="flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-body-sm"
    >
      <PinIcon class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <button
        type="button"
        class="min-h-8 min-w-0 flex-1 truncate text-left underline-offset-4 hover:underline focus-visible:underline pointer-coarse:min-h-11"
        aria-haspopup="dialog"
        onclick={() => (pinsOpen = true)}
        >{pinned.length} pinned {pinned.length === 1 ? "message" : "messages"}{#if pinnedPreview}<span
            class="text-muted-foreground"> · {pinnedPreview.slice(0, 80)}</span
          >{/if}</button
      >
    </div>{/if}
  <div class="relative flex min-h-0 flex-1">
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      {#if !canRead}<p class="p-6 text-body-sm">
          Reading this room requires message content access.
        </p>
      {:else if $history.isPending}<p
          role="status"
          class="p-6 text-body-sm text-muted-foreground"
        >
          Loading conversation…
        </p>
      {:else}
        {#if $history.isError}<div
            role="alert"
            class="border-b p-3 text-body-sm"
          >
            <p>Could not refresh this conversation. Your draft is kept.</p>
            <Button
              variant="outline"
              size="sm"
              onclick={() => $history.refetch()}>Retry</Button
            >
          </div>{/if}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (The named scroll region needs keyboard scrolling.) -->
        <div
          bind:this={scroller}
          onscroll={scroll}
          class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6"
          role="region"
          aria-label="Conversation history"
          tabindex="0"
        >
          {#if before === undefined ? $history.data?.next_before : before}<div
              class="mb-5 text-center"
            >
              <Button
                variant="ghost"
                size="sm"
                disabled={loadingOlder}
                onclick={earlier}>Earlier messages</Button
              >
            </div>{/if}
          {#if !events.length && !$history.isError}<div
              class="mx-auto max-w-sm py-12 text-center"
            >
              <h3 class="text-body font-medium">No messages yet</h3>
              <p
                class="mt-2 text-body-sm leading-relaxed text-muted-foreground"
              >
                Share a first thought or a file. Choose an @recipient when you
                want an agent to answer.
              </p>
            </div>{/if}
          <div class="mx-auto max-w-[65ch] space-y-6">
            {#each events as event, i (event.id)}
              {#if i === 0 || event.created_at.slice(0, 10) !== events[i - 1].created_at.slice(0, 10)}<p
                  class="py-2 text-center text-caption text-muted-foreground"
                >
                  {new Date(event.created_at).toLocaleDateString(undefined, {
                    dateStyle: "medium",
                  })}
                </p>{/if}
              <article
                id={`room-event-${event.id}`}
                tabindex="-1"
                class="group min-w-0 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Message from ${event.name}`}
              >
                <div class="mb-1 flex flex-wrap items-baseline gap-x-2">
                  <span class="text-body-sm font-semibold">{event.name}</span
                  >{#if event.actor.startsWith("admin:")}<span
                      class="text-caption text-muted-foreground">Operator</span
                    >{/if}<time
                    class="text-caption text-muted-foreground"
                    datetime={event.created_at}
                    title={new Date(event.created_at).toLocaleString()}
                    >{new Date(event.created_at).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}</time
                  >{#if pinned.includes(event.id)}<span
                      class="inline-flex items-center gap-1 text-caption text-muted-foreground"
                      ><PinIcon class="h-3 w-3" aria-hidden="true" />Pinned</span
                    >{/if}
                </div>
                {#if event.reply_to}<p
                    class="mb-2 border-l-2 pl-2 text-caption text-muted-foreground"
                  >
                    Reply to {events.find((e) => e.id === event.reply_to)
                      ?.name ?? "an earlier message"}
                  </p>{/if}
                <div class="text-body-sm leading-relaxed">
                  <MarkdownBody text={event.content} />
                </div>
                {#if event.attachments.length}<AttachmentList
                    session={`room:${id}`}
                    ids={event.attachments}
                  />{/if}
                {#if reactionsOf(event).length}<div
                    class="mt-2 flex flex-wrap gap-1.5"
                    role="group"
                    aria-label="Reactions"
                  >
                    {#each reactionsOf(event) as reaction (reaction.emoji)}<button
                        type="button"
                        class="inline-flex min-h-8 items-center gap-1 rounded border px-2 text-caption tabular-nums transition-colors pointer-coarse:min-h-11 {reaction.mine
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'bg-background text-muted-foreground hover:bg-muted'}"
                        aria-pressed={reaction.mine}
                        aria-label={reactionLabel(reaction)}
                        disabled={!writable || !!annotating}
                        onclick={() => react(event, reaction.emoji, !reaction.mine)}
                        ><span aria-hidden="true">{reaction.emoji}</span><span
                          aria-hidden="true">{reaction.count}</span
                        ></button
                      >{/each}
                  </div>{/if}
                <div
                  class="mt-1 flex flex-wrap items-center gap-3 text-caption text-muted-foreground"
                >
                  {#if writable && event.kind === "chat"}<button
                      type="button"
                      class="min-h-8 underline-offset-4 hover:underline focus-visible:underline"
                      onclick={() => {
                        draft.replyTo = event.id;
                        input?.focus();
                      }}>Reply</button
                    >{/if}
                  {#if writable && annotationsSupported && event.reactions}<Popover.Root
                      open={pickerFor === event.id}
                      onOpenChange={(open) => (pickerFor = open ? event.id : null)}
                      ><Popover.Trigger>
                        {#snippet child({ props })}<button
                            {...props}
                            type="button"
                            class="inline-flex min-h-8 items-center gap-1 underline-offset-4 hover:underline focus-visible:underline pointer-coarse:min-h-11"
                            disabled={!!annotating}
                            ><SmilePlus class="h-3.5 w-3.5" aria-hidden="true" />React</button
                          >{/snippet}
                      </Popover.Trigger>
                      <Popover.Content class="w-auto p-2" align="start">
                        <div
                          class="flex flex-wrap gap-1"
                          role="group"
                          aria-label="Choose a reaction"
                        >
                          {#each QUICK_REACTIONS as emoji (emoji)}<button
                              type="button"
                              class="grid h-9 w-9 place-content-center rounded text-body hover:bg-muted focus-visible:bg-muted pointer-coarse:h-11 pointer-coarse:w-11"
                              aria-label={`React with ${emoji}`}
                              aria-pressed={reactionsOf(event).some(
                                (r) => r.emoji === emoji && r.mine,
                              )}
                              disabled={!!annotating}
                              onclick={() =>
                                react(
                                  event,
                                  emoji,
                                  !reactionsOf(event).some(
                                    (r) => r.emoji === emoji && r.mine,
                                  ),
                                )}>{emoji}</button
                            >{/each}
                        </div>
                      </Popover.Content></Popover.Root
                    ><button
                      type="button"
                      class="min-h-8 underline-offset-4 hover:underline focus-visible:underline pointer-coarse:min-h-11"
                      disabled={!!annotating ||
                        (!pinned.includes(event.id) &&
                          pinned.length >= MAX_ROOM_PINS)}
                      title={!pinned.includes(event.id) &&
                      pinned.length >= MAX_ROOM_PINS
                        ? `A conversation keeps at most ${MAX_ROOM_PINS} pinned messages`
                        : undefined}
                      onclick={() => pin(event.id, !pinned.includes(event.id))}
                      >{pinned.includes(event.id) ? "Unpin" : "Pin"}</button
                    >{/if}
                  {#if event.deliveries?.length}<details>
                      <summary class="cursor-pointer py-1"
                        >{event.deliveries.length} answer request{event
                          .deliveries.length === 1
                          ? ""
                          : "s"}</summary
                      >
                      <ul>
                        {#each event.deliveries as d}<li>
                            {room?.members.find((m) => m.id === d.address_id)
                              ?.name ?? "Former member"} · {d.status}
                          </li>{/each}
                      </ul>
                    </details>{/if}
                </div>
              </article>
            {/each}
          </div>
        </div>
        <p class="sr-only" role="status">
          {missed
            ? `${missed} new messages. Use the New messages button to read them.`
            : ""}
        </p>
        {#if missed}<Button
            variant="outline"
            size="sm"
            class="mx-auto my-2"
            onclick={latest}>New messages ↓</Button
          >{/if}
        {#if error}<p
            role="alert"
            class="border-t px-4 py-2 text-body-sm text-destructive"
          >
            {error}
          </p>{/if}
        {#if canWrite && room}
          {#if !writable}<p
              class="border-t p-4 text-body-sm text-muted-foreground"
            >
              {room.workflow_run_id && room.status === "closed"
                ? "This run is complete. Its group is closed; history remains readable."
                : room.status === "adjourning"
                ? "This conference is closing. Outstanding answers can still arrive."
                : room.status === "adjourned"
                  ? "This conference has ended. Its retained history remains readable."
                  : room.status === "disabled"
                    ? "Scope coordination is disabled."
                    : "Sending is unavailable until the conversation refreshes."}
            </p>
          {:else}
            {#if draft.replyTo}<div
                class="flex items-center justify-between border-t px-4 py-2 text-caption"
              >
                <span
                  >Replying to {events.find((e) => e.id === draft.replyTo)
                    ?.name ?? "an earlier message"}</span
                ><button
                  type="button"
                  disabled={!!draft.pending}
                  onclick={() => (draft.replyTo = undefined)}
                  >Cancel reply</button
                >
              </div>{/if}
            <ChatUploads
              session={`room:${id}`}
              items={draft.uploads}
              onitems={(_, items) => (draft.uploads = items)}
              disabled={busy || !!draft.pending}
            />
            <form
              class="shrink-0 space-y-2 border-t p-3 sm:p-4"
              onsubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label for="room-message" class="sr-only"
                >Message this conversation</label
              ><textarea
                id="room-message"
                bind:this={input}
                bind:value={draft.text}
                readonly={!!draft.pending}
                disabled={busy}
                rows="3"
                maxlength="30000"
                placeholder="Write to the room…"
                class="block max-h-44 min-h-20 w-full resize-y rounded border border-input bg-background px-3 py-2 text-body-sm"
                onkeydown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void send();
                  }
                }}></textarea>
              {#if selectedNames.length}<div class="flex flex-wrap gap-2">
                  {#each draft.recipients as recipient}<button
                      type="button"
                      disabled={!!draft.pending}
                      class="min-h-8 rounded border px-2 text-caption"
                      aria-label={`Remove recipient ${room.members.find((m) => m.id === recipient)?.name ?? recipient}`}
                      onclick={() =>
                        (draft.recipients = draft.recipients.filter(
                          (r) => r !== recipient,
                        ))}
                      >@{room.members.find((m) => m.id === recipient)?.name ??
                        "Former member"} ×</button
                    >{/each}
                </div>{/if}
              <div class="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Ask an agent"
                  class="h-9 min-w-0 max-w-48 rounded border border-input bg-background px-2 text-body-sm"
                  disabled={busy || !!draft.pending}
                  value=""
                  onchange={(e) => {
                    mention(e.currentTarget.value);
                    e.currentTarget.value = "";
                  }}
                  ><option value="">@ Ask an agent</option
                  >{#each room.members as member}<option value={member.id}
                      >{member.name}{member.reachable
                        ? ""
                        : " · unavailable"}</option
                    >{/each}</select
                ><div class="ml-auto flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy ||
                    !!draft.pending ||
                    (!draft.text.trim() && !draft.uploads.length) ||
                    draft.uploads.some((u) => u.state !== "ready") ||
                    !room.members.some((m) => m.reachable)}
                  onclick={() => send(true)}>Ask the room</Button
                >
                <Button
                  type="submit"
                  disabled={busy ||
                    (!draft.text.trim() && !draft.uploads.length) ||
                    draft.uploads.some((u) => u.state !== "ready")}
                  >{busy
                    ? "Sending…"
                    : draft.pending
                      ? "Retry send"
                      : "Send"}</Button
                >
                </div>
              </div>
              <p class="text-caption text-muted-foreground">
                {draft.pending
                  ? "Send was not confirmed. Retry keeps the same request."
                  : selectedNames.length
                    ? `One answer requested from ${selectedNames.join(", ")}.`
                    : "Shared with the room. Only @recipients or “Ask the room” are asked to answer."}
              </p>
            </form>
          {/if}
        {/if}
      {/if}
    </div>
    <Sheet.Root bind:open={details}
      ><Sheet.Content class="w-full overflow-y-auto sm:max-w-sm"
        >{#if room}<Sheet.Header
            ><Sheet.Title>Participants</Sheet.Title><Sheet.Description
              >{room.title}</Sheet.Description
            ></Sheet.Header
          >
          {#if room.description}<p
              class="mb-4 break-words text-body-sm text-muted-foreground"
            >
              {room.description}
            </p>{/if}
          <ul class="divide-y">
            {#each room.members as member}<li class="py-3">
                <p class="break-words text-body-sm font-medium">
                  {member.name}
                </p>
                <p class="text-caption text-muted-foreground">
                  {member.engine} · {member.chat_capable === false ? "Update cxx to answer" : member.reachable
                    ? "Available"
                    : "Unavailable"}{member.role === "owner" ? " · Chair" : ""}
                </p>
                {#if canWrite && !room.workflow_managed && !room.workflow_run_id && room.status === "open" && ["group", "conference"].includes(room.kind) && member.role !== "owner"}<button
                    type="button"
                    class="mt-1 min-h-8 text-caption underline"
                    disabled={busy || !!draft.manageRequest}
                    onclick={() => manage("remove", member.id)}
                    >Remove from room</button
                  >{/if}
              </li>{/each}
          </ul>
          {#if canWrite && !room.workflow_managed && !room.workflow_run_id && room.status === "open" && ["group", "conference"].includes(room.kind)}<label
              class="mt-4 block text-body-sm"
              >Invite an agent<select
                bind:value={invite}
                disabled={busy || !!draft.manageRequest}
                class="mt-1 h-9 w-full rounded border border-input bg-background px-2"
                ><option value="">Choose agent…</option
                >{#each ($candidates.data?.addresses ?? []).filter((a) => a.engine !== "server" && !room.members.some((m) => m.id === a.id)) as agent}<option
                    value={agent.id}
                    >{agent.name ?? agent.alias ?? agent.address}</option
                  >{/each}</select
              ></label
            ><Button
              class="mt-2"
              size="sm"
              variant="outline"
              disabled={!invite || busy || !!draft.manageRequest}
              onclick={() => manage("invite", invite)}>Invite</Button
            >{/if}
          <p class="mt-5 text-caption text-muted-foreground">
            {room.workflow_run_id ? "Run group history is retained with its report. Leaving this view does not delete it." : "History follows the room’s existing server retention rules. Leaving this view does not delete it."}
          </p>
          {#if room.deadline_at}<p
              class="mt-2 text-caption text-muted-foreground"
            >
              Deadline: {new Date(room.deadline_at).toLocaleString()}
            </p>{/if}
          {#if canWrite && !room.workflow_managed && !room.workflow_run_id && room.kind === "conference" && room.status === "open"}<div
              class="mt-6 border-t pt-4"
            >
              <Button
                variant="outline"
                class="text-destructive"
                disabled={busy || !!draft.manageRequest}
                onclick={() => { details = false; void tick().then(() => closeOpen = true); }}>End conference</Button
              >
            </div>{/if}
          {#if room.workflow_run_id}<p class="mt-3 text-body-sm">Invitations, membership and closure are managed by the run. <a class="underline" href={`${base}/workflows/runs/${encodeURIComponent(room.workflow_run_id)}`}>Open run controls</a></p>{/if}
          {#if draft.manageRequest && !busy && !room.workflow_managed && !room.workflow_run_id}<p class="mt-3 text-caption">
              Operation not confirmed.
            </p>
            <Button
              variant="outline"
              onclick={() =>
                manage(
                  draft.manageRequest!.action as "invite" | "remove" | "close",
                )}>Retry operation</Button
            >{/if}
        {/if}</Sheet.Content
      ></Sheet.Root
    >
  </div>
</div>
<Sheet.Root bind:open={pinsOpen}
  ><Sheet.Content class="w-full overflow-y-auto sm:max-w-sm"
    ><Sheet.Header
      ><Sheet.Title>Pinned messages</Sheet.Title><Sheet.Description
        >{room?.title ?? "Conversation"} · {pinned.length} of {MAX_ROOM_PINS}</Sheet.Description
      ></Sheet.Header
    >
    {#if $pins.isPending}<p role="status" class="text-body-sm text-muted-foreground">
        Loading pinned messages…
      </p>
    {:else if $pins.isError}<div role="alert" class="text-body-sm">
        <p>Pinned messages could not be loaded.</p>
        <Button
          variant="outline"
          size="sm"
          class="mt-2"
          onclick={() => $pins.refetch()}>Retry</Button
        >
      </div>
    {:else if !$pins.data?.pins.length}<p class="text-body-sm text-muted-foreground">
        No pinned messages. Pin a message from its actions to keep it here.
      </p>
    {:else}<ul class="divide-y">
        {#each $pins.data.pins as entry (entry.event_id)}<li class="py-3">
            <p class="text-body-sm font-medium">
              {entry.event?.name ?? "Message no longer retained"}
            </p>
            {#if entry.event}<p
                class="mt-1 break-words text-body-sm text-muted-foreground"
              >
                {entry.event.snippet || (entry.event.attachments ? "Attachment" : "")}
              </p>
              <p class="mt-1 text-caption text-muted-foreground">
                <time
                  datetime={entry.event.created_at}
                  title={new Date(entry.event.created_at).toLocaleString()}
                  >{new Date(entry.event.created_at).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}</time
                >
              </p>{/if}
            <div class="mt-1 flex gap-3 text-caption">
              {#if entry.event}<button
                  type="button"
                  class="min-h-8 underline pointer-coarse:min-h-11"
                  onclick={() => jumpTo(entry.event_id)}>Show in conversation</button
                >{/if}
              {#if writable}<button
                  type="button"
                  class="min-h-8 underline pointer-coarse:min-h-11"
                  disabled={!!annotating}
                  onclick={() => pin(entry.event_id, false)}>Unpin</button
                >{/if}
            </div>
          </li>{/each}
      </ul>{/if}
    {#if error && pinsOpen}<p role="alert" class="mt-3 text-body-sm text-destructive">
        {error}
      </p>{/if}
  </Sheet.Content></Sheet.Root
>
<Dialog.Root bind:open={closeOpen}
  ><Dialog.Content
    ><Dialog.Header
      ><Dialog.Title>End {room?.title}?</Dialog.Title><Dialog.Description
        >New rounds stop. Outstanding answers may finish before the conference
        closes. Its history remains subject to server retention.</Dialog.Description
      ></Dialog.Header
    ><Dialog.Footer
      ><Button variant="ghost" onclick={() => (closeOpen = false)}
        >Keep open</Button
      ><Button
        variant="destructive"
        disabled={busy}
        onclick={() => manage("close")}>End conference</Button
      ></Dialog.Footer
    ></Dialog.Content
  ></Dialog.Root
>
