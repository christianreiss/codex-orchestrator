<script lang="ts">
  import { toast } from "svelte-sonner";
  import Download from "@lucide/svelte/icons/download";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Copy from "@lucide/svelte/icons/copy";
  import FileUp from "@lucide/svelte/icons/file-up";
  import { authStore } from "$lib/stores/auth";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import ModuleSwitchRow from "$lib/components/layout/ModuleSwitchRow.svelte";
  import ConfirmDialog from "$lib/components/hosts/ConfirmDialog.svelte";
  import InsecureCountdown from "$lib/components/hosts/InsecureCountdown.svelte";
  import TransferLimitsSection from "$lib/components/transfers/TransferLimitsSection.svelte";
  import TransferAuditSheet from "$lib/components/transfers/TransferAuditSheet.svelte";
  import RowActions, { type RowAction } from "$lib/components/data-table/RowActions.svelte";
  import * as Table from "$lib/components/ui/table";
  import { Alert, AlertDescription } from "$lib/components/ui/alert";
  import { Badge } from "$lib/components/ui/badge";
  import { EmptyState } from "$lib/components/ui/empty-state";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { formatBytes, relativeTime } from "$lib/utils/format";
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
  const rows = $derived($listQuery.data?.transfers ?? []);

  const canManage = $derived($authStore.can("transfers.manage"));
  const canDownload = $derived($authStore.can("transfers.download"));

  let auditRow = $state<TransferRow | null>(null);
  let deleteTarget = $state<TransferRow | null>(null);

  const stateMutation = transferStateMutation({
    onSuccess: (data) =>
      toast.success(
        data.enabled
          ? "File transfer enabled; hosts pick up the new instructions on their next launch"
          : "File transfer disabled; held files keep expiring on schedule",
      ),
    onError: (err) => toast.error(err.message),
  });

  const downloadMutation = transferDownloadMutation({
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = transferDeleteMutation({
    onSuccess: () => {
      toast.success("Transfer deleted; its trail is kept");
      deleteTarget = null;
    },
    onError: (err) => toast.error(err.message),
  });

  async function copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      toast.success("Transfer id copied");
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
        reason: !canDownload
          ? "Reading a transfer back needs the transfers.download capability"
          : !live
            ? `This transfer is ${row.status}; its bytes are gone`
            : undefined,
      },
      { label: "Copy id", icon: Copy, onClick: () => void copyId(row.id) },
      {
        label: "Delete",
        icon: Trash2,
        destructive: true,
        onClick: () => (deleteTarget = row),
        disabled: !canManage || !live,
        reason: canManage ? undefined : "Deleting a transfer needs the transfers.manage capability",
      },
    ];
  }
</script>

<svelte:head><title>File Transfer</title></svelte:head>

<PageHeader
  title="File Transfer"
  subtitle="A fleet-wide pool of files agents hand each other. Every upload carries a deadline, and the bytes are swept off disk when it passes."
/>

<ModuleSwitchRow
  id="transfers-toggle"
  label="Enable file transfer"
  description={$stateQuery.isPending
    ? "Loading current state…"
    : moduleState?.enabled
      ? `${moduleState.live_count} file${moduleState.live_count === 1 ? "" : "s"} held · ${formatBytes(moduleState.used_bytes)} of ${formatBytes(moduleState.quota_bytes)} used`
      : "Agents cannot upload or fetch files. Anything already held keeps expiring on schedule."}
  checked={moduleState?.enabled ?? false}
  disabled={!canManage || $stateQuery.isPending || $stateMutation.isPending}
  onCheckedChange={(next) => $stateMutation.mutate(next)}
/>

<p class="mt-3 text-xs text-muted-foreground">
  Enabling adds a File Transfer section to every active host's AGENTS.md / CLAUDE.md, replacing the
  whole file on their next wrapper launch. Disabling stops the <code>transfer_*</code> tools from
  serving; held files are retained and still expire on their own deadlines.
</p>

<p class="mt-2 text-xs text-muted-foreground">
  The pool has no addressing: any agent that knows an id can fetch that file, and nothing tells a
  peer an upload happened. That is why every fetch is recorded — open a row to see who took a copy.
  The uploader shown on each row is asserted by the calling agent, not verified by the fleet.
</p>

<div class="mt-6">
  <TransferLimitsSection {moduleState} {canManage} />
</div>

<section class="mt-6">
  <h2 class="mb-3 text-sm font-semibold">Held files</h2>

  {#if $listQuery.isError}
    <Alert variant="destructive">
      <AlertDescription>{$listQuery.error?.message ?? "Could not load transfers"}</AlertDescription>
    </Alert>
  {:else if $listQuery.isPending}
    <div class="space-y-2">
      <Skeleton class="h-10 w-full" />
      <Skeleton class="h-10 w-full" />
      <Skeleton class="h-10 w-full" />
    </div>
  {:else if rows.length === 0}
    <EmptyState
      icon={FileUp}
      title="Nothing in the pool"
      description={moduleState?.enabled
        ? "No agent has uploaded a file yet. Uploads appear here until their TTL runs out."
        : "File transfer is switched off, so agents cannot upload anything."}
    />
  {:else}
    <div class="overflow-x-auto">
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Name</Table.Head>
            <Table.Head>Size</Table.Head>
            <Table.Head>Uploaded by</Table.Head>
            <Table.Head class="text-right">Fetches</Table.Head>
            <Table.Head>Expires</Table.Head>
            <Table.Head class="w-10"></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each rows as row (row.id)}
            <Table.Row
              class="cursor-pointer"
              onclick={() => (auditRow = row)}
            >
              <Table.Cell class="max-w-[22rem]">
                <span class="block truncate font-medium">{row.name}</span>
                <span class="block truncate text-xs text-muted-foreground">
                  {row.mime_type ?? "unknown type"}
                  {#if row.status !== "live"}
                    · {transferStatusLabel(row.status)}
                  {/if}
                </span>
              </Table.Cell>
              <Table.Cell class="tabular-nums">{formatBytes(row.size_bytes)}</Table.Cell>
              <Table.Cell class="max-w-[12rem] truncate">
                {row.uploaded_by ?? "—"}
              </Table.Cell>
              <Table.Cell class="text-right tabular-nums">{row.download_count}</Table.Cell>
              <Table.Cell>
                <InsecureCountdown until={row.expires_at} />
                {#if row.ttl_clamped}
                  <Badge variant="warning" class="ml-1">clamped</Badge>
                {/if}
              </Table.Cell>
              <Table.Cell onclick={(event: MouseEvent) => event.stopPropagation()}>
                <RowActions actions={actionsFor(row)} label={`Actions for ${row.name}`} />
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>
  {/if}
</section>

<TransferAuditSheet row={auditRow} onOpenChange={(open) => { if (!open) auditRow = null; }} />

<ConfirmDialog
  open={deleteTarget !== null}
  onOpenChange={(open) => { if (!open) deleteTarget = null; }}
  title="Delete this transfer?"
  description={deleteTarget
    ? `The bytes of "${deleteTarget.name}" go immediately, before its deadline. Its record and fetch history are kept. Any agent still waiting on the id will get a not-found.`
    : ""}
  confirmLabel="Delete"
  destructive
  onConfirm={() => { if (deleteTarget) $deleteMutation.mutate(deleteTarget.id); }}
/>
