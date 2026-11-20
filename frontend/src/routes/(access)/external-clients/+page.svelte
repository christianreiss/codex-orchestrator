<script lang="ts">
  import { UrlFilters } from "$lib/utils/url-filters.svelte";
  import { toast } from "svelte-sonner";
  import Bot from "@lucide/svelte/icons/bot";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Power from "@lucide/svelte/icons/power";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import { authStore } from "$lib/stores/auth";
  import { DataTable, PageShell, Toolbar } from "$lib/components/page";
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import RowActions, { type RowAction } from "$lib/components/data-table/RowActions.svelte";
  import ExternalClientDialog from "$lib/components/external-clients/ExternalClientDialog.svelte";
  import KeyRevealDialog from "$lib/components/external-clients/KeyRevealDialog.svelte";
  import * as Table from "$lib/components/ui/table";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import {
    externalClientCreateMutation,
    externalClientDeleteMutation,
    externalClientRotateMutation,
    externalClientUpdateMutation,
    externalClientsQuery,
    type ExternalClient,
    type ExternalClientInput,
    type ExternalTrust,
  } from "$lib/api/externalClients";

  const listQuery = externalClientsQuery();
  const canManage = $derived($authStore.can("external_clients.manage"));
  const all = $derived($listQuery.data?.clients);

  const filterState = new UrlFilters({ q: "" });
  const search = $derived(filterState.values.q);
  let dialogOpen = $state(false);
  let editing = $state<ExternalClient | null>(null);
  let rotateTarget = $state<ExternalClient | null>(null);
  let deleteTarget = $state<ExternalClient | null>(null);
  let reveal = $state<{ name: string; key: string; rotated: boolean } | null>(null);

  const rows = $derived(
    all?.filter((row) => [row.name, row.description, row.trust].join(" ").toLowerCase().includes(search.trim().toLowerCase())),
  );

  /** Listening = polled within the server's presence grace (90 s). */
  function listening(row: ExternalClient): boolean {
    return row.enabled && row.last_poll_at !== null && Date.now() - Date.parse(row.last_poll_at) < 90_000;
  }
  const trustVariant = (trust: ExternalTrust) => (trust === "operator" ? "destructive" : trust === "trusted" ? "warning" : "secondary");

  const createMutation = externalClientCreateMutation({
    onSuccess: (data) => {
      dialogOpen = false;
      reveal = { name: data.client.name, key: data.key, rotated: false };
    },
    onError: (err) => toast.error(err.message),
  });
  const updateMutation = externalClientUpdateMutation({
    onSuccess: () => {
      dialogOpen = false;
      toast.success("External client saved");
    },
    onError: (err) => toast.error(err.message),
  });
  const rotateMutation = externalClientRotateMutation({
    onSuccess: (data) => {
      rotateTarget = null;
      reveal = { name: data.client.name, key: data.key, rotated: true };
    },
    onError: (err) => toast.error(err.message),
  });
  const deleteMutation = externalClientDeleteMutation({
    onSuccess: () => {
      deleteTarget = null;
      toast.success("External client deleted");
    },
    onError: (err) => toast.error(err.message),
  });

  function openCreate() {
    editing = null;
    dialogOpen = true;
  }
  function submit(input: ExternalClientInput) {
    if (editing) $updateMutation.mutate({ id: editing.id, patch: input });
    else $createMutation.mutate(input);
  }
  function actionsFor(row: ExternalClient): RowAction[] {
    const reason = canManage ? undefined : "Changing external clients needs the external_clients.manage capability";
    return [
      { label: "Edit", icon: Pencil, onClick: () => { editing = row; dialogOpen = true; }, disabled: !canManage, reason },
      {
        label: row.enabled ? "Disable" : "Enable",
        icon: Power,
        onClick: () => $updateMutation.mutate({ id: row.id, patch: { enabled: !row.enabled } }),
        disabled: !canManage,
        reason,
      },
      { label: "Replace key", icon: KeyRound, onClick: () => (rotateTarget = row), disabled: !canManage, reason },
      { label: "Delete client", icon: Trash2, destructive: true, onClick: () => (deleteTarget = row), disabled: !canManage, reason },
    ];
  }
</script>

<PageShell
  title="External clients"
  description="Bots and bridges outside the fleet that take part in agent messaging. Each has its own key and a trust level agents see on every message it sends."
>
  {#snippet actions()}
    <Button onclick={openCreate} disabled={!canManage}><Plus class="size-4" aria-hidden="true" /> New client</Button>
  {/snippet}

  <section aria-labelledby="external-clients-heading" class="space-y-2">
    <h2 id="external-clients-heading" class="sr-only">Configured clients</h2>
    <Toolbar
      bind:search={filterState.values.q} filtersActive={filterState.active} onClearFilters={() => filterState.clear()}
      searchPlaceholder="Search clients"
      count={rows && all ? (rows.length === all.length ? `${all.length} client${all.length === 1 ? "" : "s"}` : `${rows.length} of ${all.length}`) : undefined}
    />
    <DataTable
      items={rows}
      loading={$listQuery.isPending}
      error={$listQuery.isError ? ($listQuery.error ?? "Could not load external clients") : null}
      onRetry={() => $listQuery.refetch()}
      key={(row) => row.id}
      emptyTitle="No external clients"
      emptyDescription="Create one to let a bot join agent messaging. It receives a key once; the bot polls /external/v1 with it."
      emptyIcon={Bot}
      filtered={search.trim() !== ""}
      onClearFilters={() => filterState.clear()}
      caption="External clients"
    >
      {#snippet emptyAction()}{#if canManage}<Button variant="outline" onclick={openCreate}><Plus class="size-4" aria-hidden="true" /> New client</Button>{/if}{/snippet}
      {#snippet head()}
        <Table.Head>Name</Table.Head>
        <Table.Head>Trust</Table.Head>
        <Table.Head>Status</Table.Head>
        <Table.Head>Key</Table.Head>
        <Table.Head>Last seen</Table.Head>
        <Table.Head class="w-10"><span class="sr-only">Actions</span></Table.Head>
      {/snippet}
      {#snippet row(item)}
        <Table.Row>
          <Table.Cell class="max-w-[22rem]">
            <span class="block truncate font-medium">{item.name}</span>
            <span class="block truncate text-caption text-muted-foreground">{item.description || "No description"}</span>
          </Table.Cell>
          <Table.Cell><Badge variant={trustVariant(item.trust)}>{item.trust}</Badge></Table.Cell>
          <Table.Cell>
            {#if !item.enabled}<Badge variant="outline">disabled</Badge>
            {:else if listening(item)}<Badge variant="success">listening</Badge>
            {:else}<Badge variant="outline">not listening</Badge>{/if}
          </Table.Cell>
          <Table.Cell class="font-mono text-body-sm">{item.key_prefix}…</Table.Cell>
          <Table.Cell>{#if item.last_poll_at}<Timestamp value={item.last_poll_at} />{:else}<span class="text-muted-foreground">never</span>{/if}</Table.Cell>
          <Table.Cell><RowActions actions={actionsFor(item)} label={`Actions for ${item.name}`} /></Table.Cell>
        </Table.Row>
      {/snippet}
    </DataTable>
  </section>

  <details class="text-body-sm text-muted-foreground">
    <summary class="cursor-pointer select-none font-medium text-foreground">How external clients work</summary>
    <p class="mt-2">
      A client authenticates with its bearer key against <code>/external/v1</code> (long-poll inbox, send, reply, result, heartbeat, agents). Use HTTPS or a network you trust. It only gets the communication surface: no git, secrets, skills, projects or transfers.
    </p>
    <p class="mt-2">
      The trust level is set here and stamped by the server on every message the client sends; text in a message can never change it. It tells a receiving agent how to treat the text and grants no rights by itself. Disabling a client ends its presence at once; replacing its key stops the old one immediately.
    </p>
  </details>
</PageShell>

<ExternalClientDialog
  open={dialogOpen}
  client={editing}
  busy={$createMutation.isPending || $updateMutation.isPending}
  onSubmit={submit}
  onClose={() => (dialogOpen = false)}
/>
<KeyRevealDialog {reveal} onClose={() => (reveal = null)} />

<ConfirmDialog
  open={rotateTarget !== null}
  onClose={() => (rotateTarget = null)}
  title="Replace this key?"
  description={rotateTarget ? `The current key of "${rotateTarget.name}" stops working at once and its connection is dropped. The new key is shown once.` : ""}
  confirmLabel="Replace key"
  busy={$rotateMutation.isPending}
  onConfirm={() => { if (rotateTarget) $rotateMutation.mutate(rotateTarget.id); }}
/>
<ConfirmDialog
  open={deleteTarget !== null}
  onClose={() => (deleteTarget = null)}
  title="Delete this client?"
  description={deleteTarget ? `"${deleteTarget.name}" and its key are removed and its connection is dropped. Messages already delivered stay in the history.` : ""}
  confirmLabel="Delete client"
  destructive
  busy={$deleteMutation.isPending}
  onConfirm={() => { if (deleteTarget) $deleteMutation.mutate(deleteTarget.id); }}
/>
