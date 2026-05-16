<script lang="ts">
  import { page } from "$app/state";
  import { createQuery } from "@tanstack/svelte-query";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import * as Card from "$lib/components/ui/card";
  import { Badge } from "$lib/components/ui/badge";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import * as Alert from "$lib/components/ui/alert";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte.js";
  import { ApiError } from "$lib/api/client";
  import { fetchChanges, projectKeys } from "$lib/api/projects";
  import { relativeTime } from "$lib/utils/format";
  import type { ProjectChange } from "$lib/api/types";

  const slug = $derived(page.params.slug ?? "");

  const changesQuery = createQuery(
    reactiveOptions(() => ({
      queryKey: projectKeys.changes(slug),
      queryFn: () => fetchChanges(slug, 0),
      enabled: slug.length > 0,
    })),
  );

  // "Last 10 events reversed" — newest at top, take 10.
  const events = $derived(
    [...($changesQuery.data?.changes ?? [])]
      .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
      .slice(0, 10),
  );

  let expanded = $state<Set<number>>(new Set());
  function toggle(id: number) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  function actionLabel(change: ProjectChange): string {
    if (change.event_type && change.action) return `${change.event_type}.${change.action}`;
    return change.action ?? "event";
  }
</script>

<div class="flex flex-col gap-4">
  <h2 class="text-sm font-medium text-muted-foreground">
    Latest events {events.length > 0 ? `(showing ${events.length})` : ""}
  </h2>

  {#if $changesQuery.isLoading}
    <Skeleton class="h-20 w-full" />
  {:else if $changesQuery.isError}
    <Alert.Root variant="destructive">
      <Alert.Title>Could not load activity</Alert.Title>
      <Alert.Description>
        {$changesQuery.error instanceof ApiError ? $changesQuery.error.message : "Unknown error"}
      </Alert.Description>
    </Alert.Root>
  {:else if events.length === 0}
    <div class="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
      No activity yet.
    </div>
  {:else}
    <ol class="flex flex-col gap-2">
      {#each events as ev (ev.seq)}
        {@const isOpen = expanded.has(ev.seq)}
        <li>
          <Card.Root>
            <button
              type="button"
              class="flex w-full items-center gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              onclick={() => toggle(ev.seq)}
              aria-expanded={isOpen}
            >
              <span class="text-muted-foreground">
                {#if isOpen}
                  <ChevronDown class="h-4 w-4" />
                {:else}
                  <ChevronRight class="h-4 w-4" />
                {/if}
              </span>
              <Badge variant="outline" class="font-mono text-xs">#{ev.seq}</Badge>
              <code class="text-sm">{actionLabel(ev)}</code>
              <span class="ml-auto text-xs text-muted-foreground">
                {relativeTime(ev.created_at)}
              </span>
            </button>
            {#if isOpen}
              <div class="border-t bg-muted/30 px-4 py-3">
                <pre
                  class="overflow-x-auto whitespace-pre-wrap break-all text-xs font-mono text-foreground/80"
                >{JSON.stringify(ev.payload ?? null, null, 2)}</pre>
              </div>
            {/if}
          </Card.Root>
        </li>
      {/each}
    </ol>
  {/if}
</div>
