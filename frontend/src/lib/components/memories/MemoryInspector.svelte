<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Activity from "@lucide/svelte/icons/activity";
  import Braces from "@lucide/svelte/icons/braces";
  import Clock3 from "@lucide/svelte/icons/clock-3";
  import Copy from "@lucide/svelte/icons/copy";
  import FileText from "@lucide/svelte/icons/file-text";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import {
    memoriesApi,
    memoriesKeys,
    type MemoryGraphNode,
    type MemoryRecord,
    type MemoryScope,
  } from "$lib/api/memories";
  import { copyTextToClipboard } from "$lib/utils/clipboard";
  import { relativeTime } from "$lib/utils/format";
  import { formatCharacters } from "./atlas-types";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Sheet from "$lib/components/ui/sheet";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import * as Tabs from "$lib/components/ui/tabs";

  type InspectorTab = "overview" | "content" | "metadata" | "activity";

  type Props = {
    open: boolean;
    node: MemoryGraphNode | null;
    onOpenChange: (open: boolean) => void;
    onEdit: (memory: MemoryRecord) => void;
    onAppend: (memory: MemoryRecord) => void;
    onDelete: (memory: MemoryRecord) => void;
  };

  let { open = $bindable(), node, onOpenChange, onEdit, onAppend, onDelete }: Props = $props();

  let activeTab = $state<InspectorTab>("overview");
  let auditCursor = $state<string | null>(null);
  let auditHistory = $state<Array<string | null>>([]);
  let previousNodeId = "";

  const selection = $derived.by(() => {
    if (!node || node.kind !== "memory" || !node.scope || typeof node.record_id !== "number") return null;
    return {
      nodeId: node.node_id ?? node.id,
      scope: node.scope as MemoryScope,
      recordId: node.record_id,
    };
  });

  const detailQuery = createQuery(
    reactiveOptions(() => ({
      queryKey: selection
        ? memoriesKeys.detail(selection.scope, selection.recordId)
        : (["memories", "detail", "none"] as const),
      queryFn: () => {
        if (!selection) throw new Error("No memory selected");
        return memoriesApi.detail(selection.scope, selection.recordId);
      },
      enabled: open && !!selection,
    })),
  );

  const auditQuery = createQuery(
    reactiveOptions(() => ({
      queryKey: selection
        ? memoriesKeys.audit(selection.nodeId, auditCursor)
        : (["memories", "audit", "none"] as const),
      queryFn: () => {
        if (!selection) throw new Error("No memory selected");
        return memoriesApi.audit(selection.nodeId, 50, auditCursor);
      },
      enabled: open && activeTab === "activity" && !!selection,
    })),
  );

  const memory = $derived($detailQuery.data?.memory ?? null);

  // Renders as a label/value list when every value is scalar; null when
  // any value is nested/array (the raw-JSON fallback stays truthful there
  // rather than flattening data a definition list can't represent).
  const metadataEntries = $derived.by((): Array<[string, unknown]> | null => {
    const metadata = memory?.metadata;
    if (!metadata) return [];
    const entries = Object.entries(metadata);
    const isScalar = (v: unknown) =>
      v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
    return entries.every(([, v]) => isScalar(v)) ? entries : null;
  });

  $effect(() => {
    const id = selection?.nodeId ?? "";
    if (id !== previousNodeId) {
      previousNodeId = id;
      activeTab = "overview";
      auditCursor = null;
      auditHistory = [];
    }
  });

  function setOpen(next: boolean): void {
    open = next;
    onOpenChange(next);
  }

  function formatTimestamp(value: string | null | undefined): string {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }

  function shortEtag(value: string | null | undefined): string {
    if (!value) return "—";
    return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
  }

  async function copyContent(): Promise<void> {
    if (!memory) return;
    const copied = await copyTextToClipboard(memory.content);
    if (copied) toast.success("Memory content copied");
    else toast.error("Could not copy content");
  }

  function auditNext(): void {
    const next = $auditQuery.data?.next_cursor;
    if (!next) return;
    auditHistory = [...auditHistory, auditCursor];
    auditCursor = next;
  }

  function auditPrevious(): void {
    if (!auditHistory.length) return;
    auditCursor = auditHistory[auditHistory.length - 1] ?? null;
    auditHistory = auditHistory.slice(0, -1);
  }
</script>

<Sheet.Root bind:open onOpenChange={setOpen}>
  <Sheet.Content side="right" class="flex w-full flex-col overflow-y-auto p-0 sm:max-w-xl">
    <div class="border-b border-border/70 bg-gradient-to-br from-primary/[0.09] via-background to-background px-5 pb-4 pt-5 sm:px-6">
      <Sheet.Header class="pr-10">
        <div class="flex flex-wrap items-center gap-2">
          <Badge variant="outline" class="capitalize">{node?.scope ?? "Memory"}</Badge>
          {#if node?.engine}<Badge variant="secondary">{node.engine}</Badge>{/if}
        </div>
        <Sheet.Title class="mt-2 break-words font-mono text-base">
          {memory?.title || memory?.id || node?.memory_id || node?.key || node?.label || "Memory"}
        </Sheet.Title>
        <Sheet.Description>
          {memory?.summary || node?.summary || "Inspect content, metadata, capabilities, and operational activity."}
        </Sheet.Description>
      </Sheet.Header>
    </div>

    {#if $detailQuery.isLoading}
      <div class="space-y-4 p-5 sm:p-6">
        <Skeleton class="h-10 w-full" />
        <Skeleton class="h-36 w-full" />
        <Skeleton class="h-24 w-full" />
      </div>
    {:else if $detailQuery.isError}
      <div class="m-5 rounded-xl border border-destructive/35 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
        <p class="font-semibold">Could not load this memory</p>
        <p class="mt-1">{$detailQuery.error instanceof Error ? $detailQuery.error.message : "Unknown error"}</p>
        <Button class="mt-3" size="sm" variant="outline" onclick={() => $detailQuery.refetch()}>Try again</Button>
      </div>
    {:else if memory}
      <div class="flex flex-wrap gap-2 border-b border-border/70 px-5 py-3 sm:px-6">
        {#if memory.capabilities.update}
          <Button size="sm" variant="outline" onclick={() => onEdit(memory)}>
            <Pencil class="h-3.5 w-3.5" /> Edit
          </Button>
        {/if}
        {#if memory.capabilities.append}
          <Button size="sm" variant="outline" onclick={() => onAppend(memory)}>
            <Plus class="h-3.5 w-3.5" /> Append
          </Button>
        {/if}
        {#if memory.capabilities.delete}
          <Button size="sm" variant="ghost" class="ml-auto text-destructive hover:text-destructive" onclick={() => onDelete(memory)}>
            <Trash2 class="h-3.5 w-3.5" /> Delete
          </Button>
        {/if}
      </div>

      <Tabs.Root value={activeTab} onValueChange={(value) => (activeTab = value as InspectorTab)} class="flex-1 px-5 py-4 sm:px-6">
        <Tabs.List class="grid w-full grid-cols-4">
          <Tabs.Trigger value="overview" class="px-2"><Clock3 class="mr-1.5 h-3.5 w-3.5" />Overview</Tabs.Trigger>
          <Tabs.Trigger value="content" class="px-2"><FileText class="mr-1.5 h-3.5 w-3.5" />Content</Tabs.Trigger>
          <Tabs.Trigger value="metadata" class="px-2"><Braces class="mr-1.5 h-3.5 w-3.5" />Metadata</Tabs.Trigger>
          <Tabs.Trigger value="activity" class="px-2"><Activity class="mr-1.5 h-3.5 w-3.5" />Activity</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="overview" class="space-y-5 pt-3">
          <dl class="grid gap-x-4 gap-y-3 rounded-xl border border-border/70 bg-muted/25 p-4 text-sm sm:grid-cols-2">
            <div>
              <dt class="text-xs text-muted-foreground">Immutable key</dt>
              <dd class="mt-0.5 break-all font-mono text-xs">{memory.id}</dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">Record</dt>
              <dd class="mt-0.5 font-mono text-xs">#{memory.record_id}</dd>
            </div>
            {#if memory.host}
              <div>
                <dt class="text-xs text-muted-foreground">Host owner</dt>
                <dd class="mt-0.5">{memory.host}</dd>
              </div>
            {/if}
            {#if memory.project_slug}
              <div>
                <dt class="text-xs text-muted-foreground">Project owner</dt>
                <dd class="mt-0.5 font-mono text-xs">{memory.project_slug}</dd>
              </div>
            {/if}
            <div>
              <dt class="text-xs text-muted-foreground">Length</dt>
              <dd class="mt-0.5">{formatCharacters(memory.content_length)}</dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">Revision</dt>
              <dd class="mt-0.5">{memory.revision ?? "—"}</dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">Created</dt>
              <dd class="mt-0.5" title={formatTimestamp(memory.created_at)}>{memory.created_at ? relativeTime(memory.created_at) : "—"}</dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">Updated</dt>
              <dd class="mt-0.5" title={formatTimestamp(memory.updated_at)}>{memory.updated_at ? relativeTime(memory.updated_at) : "—"}</dd>
            </div>
            <div class="sm:col-span-2">
              <dt class="text-xs text-muted-foreground">ETag</dt>
              <dd class="mt-0.5 break-all font-mono text-[11px]" title={memory.etag}>{shortEtag(memory.etag)}</dd>
            </div>
          </dl>

          <div>
            <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tags</h3>
            <div class="mt-2 flex flex-wrap gap-1.5">
              {#if memory.tags.length}
                {#each memory.tags as tag (tag)}<Badge variant="outline">{tag}</Badge>{/each}
              {:else}
                <span class="text-sm text-muted-foreground">No tags</span>
              {/if}
            </div>
          </div>

          <div>
            <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lifecycle capabilities</h3>
            <div class="mt-2 flex flex-wrap gap-1.5">
              {#each Object.entries(memory.capabilities) as [action, allowed] (action)}
                <Badge variant={allowed ? "secondary" : "outline"} class={!allowed ? "opacity-45" : ""}>{action}</Badge>
              {/each}
            </div>
          </div>
        </Tabs.Content>

        <Tabs.Content value="content" class="space-y-3 pt-3">
          <div class="flex items-center justify-between gap-3">
            <p class="text-xs text-muted-foreground">{formatCharacters(memory.content_length)} · full body</p>
            <Button size="sm" variant="outline" onclick={copyContent}><Copy class="h-3.5 w-3.5" />Copy</Button>
          </div>
          <pre class="max-h-[calc(100vh-16rem)] whitespace-pre-wrap break-words rounded-xl border border-border/70 bg-muted/30 p-4 font-mono text-xs leading-5 text-foreground">{memory.content}</pre>
        </Tabs.Content>

        <Tabs.Content value="metadata" class="space-y-3 pt-3">
          <p class="text-xs text-muted-foreground">Structured labels only; full content is kept on the Content tab.</p>
          {#if metadataEntries && metadataEntries.length > 0}
            <dl class="divide-y divide-border/70 rounded-xl border border-border/70">
              {#each metadataEntries as [key, value] (key)}
                <div class="flex items-start justify-between gap-4 px-4 py-2.5 text-sm">
                  <dt class="shrink-0 font-mono text-xs text-muted-foreground">{key}</dt>
                  <dd class="break-words text-right text-foreground">{String(value)}</dd>
                </div>
              {/each}
            </dl>
          {:else if metadataEntries}
            <p class="rounded-xl border border-border/70 bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
              No metadata set.
            </p>
          {:else}
            <pre class="max-h-[calc(100vh-16rem)] overflow-auto rounded-xl border border-border/70 bg-muted/30 p-4 font-mono text-xs leading-5">{JSON.stringify(memory.metadata ?? {}, null, 2)}</pre>
          {/if}
        </Tabs.Content>

        <Tabs.Content value="activity" class="space-y-3 pt-3">
          {#if $auditQuery.isLoading}
            <Skeleton class="h-28 w-full" />
            <Skeleton class="h-20 w-full" />
          {:else if $auditQuery.isError}
            <div class="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
              {$auditQuery.error instanceof Error ? $auditQuery.error.message : "Could not load activity"}
            </div>
          {:else if $auditQuery.data}
            <div class="rounded-xl border border-warning/25 bg-warning-muted p-3 text-xs text-warning-muted-foreground">
              <p class="font-semibold">Operational history</p>
              <p class="mt-1">{$auditQuery.data.retention.note}</p>
              <p class="mt-1 opacity-80">Retention-bound · not immutable · no historical bodies</p>
            </div>

            {#if $auditQuery.data.activities.length === 0}
              <p class="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No retained activity for this memory.</p>
            {:else}
              <ol class="relative ml-2 border-l border-border/80 pl-5">
                {#each $auditQuery.data.activities as item (item.id)}
                  <li class="relative pb-5 last:pb-0">
                    <span class="absolute -left-[1.53rem] top-1 h-2.5 w-2.5 rounded-full border-2 border-background bg-primary"></span>
                    <div class="flex flex-wrap items-baseline justify-between gap-2">
                      <p class="text-sm font-medium">{item.action.replace(/[._]/g, " ")}</p>
                      <time class="text-[10px] text-muted-foreground" title={formatTimestamp(item.created_at)}>{item.created_at ? relativeTime(item.created_at) : "—"}</time>
                    </div>
                    <p class="mt-0.5 text-xs text-muted-foreground">
                      {item.source}{item.source_engine ? ` · ${item.source_engine}` : ""}{item.admin_id ? ` · admin #${item.admin_id}` : ""}
                    </p>
                    <div class="mt-1.5 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                      {#if item.content_length != null}<span>{formatCharacters(item.content_length)}</span>{/if}
                      {#if item.delta_length != null}<span>{item.delta_length >= 0 ? "+" : ""}{item.delta_length.toLocaleString()} chars</span>{/if}
                      {#if item.tag_count != null}<span>{item.tag_count} tags</span>{/if}
                      {#if item.new_etag}<span class="font-mono">{shortEtag(item.new_etag)}</span>{/if}
                    </div>
                  </li>
                {/each}
              </ol>
            {/if}

            <div class="flex items-center justify-between gap-2 border-t border-border/70 pt-3">
              <Button size="sm" variant="outline" onclick={auditPrevious} disabled={!auditHistory.length}>Previous</Button>
              <span class="text-[10px] text-muted-foreground">{auditHistory.length ? `Page ${auditHistory.length + 1}` : "Latest"}</span>
              <Button size="sm" variant="outline" onclick={auditNext} disabled={!$auditQuery.data.next_cursor}>Next</Button>
            </div>
          {/if}
        </Tabs.Content>
      </Tabs.Root>
    {/if}
  </Sheet.Content>
</Sheet.Root>
