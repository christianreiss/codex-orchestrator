<script lang="ts">
  /**
   * Changelog timeline, newest first. One project (`slug`), one card
   * (`slug` + `cardId`, compact) or every project (no `slug`). Search ranks by
   * relevance; otherwise "Load older" pages back with before_id.
   */
  import { base } from "$app/paths";
  import { createInfiniteQuery, createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import ScrollText from "@lucide/svelte/icons/scroll-text";
  import Plus from "@lucide/svelte/icons/plus";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import { DataTable, Toolbar } from "$lib/components/page";
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Table from "$lib/components/ui/table";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import EventRow from "$lib/components/logs/EventRow.svelte";
  import RenderedMarkdown from "$lib/components/authoring/RenderedMarkdown.svelte";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte.js";
  import { filterClass } from "$lib/components/feedback/report-model";
  import { ApiError } from "$lib/api/client";
  import {
    CHANGELOG_KINDS,
    deleteChangelogEntry,
    fetchBoard,
    fetchChangelog,
    fetchFleetChangelog,
    projectKeys,
    type ChangelogEntry,
    type ChangelogListResponse,
  } from "$lib/api/projects";
  import ChangelogEntryDialog from "./ChangelogEntryDialog.svelte";

  type Props = {
    /** One project; omitted lists every project. */
    slug?: string | null;
    /** Narrow to one card (requires `slug`); renders compactly without filters. */
    cardId?: string | null;
  };
  let { slug = null, cardId = null }: Props = $props();

  const PAGE = 50;
  const qc = useQueryClient();
  const fleet = $derived(!slug);
  const compact = $derived(!!cardId);

  let search = $state("");
  let query = $state("");
  let kind = $state("");
  let projectFilter = $state("");
  // Debounce typing so each keystroke is not a request.
  $effect(() => {
    const next = search.trim();
    const timer = setTimeout(() => (query = next), 250);
    return () => clearTimeout(timer);
  });

  const filters = $derived({
    q: query || undefined,
    kind: kind || undefined,
    card_id: cardId || undefined,
    project: fleet ? projectFilter.trim() || undefined : undefined,
  });

  const list = createInfiniteQuery(
    reactiveOptions(() => ({
      queryKey: fleet ? projectKeys.fleetChangelog(filters) : projectKeys.changelog(slug!, filters),
      queryFn: ({ pageParam }: { pageParam: number | undefined }): Promise<ChangelogListResponse> =>
        fleet
          ? fetchFleetChangelog({ ...filters, limit: PAGE, before_id: pageParam, payloads: "full" })
          : fetchChangelog(slug!, { ...filters, limit: compact ? 5 : PAGE, before_id: pageParam, payloads: "full" }),
      initialPageParam: undefined as number | undefined,
      getNextPageParam: (last: ChangelogListResponse) => (compact ? undefined : (last.next_before_id ?? undefined)),
    })),
  );
  const entries = $derived(($list.data?.pages ?? []).flatMap((p) => p.entries));
  const degraded = $derived(($list.data?.pages ?? []).some((p) => p.degraded));

  // Card titles for the project view; the board query is usually cached already.
  const board = createQuery(
    reactiveOptions(() => ({ queryKey: projectKeys.board(slug ?? ""), queryFn: () => fetchBoard(slug!), enabled: !!slug && !compact })),
  );
  const cardLabel = (id: string): { text: string; known: boolean } => {
    const cards = $board.data?.columns?.flatMap((c) => c.cards ?? []) ?? [];
    const card = cards.find((c) => c.id === id);
    if (card) return { text: `#${card.number} ${card.title}`, known: true };
    // Only a complete board proves the card is gone; a truncated column may hold it.
    const complete = !!$board.data && !$board.data.columns.some((c) => c.truncated);
    return complete ? { text: "Card removed", known: false } : { text: id.slice(0, 8), known: true };
  };
  const cardHref = (project: string, id: string) =>
    `${base}/projects/${encodeURIComponent(project)}/board?card=${encodeURIComponent(id)}`;

  let open = $state<number | null>(null);
  let dialogOpen = $state(false);
  let editing = $state<ChangelogEntry | null>(null);
  let deleteTarget = $state<ChangelogEntry | null>(null);
  let deleteOpen = $state(false);

  const deleteMut = createMutation({
    mutationFn: (entry: ChangelogEntry) => deleteChangelogEntry(entry.project, entry.id),
    onSuccess: (_r, entry) => {
      toast.success(`Deleted changelog entry #${entry.id}`);
      void qc.invalidateQueries({ queryKey: ["project", entry.project, "changelog"] });
      void qc.invalidateQueries({ queryKey: ["projects", "changelog"] });
      deleteOpen = false;
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not delete the entry"),
  });

  const kindVariant = (k: string): "default" | "secondary" | "outline" | "destructive" =>
    k === "fix" ? "destructive" : k === "feature" ? "default" : k === "decision" ? "secondary" : "outline";
  const author = (entry: ChangelogEntry) => (entry.author_host_id == null ? "Operator" : `Host ${entry.author_host_id}`);
  const filtersActive = $derived(!!(search || kind || projectFilter));
</script>

{#if compact}
  <div class="flex items-center justify-between gap-2">
    <h3 class="text-body font-semibold">Changelog</h3>
    <Button size="sm" variant="outline" onclick={() => { editing = null; dialogOpen = true; }}><Plus class="h-4 w-4" /> New entry</Button>
  </div>
{:else}
  <Toolbar
    bind:search
    searchPlaceholder="Search changelog"
    {filtersActive}
    onClearFilters={() => { search = ""; kind = ""; projectFilter = ""; }}
    count={$list.data ? `${entries.length}${$list.hasNextPage ? "+" : ""} ${entries.length === 1 ? "entry" : "entries"}` : undefined}
  >
    {#snippet filters()}
      <select class="{filterClass} w-36" aria-label="Kind" bind:value={kind}>
        <option value="">All kinds</option>
        {#each CHANGELOG_KINDS as option (option)}<option value={option}>{option}</option>{/each}
      </select>
      {#if fleet}
        <input class="{filterClass} w-40" aria-label="Project slug" placeholder="Project slug" bind:value={projectFilter} />
      {/if}
    {/snippet}
    {#snippet actions()}
      {#if slug}<Button onclick={() => { editing = null; dialogOpen = true; }}><Plus class="h-4 w-4" /> New entry</Button>{/if}
    {/snippet}
  </Toolbar>
  {#if degraded}
    <p class="text-body-sm text-muted-foreground">Full-text index unavailable; results come from a slower substring match.</p>
  {/if}
{/if}

<DataTable
  items={entries}
  loading={$list.isLoading}
  error={$list.isError ? ($list.error instanceof ApiError ? $list.error : "Could not load the changelog") : null}
  onRetry={() => void $list.refetch()}
  key={(entry) => `${entry.project}:${entry.id}`}
  emptyIcon={ScrollText}
  emptyTitle={filtersActive ? "No matching entries" : "No changelog entries yet"}
  emptyDescription={compact
    ? "Agents record work on this card with project_changelog_append and its card_id."
    : "Agents record what changed and why with project_changelog_append. Operator entries appear here too."}
  caption={fleet ? "Changelog across projects" : "Project changelog"}
>
  {#snippet head()}
    <Table.Head class="w-8"><span class="sr-only">Details</span></Table.Head>
    <Table.Head>Entry</Table.Head>
    {#if fleet}<Table.Head>Project</Table.Head>{/if}
    {#if !compact}<Table.Head>Card</Table.Head>{/if}
    <Table.Head class="text-right">When</Table.Head>
  {/snippet}
  {#snippet row(entry: ChangelogEntry)}
    {@const key = entry.id}
    <EventRow
      expanded={open === key}
      onToggle={() => (open = open === key ? null : key)}
      label={`#${entry.id} ${entry.title}`}
      columns={(fleet ? 1 : 0) + (compact ? 0 : 1) + 2}
    >
      {#snippet cells()}
        <Table.Cell class="min-w-0">
          <div class="flex min-w-0 items-center gap-2">
            <Badge variant={kindVariant(entry.kind)} class="shrink-0">{entry.kind}</Badge>
            <span class="truncate text-body">{entry.title}</span>
          </div>
        </Table.Cell>
        {#if fleet}
          <Table.Cell><a class="text-body-sm underline-offset-2 hover:underline" href={`${base}/projects/${encodeURIComponent(entry.project)}/changelog`}>{entry.project}</a></Table.Cell>
        {/if}
        {#if !compact}
          <Table.Cell class="text-body-sm">
            {#if entry.card_id}
              {@const label = fleet ? { text: entry.card_id.slice(0, 8), known: true } : cardLabel(entry.card_id)}
              {#if label.known}
                <a class="underline-offset-2 hover:underline" href={cardHref(entry.project, entry.card_id)}>{label.text}</a>
              {:else}
                <span class="text-muted-foreground">{label.text}</span>
              {/if}
            {:else}
              <span class="text-muted-foreground">—</span>
            {/if}
          </Table.Cell>
        {/if}
        <Table.Cell class="whitespace-nowrap text-right text-body-sm text-muted-foreground"><Timestamp value={entry.created_at} /></Table.Cell>
      {/snippet}
      {#snippet detail()}
        <div class="space-y-3">
          <div class="flex flex-wrap items-center gap-x-6 gap-y-1 text-caption text-muted-foreground">
            <span><span class="font-medium text-foreground">By:</span> {author(entry)}</span>
            {#if entry.updated_at !== entry.created_at}<span><span class="font-medium text-foreground">Edited:</span> <Timestamp value={entry.updated_at} /></span>{/if}
            {#if entry.tags.length}<span class="flex flex-wrap gap-1">{#each entry.tags as tag (tag)}<Badge variant="outline">{tag}</Badge>{/each}</span>{/if}
            <span class="font-mono">#{entry.id}</span>
          </div>
          {#if entry.body}
            <RenderedMarkdown source={entry.body} class="text-body-sm" ariaLabel={`Entry #${entry.id} body`} />
          {:else}
            <p class="text-body-sm text-muted-foreground">No details recorded.</p>
          {/if}
          <div class="flex gap-2">
            <Button size="sm" variant="outline" onclick={() => { editing = entry; dialogOpen = true; }}><Pencil class="h-4 w-4" /> Edit</Button>
            <Button size="sm" variant="outline" onclick={() => { deleteTarget = entry; deleteOpen = true; }}><Trash2 class="h-4 w-4" /> Delete</Button>
          </div>
        </div>
      {/snippet}
    </EventRow>
  {/snippet}
</DataTable>

{#if $list.hasNextPage}
  <div class="flex justify-center">
    <Button variant="outline" size="sm" disabled={$list.isFetchingNextPage} onclick={() => void $list.fetchNextPage()}>
      {$list.isFetchingNextPage ? "Loading…" : "Load older entries"}
    </Button>
  </div>
{/if}

{#if slug || editing}
  <ChangelogEntryDialog bind:open={dialogOpen} slug={editing?.project ?? slug ?? ""} entry={editing} {cardId} />
{/if}

<ConfirmDialog
  bind:open={deleteOpen}
  title={deleteTarget ? `Delete changelog entry #${deleteTarget.id}?` : "Delete changelog entry?"}
  description={deleteTarget ? `“${deleteTarget.title}” leaves the changelog. Its content stays in the project's Activity.` : ""}
  confirmLabel="Delete entry"
  destructive
  onConfirm={() => { if (deleteTarget) $deleteMut.mutate(deleteTarget); }}
/>
