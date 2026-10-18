<script lang="ts">
  import { writable } from "svelte/store";
  import { toast } from "svelte-sonner";
  import { useQueryClient } from "@tanstack/svelte-query";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Plus from "@lucide/svelte/icons/plus";
  import AlarmClock from "@lucide/svelte/icons/alarm-clock";
  import Pause from "@lucide/svelte/icons/pause";
  import Play from "@lucide/svelte/icons/play";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Eye from "@lucide/svelte/icons/eye";
  import { DataTable, ListDetail, PageShell } from "$lib/components/page";
  import RowActions, { type RowAction } from "$lib/components/data-table/RowActions.svelte";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import * as Table from "$lib/components/ui/table";
  import ScheduleDetailView from "$lib/components/schedules/ScheduleDetail.svelte";
  import ScheduleForm from "$lib/components/schedules/ScheduleForm.svelte";
  import { authStore } from "$lib/stores/auth";
  import { agentMessagingAddressesQuery } from "$lib/api/agentMessaging";
  import { scheduleKeys, scheduleMutation, scheduleQuery, schedulesQuery, type Schedule } from "$lib/api/schedules";
  import { relativeTime } from "$lib/utils/format";

  const client = useQueryClient();
  const after = writable<string | undefined>();
  const listQuery = schedulesQuery(after);
  const addresses = agentMessagingAddressesQuery();
  const selected = writable("");
  const detailQuery = scheduleQuery(selected);
  const canManage = $derived($authStore.can("agent_messaging.manage"));

  let formDirty = $state(false);
  let panelOpen = $state(false);
  let editing = $state(false);
  let formKey = $state(0);
  let editTarget = $state<Schedule | null>(null);
  let deleteTarget = $state<Schedule | null>(null);

  const mutation = scheduleMutation(
    () => {
      formDirty = false;
      editing = false;
      panelOpen = false;
      toast.success("Saved");
    },
    (error) => toast.error(error.message),
  );
  const agents = $derived($addresses.data?.addresses ?? []);
  const rows = $derived($listQuery.data?.schedules);

  function agentLabel(address: string) {
    const agent = agents.find((item) => item.address === address);
    return agent ? agent.name || agent.alias || agent.username : address;
  }
  function view(row: Schedule) {
    $selected = row.id;
    editing = false;
    panelOpen = true;
  }
  function openForm(row: Schedule | null) {
    editTarget = row;
    formKey += 1;
    editing = true;
    panelOpen = true;
  }
  const togglePaused = (row: Schedule) => $mutation.mutate({ method: "PATCH", id: row.id, body: { version: row.version, enabled: !row.enabled } });
  function confirmDelete() {
    const row = deleteTarget;
    if (!row) return;
    $mutation.mutate({ method: "DELETE", id: row.id, body: { version: row.version } });
    $selected = "";
    deleteTarget = null;
  }
  function actionsFor(row: Schedule): RowAction[] {
    const base: RowAction[] = [{ label: "View", icon: Eye, onClick: () => view(row) }];
    if (!canManage) return base;
    return [
      ...base,
      { label: row.enabled ? "Pause" : "Enable", icon: row.enabled ? Pause : Play, onClick: () => togglePaused(row), disabled: $mutation.isPending },
      { label: "Delete", icon: Trash2, destructive: true, onClick: () => (deleteTarget = row), disabled: $mutation.isPending },
    ];
  }
  const timing = (row: Schedule) => (row.kind === "interval" ? `Every ${row.interval_minutes} min` : row.kind === "cron" ? row.cron : "Once");
  const title = $derived(editing ? (editTarget ? "Edit wake-up" : "New wake-up") : ($detailQuery.data?.schedule.name ?? "Wake-up details"));
</script>

<PageShell title="Timed wake-ups" description="Prompts sent to an agent on a schedule, with optional recovery of the same session (wake/cron).">
  {#snippet actions()}
    <Button variant="outline" size="sm" onclick={() => client.invalidateQueries({ queryKey: scheduleKeys.all })}><RefreshCw class="h-4 w-4" /> Refresh</Button>
    {#if canManage}<Button onclick={() => openForm(null)}><Plus class="h-4 w-4" /> Create schedule</Button>{/if}
  {/snippet}

  <ListDetail dirty={editing && formDirty} bind:open={panelOpen} {title} description={editing ? "Choose an agent, prompt and wake time." : "Prompt and latest execution results."} onClose={() => (editing = false)}>
    {#snippet list()}
      <DataTable
        items={rows}
        loading={$listQuery.isPending}
        error={$listQuery.error?.message ?? null}
        onRetry={() => $listQuery.refetch()}
        key={(row) => row.id}
        emptyTitle="No timed wake-ups yet"
        emptyDescription="Regular wake-ups wait for a receiver. Persistent recovery resumes the same session."
        emptyIcon={AlarmClock}
        caption="Timed wake-ups"
      >
        {#snippet head()}
          <Table.Head>Wake-up</Table.Head>
          <Table.Head>Target</Table.Head>
          <Table.Head>Timing</Table.Head>
          <Table.Head>Next wake</Table.Head>
          <Table.Head>Recovery</Table.Head>
          <Table.Head class="w-10"><span class="sr-only">Actions</span></Table.Head>
        {/snippet}
        {#snippet row(item)}
          <Table.Row class="cursor-pointer" onclick={() => view(item)}>
            <Table.Cell class="font-medium">
              <button type="button" class="text-left underline-offset-4 hover:underline" onclick={(event) => { event.stopPropagation(); view(item); }}>{item.name}</button>
              <span class="block"><Badge variant={item.enabled ? "success" : "secondary"}>{item.enabled ? "Enabled" : "Paused"}</Badge></span>
            </Table.Cell>
            <Table.Cell class="max-w-48 break-words" title={item.target}>{agentLabel(item.target)}</Table.Cell>
            <Table.Cell>{timing(item)}<span class="block text-caption text-muted-foreground">{item.timezone}</span></Table.Cell>
            <Table.Cell title={item.next_due_at ?? ""}>{item.next_due_at ? relativeTime(item.next_due_at) : "No further wake"}</Table.Cell>
            <Table.Cell>
              {item.persistent ? `On · ${item.progress_timeout_seconds}s timeout` : "Off"}
              {#if item.pause_reason}<p class="text-caption text-destructive">Paused: {item.pause_reason}</p>{/if}
            </Table.Cell>
            <Table.Cell onclick={(event: MouseEvent) => event.stopPropagation()}>
              <RowActions actions={actionsFor(item)} label={`Actions for ${item.name}`} />
            </Table.Cell>
          </Table.Row>
        {/snippet}
      </DataTable>
      {#if $after || $listQuery.data?.next_cursor}
        <div class="mt-3 flex gap-2">
          {#if $after}<Button variant="outline" size="sm" onclick={() => ($after = undefined)}>First page</Button>{/if}
          {#if $listQuery.data?.next_cursor}<Button variant="outline" size="sm" onclick={() => ($after = $listQuery.data!.next_cursor!)}>Next page</Button>{/if}
        </div>
      {/if}
    {/snippet}
    {#snippet detail()}
      {#if editing && canManage}
        {#key formKey}
          <ScheduleForm bind:dirty={formDirty}
            schedule={editTarget}
            {agents}
            agentsError={$addresses.error?.message}
            pending={$mutation.isPending}
            onSubmit={(method, id, body) => $mutation.mutate({ method, id, body })}
            onCancel={() => (panelOpen = false)}
          />
        {/key}
      {:else if $selected}
        <ScheduleDetailView
          detail={$detailQuery.data}
          error={$detailQuery.error?.message}
          {agentLabel}
          {canManage}
          onEdit={() => $detailQuery.data && openForm($detailQuery.data.schedule)}
        />
      {/if}
    {/snippet}
  </ListDetail>
</PageShell>

<ConfirmDialog
  open={deleteTarget !== null}
  onClose={() => (deleteTarget = null)}
  title="Delete this wake-up?"
  description={deleteTarget ? `"${deleteTarget.name}" stops waking its agent. This cannot be undone.` : ""}
  confirmLabel="Delete"
  destructive
  onConfirm={confirmDelete}
/>
