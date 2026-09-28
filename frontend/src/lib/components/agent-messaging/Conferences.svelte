<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query';
  import { writable } from 'svelte/store';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { conferencesOptions } from '$lib/api/agentConferences';
  import { relativeTime } from '$lib/utils/format';
  import ConferenceInspector from './ConferenceInspector.svelte';
  let { limit = 100 }: { limit?: number } = $props();
  const status = $derived(['open', 'adjourned', 'all'].includes(page.url.searchParams.get('conference_status') ?? '') ? page.url.searchParams.get('conference_status')! : 'open');
  const selected = $derived(page.url.searchParams.get('conference_id') ?? '');
  const validId = $derived(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(selected));
  const options = writable(conferencesOptions('open', 100));
  $effect(() => { options.set(conferencesOptions(status, limit)); });
  const rooms = createQuery(options);
  function navigate(key: string, value: string) {
    const url = new URL(page.url);
    if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    void goto(url, { keepFocus: true, noScroll: true });
  }
</script>

<section aria-label="Conferences" class="space-y-4">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div><h2 class="font-semibold">Conferences</h2><p class="text-sm text-muted-foreground">Inspect the room, its members, and every delivery. Updates automatically.</p></div>
    <label class="flex items-center gap-2 text-sm">Status
      <select aria-label="Conference status" class="rounded-md border border-input bg-background px-3 py-2" value={status} onchange={(event) => navigate('conference_status', event.currentTarget.value)}>
        <option value="open">Open and adjourning</option><option value="adjourned">Adjourned</option><option value="all">All conferences</option>
      </select>
    </label>
  </div>
  {#if $rooms.isError}<p role="alert" class="text-sm text-destructive">Could not load conferences: {$rooms.error.message}</p>{/if}
  {#if $rooms.isPending}<p class="text-sm text-muted-foreground">Loading conferences…</p>
  {:else if !$rooms.isError && !$rooms.data?.conferences.length}<p class="rounded-md border p-4 text-sm text-muted-foreground">No conferences match this status.</p>{/if}
  <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
    {#each $rooms.data?.conferences ?? [] as room (room.id)}
      <button class="min-w-0 rounded-md border p-4 text-left transition-colors hover:bg-muted/40 {selected === room.id ? 'border-primary bg-muted/40' : 'border-border'}" aria-pressed={selected === room.id} onclick={() => navigate('conference_id', room.id)}>
        <div class="flex flex-wrap items-start justify-between gap-2"><span class="break-words font-semibold">{room.topic || 'Untitled conference'}</span><span class="rounded border px-2 py-0.5 text-xs capitalize">{room.status}</span></div>
        <p class="mt-2 break-words text-sm">Chair: {room.chair?.alias ?? room.chair?.address ?? 'Unavailable'}</p>
        <p class="mt-1 text-xs text-muted-foreground">{room.member_count} active / {room.total_members} total members · {room.max_members} seats</p>
        <p class="mt-1 text-xs text-muted-foreground" title={room.deadline_at}>Deadline {relativeTime(room.deadline_at)}</p>
        <p class="mt-1 text-xs text-muted-foreground">Activity {relativeTime(room.last_activity_at ?? room.created_at)}</p>
      </button>
    {/each}
  </div>
  {#if ($rooms.data?.conferences.length ?? 0) >= limit}<p class="text-xs text-muted-foreground">Showing the newest {limit} conferences. Increase the result limit for more.</p>{/if}
  {#if selected && !validId}<p role="alert" class="text-destructive">Invalid conference ID in this link.</p>
  {:else if validId}
    {#key selected}<ConferenceInspector id={selected} onclose={() => navigate('conference_id', '')} />{/key}
  {/if}
</section>
