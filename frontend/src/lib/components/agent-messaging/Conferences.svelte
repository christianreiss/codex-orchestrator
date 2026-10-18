<script lang="ts">
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  /** Read-only conference rooms: pick one to inspect its members and every delivery. */
  import { createQuery } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { Badge } from "$lib/components/ui/badge";
  import { StateBlock } from "$lib/components/page";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { conferencesOptions } from "$lib/api/agentConferences";
  import ConferenceInspector from "./ConferenceInspector.svelte";

  let { limit = 100 }: { limit?: number } = $props();

  const status = $derived(["open", "adjourned", "all"].includes(page.url.searchParams.get("conference_status") ?? "") ? page.url.searchParams.get("conference_status")! : "open");
  const selected = $derived(page.url.searchParams.get("conference_id") ?? "");
  const validId = $derived(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(selected));
  const rooms = createQuery(reactiveOptions(() => conferencesOptions(status, limit)));

  function navigate(key: string, value: string) {
    const url = new URL(page.url);
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
    void goto(url, { keepFocus: true, noScroll: true });
  }
</script>

<section aria-label="Conferences" class="space-y-3">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <h2 class="text-h3">Conferences</h2>
      <p class="text-body-sm text-muted-foreground">Inspect the room, its members, and every delivery. Updates automatically.</p>
    </div>
    <label class="flex items-center gap-2 text-body-sm">Status
      <select aria-label="Conference status" class="h-9 rounded-md border border-input bg-card px-3 text-body-sm" value={status} onchange={(event) => navigate("conference_status", event.currentTarget.value)}>
        <option value="open">Open and adjourning</option>
        <option value="adjourned">Adjourned</option>
        <option value="all">All conferences</option>
      </select>
    </label>
  </div>
  {#if $rooms.isError}
    <StateBlock state="error" message={`Could not load conferences: ${$rooms.error.message}`} onRetry={() => $rooms.refetch()} />
  {:else if $rooms.isPending}
    <StateBlock state="loading" rows={3} />
  {:else if !$rooms.data?.conferences.length}
    <StateBlock state="empty" message="No conferences match this status" />
  {:else}
    <ul class="divide-y rounded-md border">
      {#each $rooms.data.conferences as room (room.id)}
        <li>
          <button
            type="button"
            class="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-left hover:bg-muted/40 {selected === room.id ? 'bg-muted/40' : ''}"
            aria-pressed={selected === room.id}
            onclick={() => navigate("conference_id", room.id)}
          >
            <span class="min-w-0 flex-1 break-words text-body font-medium">{room.topic || "Untitled conference"}</span>
            <Badge variant="outline" class="capitalize">{room.status}</Badge>
            <span class="text-caption text-muted-foreground">
              Chair {room.chair?.alias ?? room.chair?.address ?? "unavailable"} · {room.member_count} active / {room.total_members} members · {room.max_members} seats ·
              <span title={room.deadline_at}>deadline <Timestamp value={room.deadline_at} /></span> · activity <Timestamp value={room.last_activity_at ?? room.created_at} />
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if ($rooms.data?.conferences.length ?? 0) >= limit}<p class="text-caption text-muted-foreground">Showing the newest {limit} conferences. Increase the result limit for more.</p>{/if}
  {#if selected && !validId}
    <p role="alert" class="text-destructive">Invalid conference ID in this link.</p>
  {:else if validId}
    {#key selected}<ConferenceInspector id={selected} onclose={() => navigate("conference_id", "")} />{/key}
  {/if}
</section>
