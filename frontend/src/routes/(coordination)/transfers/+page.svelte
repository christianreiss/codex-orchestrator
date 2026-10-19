<script lang="ts">
  import type { Snapshot } from "./$types";
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  import { toast } from "svelte-sonner";
  import Download from "@lucide/svelte/icons/download";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Copy from "@lucide/svelte/icons/copy";
  import FileUp from "@lucide/svelte/icons/file-up";
  import { authStore } from "$lib/stores/auth";
  import { DataTable, PageShell, StatStrip, Toolbar } from "$lib/components/page";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import TransferLimitsSection from "$lib/components/transfers/TransferLimitsSection.svelte";
  import TransferAuditSheet from "$lib/components/transfers/TransferAuditSheet.svelte";
  import RowActions, { type RowAction } from "$lib/components/data-table/RowActions.svelte";
  import * as Table from "$lib/components/ui/table";
  import { Badge } from "$lib/components/ui/badge";
  import { formatBytes } from "$lib/utils/format";
  import {
    transferDeleteMutation,
    transferDownloadMutation,
    transferListQuery,
    transferStateMutation,
    transferStateQuery,
    transferStatusLabel,
    type TransferRow,
  } from "$lib/api/transfers";

  const stateQuery = transferStateQuery();
  const listQuery = transferListQuery();

  // `moduleState`, not `state`: a local of that name shadows the `$state` rune.
  const moduleState = $derived($stateQuery.data);
  const canManage = $derived($authStore.can("transfers.manage"));
  const canDownload = $derived($authStore.can("transfers.download"));

  let search = $state("");
  let auditRow = $state<TransferRow | null>(null);
  let deleteTarget = $state<TransferRow | null>(null);

  const all = $derived($listQuery.data?.transfers);
  const rows = $derived(all?.filter((row) => [row.name, row.mime_type, row.uploaded_by].join(" ").toLowerCase().includes(search.trim().toLowerCase())));

  const stateMutation = transferStateMutation({
    onSuccess: (data) =>
      toast.success(data.enabled ? "Shared files enabled; hosts pick up the new instructions on their next launch" : "Shared files disabled; held files keep expiring on schedule"),
    onError: (err) => toast.error(err.message),
  });
  const downloadMutation = transferDownloadMutation({ onError: (err) => toast.error(err.message) });
  const deleteMutation = transferDeleteMutation({
    onSuccess: () => {
      toast.success("File deleted; its trail is kept");
      deleteTarget = null;
    },
    onError: (err) => toast.error(err.message),
  });

  async function copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      toast.success("File id copied");
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  }

  function actionsFor(row: TransferRow): RowAction[] {
    const live = row.status === "live";
    return [
      {
        label: "Download",
        icon: Download,
        onClick: () => $downloadMutation.mutate(row),
        disabled: !canDownload || !live,
        reason: !canDownload ? "Reading a file back needs the transfers.download capability" : !live ? `This file is ${row.status}; its bytes are gone` : undefined,
      },
      { label: "Copy id", icon: Copy, onClick: () => void copyId(row.id) },
      {
        label: "Delete",
        icon: Trash2,
        destructive: true,
        onClick: () => (deleteTarget = row),
        disabled: !canManage || !live,
        reason: canManage ? undefined : "Deleting a file needs the transfers.manage capability",
      },
    ];
  }

  const stats = $derived([
    { label: "files held", value: moduleState?.live_count ?? "–" },
    { label: moduleState && moduleState.quota_bytes > 0 ? `used of ${formatBytes(moduleState.quota_bytes)}` : "used (unlimited quota)", value: moduleState ? formatBytes(moduleState.used_bytes) : "–" },
  ]);
  export const snapshot: Snapshot<{ search: typeof search }> = {
    capture: () => ({ search }),
    restore: (value) => { search = value.search; },
  };
</script>

<PageShell
  title="Shared files"
  description="A fleet-wide pool of files agents hand each other. Every upload has a deadline; the bytes are swept off disk when it passes (file transfer)."
  toggle={{
    label: "Enable shared files",
    checked: moduleState?.enabled ?? false,
    disabled: !canManage || $stateQuery.isPending || $stateMutation.isPending,
    onChange: (next) => $stateMutation.mutate(next),
  }}
>
  <StatStrip items={stats} />

  <section aria-labelledby="held-files-heading" class="space-y-2">
    <h2 id="held-files-heading" class="sr-only">Held files</h2>
    <Toolbar bind:search searchPlaceholder="Search held files" count={rows && all ? (rows.length === all.length ? `${all.length} file${all.length === 1 ? "" : "s"}` : `${rows.length} of ${all.length}`) : undefined} />
    <DataTable
      items={rows}
      loading={$listQuery.isPending}
      error={$listQuery.isError ? ($listQuery.error?.message ?? "Could not load files") : null}
      onRetry={() => $listQuery.refetch()}
      key={(row) => row.id}
      emptyTitle="Nothing in the pool"
      emptyDescription={moduleState?.enabled ? "No agent has uploaded a file yet. Uploads appear here until their TTL runs out." : "Shared files are switched off, so agents cannot upload anything."}
      emptyIcon={FileUp}
      filtered={search.trim() !== ""}
      onClearFilters={() => { search = ""; }}
      caption="Held files"
    >
      {#snippet head()}
        <Table.Head>Name</Table.Head>
        <Table.Head>Size</Table.Head>
        <Table.Head>Uploaded by</Table.Head>
        <Table.Head class="text-right">Fetches</Table.Head>
        <Table.Head>Expires</Table.Head>
        <Table.Head class="w-10"><span class="sr-only">Actions</span></Table.Head>
      {/snippet}
      {#snippet row(item)}
        <Table.Row class="cursor-pointer" onclick={() => (auditRow = item)}>
          <Table.Cell class="max-w-[22rem]">
            <button type="button" class="block max-w-full truncate text-left font-medium underline-offset-4 hover:underline" onclick={(event) => { event.stopPropagation(); auditRow = item; }}>{item.name}</button>
            <span class="block truncate text-caption text-muted-foreground">{item.mime_type ?? "unknown type"}{item.status !== "live" ? ` · ${transferStatusLabel(item.status)}` : ""}</span>
          </Table.Cell>
          <Table.Cell class="tabular-nums">
            {formatBytes(item.size_bytes)}
            {#if item.status === "uploading" && item.expected_size_bytes != null}<span class="text-muted-foreground">/ {formatBytes(item.expected_size_bytes)}</span>{/if}
          </Table.Cell>
          <Table.Cell class="max-w-[12rem] truncate">{item.uploaded_by ?? "—"}</Table.Cell>
          <Table.Cell class="text-right tabular-nums">{item.download_count}</Table.Cell>
          <Table.Cell>
            <Timestamp value={item.expires_at} />
            {#if item.ttl_clamped}<Badge variant="warning" class="ml-1">clamped</Badge>{/if}
          </Table.Cell>
          <Table.Cell onclick={(event: MouseEvent) => event.stopPropagation()}>
            <RowActions actions={actionsFor(item)} label={`Actions for ${item.name}`} />
          </Table.Cell>
        </Table.Row>
      {/snippet}
    </DataTable>
  </section>

  <TransferLimitsSection {moduleState} {canManage} />

  <details class="text-body-sm text-muted-foreground">
    <summary class="cursor-pointer select-none font-medium text-foreground">How shared files work</summary>
    <p class="mt-2">
      Enabling adds a File Transfer section to every active host's AGENTS.md / CLAUDE.md, replacing the whole file on their next wrapper launch. Disabling stops the wrapper commands and <code>transfer_*</code> tools from serving; held files are retained and still expire on their own deadlines.
    </p>
    <p class="mt-2">
      The pool has no addressing: any agent that knows an id can fetch that file, and nothing tells a peer an upload happened. That is why every fetch is recorded: open a row to see who took a copy. The uploader shown on each row is asserted by the calling agent, not verified by the fleet.
    </p>
  </details>
</PageShell>

<TransferAuditSheet row={auditRow} onOpenChange={(open) => { if (!open) auditRow = null; }} />

<ConfirmDialog
  open={deleteTarget !== null}
  onClose={() => (deleteTarget = null)}
  title="Delete this file?"
  description={deleteTarget ? `The bytes of "${deleteTarget.name}" go immediately, before its deadline. Its record and fetch history are kept. Any agent still waiting on the id will get a not-found.` : ""}
  confirmLabel="Delete"
  destructive
  busy={$deleteMutation.isPending}
  onConfirm={() => { if (deleteTarget) $deleteMutation.mutate(deleteTarget.id); }}
/>
