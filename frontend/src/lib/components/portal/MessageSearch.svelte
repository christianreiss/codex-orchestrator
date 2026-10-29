<script lang="ts">
  import * as Sheet from "$lib/components/ui/sheet";
  import { Button } from "$lib/components/ui/button";
  import { api } from "$lib/api/client";
  import { authStore } from "$lib/stores/auth";
  import {
    highlightSegments,
    searchPath,
    type SearchHit,
    type SearchPage,
  } from "$lib/portal/room-annotations";

  let {
    open = $bindable(false),
    onroom,
    onclient,
  }: {
    open?: boolean;
    onroom: (id: string) => void;
    onclient: (id: string) => void;
  } = $props();

  const canDirect = $derived($authStore.can("agent_portal.reveal_transcript"));
  let q = $state(""),
    scope = $state<"all" | "rooms" | "direct">("all"),
    hits = $state<SearchHit[]>([]),
    next = $state<string | null>(null),
    truncated = $state(false),
    scanned = $state(0),
    searched = $state<{ q: string; scope: "all" | "rooms" | "direct" } | null>(null),
    busy = $state(false),
    error = $state("");

  // Search runs on submit only: each request decrypts up to 2000 events on the server.
  async function run(more: boolean) {
    const term = more ? searched : { q: q.trim().replace(/\s+/g, " "), scope };
    if (!term || term.q.length < 2 || busy) {
      if (!more) error = "Enter at least two characters.";
      return;
    }
    busy = true;
    error = "";
    try {
      const page = await api.get<SearchPage>(
        searchPath({ q: term.q, scope: term.scope, cursor: more ? next : null }),
      );
      hits = more ? [...hits, ...page.results] : page.results;
      next = page.next_cursor;
      truncated = page.truncated;
      scanned = (more ? scanned : 0) + page.scanned;
      searched = term;
    } catch (e) {
      error = e instanceof Error ? e.message : "Search failed";
    } finally {
      busy = false;
    }
  }
  function choose(hit: SearchHit) {
    open = false;
    if (hit.scope === "room") onroom(hit.conversation_id);
    else onclient(hit.conversation_id);
  }
</script>

<Sheet.Root bind:open
  ><Sheet.Content class="flex w-full flex-col overflow-y-auto sm:max-w-md"
    ><Sheet.Header
      ><Sheet.Title>Search messages</Sheet.Title><Sheet.Description
        >Finds literal text in the newest messages you may read. Search text is not stored or
        logged.</Sheet.Description
      ></Sheet.Header
    >
    <form
      role="search"
      class="space-y-3"
      onsubmit={(e) => {
        e.preventDefault();
        void run(false);
      }}
    >
      <label class="block text-body-sm"
        >Search text<input
          type="search"
          class="mt-1 h-9 w-full rounded border border-input bg-background px-3"
          minlength="2"
          maxlength="200"
          required
          bind:value={q}
        /></label
      >
      <div class="flex items-end gap-2">
        <label class="block flex-1 text-body-sm"
          >Conversations<select
            class="mt-1 h-9 w-full rounded border border-input bg-background px-3"
            bind:value={scope}
            ><option value="all">All</option><option value="rooms">Shared rooms</option
            >{#if canDirect}<option value="direct">Direct messages</option>{/if}</select
          ></label
        >
        <Button type="submit" disabled={busy}>{busy && !hits.length ? "Searching…" : "Search"}</Button>
      </div>
    </form>
    {#if error}<p role="alert" class="mt-3 text-body-sm text-destructive">{error}</p>{/if}
    <div class="mt-4 min-h-0 flex-1" aria-live="polite" aria-busy={busy}>
      {#if searched && !hits.length && !busy && !error}
        <p class="text-body-sm text-muted-foreground">
          No messages match “{searched.q}”{truncated ? " in the newest messages scanned" : ""}.
        </p>
      {/if}
      {#if hits.length}
        <p class="text-caption text-muted-foreground tabular-nums">
          {hits.length} {hits.length === 1 ? "match" : "matches"} · {scanned} messages scanned
        </p>
        <ul class="mt-2 divide-y">
          {#each hits as hit (`${hit.conversation_key}:${hit.event_id}`)}<li>
              <button
                type="button"
                class="w-full rounded px-1 py-3 text-left hover:bg-muted/60 focus-visible:bg-muted/60"
                onclick={() => choose(hit)}
              >
                <span class="flex items-baseline justify-between gap-2 text-caption">
                  <span class="min-w-0 truncate font-medium text-foreground"
                    >{hit.title}<span class="font-normal text-muted-foreground">
                      · {hit.scope === "room" ? "Room" : "Direct"}</span
                    ></span
                  ><time
                    class="shrink-0 text-muted-foreground"
                    datetime={hit.created_at}
                    title={new Date(hit.created_at).toLocaleString()}
                    >{new Date(hit.created_at).toLocaleDateString(undefined, {
                      dateStyle: "medium",
                    })}</time
                  >
                </span>
                <span class="mt-0.5 block text-caption text-muted-foreground">{hit.author}</span>
                <span class="mt-1 block break-words text-body-sm"
                  >{#each highlightSegments(hit.snippet, hit.highlights) as part, i (i)}{#if part.mark}<mark
                        class="rounded-sm bg-warning-muted px-0.5 text-foreground">{part.text}</mark
                      >{:else}{part.text}{/if}{/each}</span
                >
              </button>
            </li>{/each}
        </ul>
      {/if}
      {#if truncated || next}
        <div class="mt-3 space-y-2 border-t pt-3 text-caption text-muted-foreground">
          {#if truncated}<p>
              The scan stopped at its limit. Older messages may still match.
            </p>{/if}
          {#if next}<Button variant="outline" size="sm" disabled={busy} onclick={() => run(true)}
              >{busy ? "Searching…" : "Search older messages"}</Button
            >{/if}
        </div>
      {/if}
    </div>
  </Sheet.Content></Sheet.Root
>
