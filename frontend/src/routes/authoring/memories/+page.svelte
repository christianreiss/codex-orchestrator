<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { memoriesApi, memoriesKeys } from "$lib/api/memories";
  import { hostsListQuery } from "$lib/api/hosts";
  import type { MemoryEntry } from "$lib/api/types";
  import { ApiError } from "$lib/api/client";
  import { relativeTime, formatBytes } from "$lib/utils/format";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Badge } from "$lib/components/ui/badge";
  import * as Select from "$lib/components/ui/select";
  import * as Table from "$lib/components/ui/table";
  import * as Dialog from "$lib/components/ui/dialog";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Trash2 from "@lucide/svelte/icons/trash-2";

  const qc = useQueryClient();

  // Host filter — "all" sentinel means no host_id parameter is sent.
  const ALL_HOSTS = "all";
  let hostFilter = $state<string>(ALL_HOSTS);
  const hostsQuery = hostsListQuery();
  const hosts = $derived($hostsQuery.data?.hosts ?? []);

  const activeHostId = $derived(hostFilter === ALL_HOSTS ? null : hostFilter);

  const query = createQuery(
    reactiveOptions(() => ({
      queryKey: memoriesKeys.list(activeHostId),
      queryFn: () => memoriesApi.list({ limit: 200, host: activeHostId }),
    })),
  );

  const selectedHostLabel = $derived(
    hostFilter === ALL_HOSTS
      ? "All hosts"
      : (hosts.find((h) => String(h.id) === hostFilter)?.fqdn ?? `Host #${hostFilter}`),
  );

  const all = $derived<MemoryEntry[]>($query.data?.matches ?? []);

  let search = $state("");
  const filtered = $derived(filter(all, search));

  function filter(rows: MemoryEntry[], q: string): MemoryEntry[] {
    const n = q.trim().toLowerCase();
    if (!n) return rows;
    return rows.filter((m) => {
      const key = String(m.id ?? "").toLowerCase();
      const content = String(m.content ?? "").toLowerCase();
      const tags = (m.tags ?? []).map((t) => String(t).toLowerCase());
      const summary = String(m.summary ?? "").toLowerCase();
      return key.includes(n) || content.includes(n) || summary.includes(n) || tags.some((t) => t.includes(n));
    });
  }

  function sizeOf(entry: MemoryEntry): number {
    return new TextEncoder().encode(String(entry.content ?? "")).length;
  }

  // Delete confirm
  let deleteTarget: MemoryEntry | null = $state(null);
  const deleteMutation = createMutation({
    mutationFn: (entry: MemoryEntry) => {
      const recordId = entry.record_id ?? entry.id;
      if (recordId === null || recordId === undefined) {
        return Promise.reject(new Error("Memory has no record id"));
      }
      return memoriesApi.delete(recordId);
    },
    onSuccess: () => {
      toast.success("Memory deleted");
      void qc.invalidateQueries({ queryKey: memoriesKeys.all });
      deleteTarget = null;
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Failed to delete";
      toast.error(msg);
    },
  });
</script>

<section class="mb-4 flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4 text-sm">
  <div class="flex flex-col">
    <span class="text-xs uppercase tracking-wide text-muted-foreground">Memories</span>
    <span class="text-lg font-semibold">{all.length}</span>
  </div>
  <div class="flex flex-1 flex-wrap items-center gap-2">
    <Select.Root
      type="single"
      value={hostFilter}
      onValueChange={(v) => (hostFilter = v || ALL_HOSTS)}
    >
      <Select.Trigger class="w-[200px]" aria-label="Filter by host">
        <Select.Value placeholder="All hosts">{selectedHostLabel}</Select.Value>
      </Select.Trigger>
      <Select.Content>
        <Select.Item value={ALL_HOSTS} label="All hosts">All hosts</Select.Item>
        {#each hosts as host (host.id)}
          <Select.Item value={String(host.id)} label={host.fqdn}>{host.fqdn}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
    <Input
      placeholder="Search keys, content, summary, tags…"
      bind:value={search}
      class="max-w-md"
    />
    <span class="text-xs text-muted-foreground">
      {filtered.length === all.length ? "" : `${filtered.length} of ${all.length}`}
    </span>
  </div>
  <Button
    size="sm"
    variant="outline"
    onclick={() => void qc.invalidateQueries({ queryKey: memoriesKeys.all })}
    disabled={$query.isFetching}
  >
    <RefreshCw class={$query.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
    Refresh
  </Button>
</section>

<div class="rounded-lg border bg-card">
  <Table.Root>
    <Table.Header>
      <Table.Row>
        <Table.Head>Key / ID</Table.Head>
        <Table.Head>Size</Table.Head>
        <Table.Head>Created</Table.Head>
        <Table.Head>Updated</Table.Head>
        <Table.Head>Tags</Table.Head>
        <Table.Head class="text-right">Actions</Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#if $query.isLoading}
        <Table.Row>
          <Table.Cell colspan={6} class="py-6 text-center text-sm text-muted-foreground">
            Loading memories…
          </Table.Cell>
        </Table.Row>
      {:else if $query.isError}
        <Table.Row>
          <Table.Cell colspan={6} class="py-6 text-center text-sm text-destructive">
            {$query.error instanceof Error ? $query.error.message : "Failed to load memories"}
          </Table.Cell>
        </Table.Row>
      {:else if filtered.length === 0}
        <Table.Row>
          <Table.Cell colspan={6} class="py-6 text-center text-sm text-muted-foreground">
            {search ? "No matches for that search." : "No memories yet."}
          </Table.Cell>
        </Table.Row>
      {:else}
        {#each filtered as row (row.record_id ?? row.id)}
          <Table.Row>
            <Table.Cell class="font-mono text-xs">
              {row.id ?? `#${row.record_id ?? "?"}`}
              {#if row.summary}
                <div class="mt-0.5 line-clamp-1 font-sans text-xs text-muted-foreground">
                  {row.summary}
                </div>
              {/if}
            </Table.Cell>
            <Table.Cell class="text-sm">{formatBytes(sizeOf(row))}</Table.Cell>
            <Table.Cell class="text-sm text-muted-foreground">
              {row.created_at ? relativeTime(row.created_at) : "—"}
            </Table.Cell>
            <Table.Cell class="text-sm text-muted-foreground">
              {row.updated_at ? relativeTime(row.updated_at) : "—"}
            </Table.Cell>
            <Table.Cell>
              <div class="flex flex-wrap gap-1">
                {#each row.tags ?? [] as tag (tag)}
                  <Badge variant="outline" class="px-1.5 py-0 text-[10px]">{tag}</Badge>
                {/each}
              </div>
            </Table.Cell>
            <Table.Cell class="text-right">
              <Button
                variant="ghost"
                size="sm"
                disabled={row.record_id == null && row.id == null}
                onclick={() => (deleteTarget = row)}
              >
                <Trash2 class="h-4 w-4 text-destructive" />
              </Button>
            </Table.Cell>
          </Table.Row>
        {/each}
      {/if}
    </Table.Body>
  </Table.Root>
</div>

<Dialog.Root open={!!deleteTarget} onOpenChange={(v) => (v ? null : (deleteTarget = null))}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Delete memory</Dialog.Title>
      <Dialog.Description>
        Permanently delete <span class="font-mono">{deleteTarget?.id ?? `#${deleteTarget?.record_id ?? "?"}`}</span>.
        This cannot be undone.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer class="flex justify-end gap-2">
      <Button variant="outline" onclick={() => (deleteTarget = null)}>Cancel</Button>
      <Button
        variant="destructive"
        disabled={$deleteMutation.isPending}
        onclick={() => deleteTarget && $deleteMutation.mutate(deleteTarget)}
      >
        {$deleteMutation.isPending ? "Deleting…" : "Delete"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
