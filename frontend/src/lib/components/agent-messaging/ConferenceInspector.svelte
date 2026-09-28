<script lang="ts">
  import { createInfiniteQuery, createQuery } from '@tanstack/svelte-query';
  import { onDestroy, tick, untrack } from 'svelte';
  import { conferenceOptions, conferenceMessagesOptions, revealConference } from '$lib/api/agentConferences';
  import { authStore } from '$lib/stores/auth';
  import { Button } from '$lib/components/ui/button';
  import { relativeTime } from '$lib/utils/format';
  import type { AgentAddress } from '$lib/api/agentMessaging';
  let { id, onclose }: { id: string; onclose: () => void } = $props();
  // Each selected room mounts its own inspector and destroys its revealed bodies on exit.
  // svelte-ignore state_referenced_locally
  const detail = createQuery(conferenceOptions(id));
  // svelte-ignore state_referenced_locally
  const timeline = createInfiniteQuery(conferenceMessagesOptions(id));
  const messages = $derived([...new Map(($timeline.data?.pages ?? []).flatMap((p) => p.messages).map((m) => [m.id, m])).values()].sort((a, b) => a.dispatch_order - b.dispatch_order));
  const canReveal = $derived($authStore.can('agent_messaging.reveal_content'));
  const grants = $derived([...$authStore.capabilities].sort().join(','));
  let revealed = $state(false);
  let bodies = $state<Record<string, string>>({});
  let revealError = $state('');
  let busy = $state(false);
  let follow = $state(true);
  let scroller: HTMLDivElement | undefined = $state();
  const guard = { generation: 0, controller: null as AbortController | null };
  function hide() {
    guard.generation++;
    guard.controller?.abort();
    guard.controller = null;
    revealed = false;
    bodies = {};
    busy = false;
  }
  onDestroy(hide);
  $effect(() => { void grants; untrack(hide); });
  $effect(() => {
    if ($detail.isError || $timeline.isError) untrack(hide);
  });
  $effect(() => {
    const ids = messages.map((message) => message.id);
    if (revealed && canReveal) untrack(() => void loadBodies(ids));
  });
  async function loadBodies(ids: string[]) {
    // A new metadata refresh supersedes any previous reveal request.
    guard.controller?.abort();
    const controller = new AbortController();
    guard.controller = controller;
    const generation = ++guard.generation;
    const missing = ids.filter((messageId) => bodies[messageId] === undefined);
    busy = missing.length > 0;
    try {
      for (let offset = 0; offset < missing.length; offset += 100) {
        const result = await revealConference(id, missing.slice(offset, offset + 100), controller.signal);
        if (generation !== guard.generation || !canReveal || !revealed) return;
        bodies = { ...bodies, ...Object.fromEntries(result.messages.map((m) => [m.id, m.content ?? ''])) };
      }
    } catch (error) {
      if (generation !== guard.generation || controller.signal.aborted) return;
      hide();
      revealError = error instanceof Error ? error.message : 'Transcript reveal failed';
    } finally {
      if (generation === guard.generation) busy = false;
    }
  }
  $effect(() => {
    void messages.length;
    void bodies;
    if (follow && scroller) void tick().then(() => { if (follow && scroller) scroller.scrollTop = scroller.scrollHeight; });
  });
  function label(peer: AgentAddress | null | undefined) { return peer?.alias ?? peer?.address ?? 'Unavailable address'; }
  function failed(status: string | null) { return status !== null && ['dead', 'ambiguous', 'expired', 'canceled'].includes(status); }
</script>

<section class="min-w-0 rounded-lg border border-border" aria-label="Conference inspector">
  <header class="flex flex-wrap items-start justify-between gap-3 border-b p-4">
    <div class="min-w-0"><h2 class="break-words text-lg font-semibold">{$detail.data?.conference.topic || 'Conference inspector'}</h2><p class="break-all font-mono text-xs text-muted-foreground">{id}</p></div>
    <Button variant="ghost" onclick={onclose}>Close inspector</Button>
  </header>
  {#if $detail.isPending}<p class="p-4 text-sm">Loading conference…</p>{/if}
  {#if $detail.isError}<p role="alert" class="p-4 text-destructive">Could not load conference: {$detail.error.message}</p>{/if}
  {#if $detail.data}
    {@const room = $detail.data.conference}
    <div class="space-y-2 border-b p-4 text-sm">
      <p class="whitespace-pre-wrap break-words">{room.purpose || 'No purpose recorded.'}</p>
      <p><span class="font-medium capitalize">{room.status}</span> · Deadline <time datetime={room.deadline_at}>{new Date(room.deadline_at).toLocaleString()}</time></p>
      {#if room.adjourn_reason}<p>Closure: {room.adjourn_reason}</p>{/if}
      {#if room.adjourned_at}<p class="text-muted-foreground">Adjourned {relativeTime(room.adjourned_at)}</p>{/if}
    </div>
    <div class="p-4">
      <h3 class="mb-3 font-semibold">Members ({$detail.data.members.length})</h3>
      <div class="grid gap-3 md:grid-cols-2">
        {#each $detail.data.members as member (member.id)}
          <article class="min-w-0 rounded-md border p-3 text-sm">
            <p class="break-words font-medium">{label(member.peer)} <span class="text-xs font-normal text-muted-foreground">{member.role === 'owner' ? 'Chair' : 'Participant'}</span></p>
            <p class="mt-1 break-words text-xs text-muted-foreground">{member.peer?.fqdn ?? 'Unknown host'} · {member.peer?.engine ?? 'Unknown engine'} · {member.peer?.presence ?? 'Unknown presence'}</p>
            <p class="mt-2 capitalize">{member.state} · {member.mode}</p>
            {#if member.purpose}<p class="mt-1 whitespace-pre-wrap break-words text-xs">{member.purpose}</p>{/if}
            {#if member.dispatch_deadline_at}<p class:text-destructive={new Date(member.dispatch_deadline_at).getTime() < Date.now()}>Task deadline {relativeTime(member.dispatch_deadline_at)}{new Date(member.dispatch_deadline_at).getTime() < Date.now() ? ' — overdue' : ''}</p>{/if}
            {#if member.dispatch_status}<p class:text-destructive={failed(member.dispatch_status)}>Dispatch delivery: {member.dispatch_status}{member.dispatch_error ? ` (${member.dispatch_error})` : ''}</p>{/if}
            <p class="mt-1 text-xs text-muted-foreground">Last report: {member.last_report_at ? relativeTime(member.last_report_at) : 'None recorded'} · Messages: {member.messages_used ?? 0}/{member.messages_budget ?? '—'}</p>
            {#if member.left_at}<p class="text-xs text-muted-foreground">Left {relativeTime(member.left_at)}</p>{/if}
            {#if member.conversation_id}<a class="mt-2 inline-block text-xs text-primary underline" href={`/admin/agent-messaging?view=deliveries&conversation_id=${member.conversation_id}`}>Inspect deliveries ({member.conversation_status})</a>{/if}
          </article>
        {/each}
      </div>
    </div>
  {/if}
  <div class="border-t p-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h3 class="font-semibold">Conference timeline</h3>
      <div class="flex flex-wrap gap-2">
        {#if revealed}<Button variant="outline" onclick={hide}>Hide transcript</Button>
        {:else if canReveal}<Button variant="outline" disabled={$timeline.isError || $detail.isError} onclick={() => { revealError = ''; revealed = true; }}>Reveal transcript</Button>{/if}
        <Button variant="ghost" onclick={() => { follow = !follow; }}>{follow ? 'Pause scrolling' : 'Follow latest'}</Button>
      </div>
    </div>
    <p class="mt-2 text-xs text-muted-foreground">{revealed ? 'Transcript revealed. New messages are revealed automatically; content access is audited.' : 'Message content stays hidden until revealed. Revealing the transcript is audited.'}</p>
    {#if revealError}<p role="alert" class="mt-2 text-sm text-destructive">{revealError}</p>{/if}
    {#if $timeline.isError}<p role="alert" class="mt-2 text-sm text-destructive">Could not load timeline: {$timeline.error.message}</p>{/if}
    {#if $timeline.hasNextPage}<Button class="mt-3" variant="outline" disabled={$timeline.isFetchingNextPage} onclick={() => { follow = false; void $timeline.fetchNextPage(); }}>Load older messages</Button>{/if}
    {#if busy}<p role="status" class="mt-2 text-xs text-muted-foreground">Revealing messages…</p>{/if}
    <div class="mt-3 max-h-[65vh] space-y-3 overflow-y-auto overscroll-contain" bind:this={scroller} onscroll={() => { if (scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 80) follow = false; }}>
      {#if $timeline.isPending}<p class="text-sm">Loading messages…</p>{:else if !messages.length && !$timeline.isError}<p class="text-sm text-muted-foreground">No messages in this conference yet.</p>{/if}
      {#each messages as message (message.id)}
        <article class="rounded-md border p-3 text-sm" data-message-id={message.id}>
          <div class="flex flex-wrap justify-between gap-2"><p class="min-w-0 break-words font-medium">{label(message.sender)} → {label(message.target)}</p><span class="text-xs" class:text-destructive={failed(message.status)}>{message.status}</span></div>
          <p class="mt-1 text-xs text-muted-foreground"><time datetime={message.created_at}>{new Date(message.created_at).toLocaleString()}</time> · {message.attempts} delivery attempts{message.reply_to_message_id ? ' · Reply' : ''}</p>
          {#if message.last_error_code}<p class="mt-1 text-xs text-destructive">{message.last_error_code}</p>{/if}
          {#if revealed && canReveal && bodies[message.id] !== undefined}<pre class="mt-3 whitespace-pre-wrap break-words font-sans text-sm">{bodies[message.id]}</pre>
          {:else}<p class="mt-2 text-xs text-muted-foreground">{message.content_bytes} bytes · Content hidden</p>{/if}
        </article>
      {/each}
    </div>
  </div>
</section>
