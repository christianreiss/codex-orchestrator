<script lang="ts">
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  /**
   * One list of every API key, with a vendor filter in place of three tabs.
   * Keys stay namespaced per endpoint on the server (`/admin/{openai|claude|grok}/keys`),
   * so this merges the three existing queries and routes each mutation by the row's endpoint.
   */
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import { Button } from "$lib/components/ui/button";
  import { Switch } from "$lib/components/ui/switch";
  import { Badge } from "$lib/components/ui/badge";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import * as Table from "$lib/components/ui/table";
  import { Toolbar, DataTable } from "$lib/components/page";
  import SortableHead from "$lib/components/data-table/SortableHead.svelte";
  import RowActions from "$lib/components/data-table/RowActions.svelte";
  import { keysApi, keyQueryKeys, engineLabel, isActive } from "$lib/api/keys";
  import type { AdminApiKey, ApiKeyEngine } from "$lib/api/types";
  import { cn } from "$lib/utils/cn";
  import { BACKEND_LABEL } from "./connection";
  import EndpointSummary from "./EndpointSummary.svelte";

  type Vendor = ApiKeyEngine | "all";
  type KeyRow = AdminApiKey & { format: ApiKeyEngine };
  type Props = { vendor: Vendor; onCreate: () => void };
  let { vendor = $bindable("all"), onCreate }: Props = $props();

  const VENDORS: Array<{ value: Vendor; label: string }> = [
    { value: "all", label: "All" },
    { value: "openai", label: "OpenAI" },
    { value: "claude", label: "Anthropic" },
    { value: "grok", label: "Grok" },
  ];

  const qc = useQueryClient();
  const openaiQuery = createQuery<AdminApiKey[]>({ queryKey: keyQueryKeys.list("openai"), queryFn: () => keysApi.list("openai") });
  const claudeQuery = createQuery<AdminApiKey[]>({ queryKey: keyQueryKeys.list("claude"), queryFn: () => keysApi.list("claude") });
  const grokQuery = createQuery<AdminApiKey[]>({ queryKey: keyQueryKeys.list("grok"), queryFn: () => keysApi.list("grok") });

  let revokeOpen = $state(false);
  let revokeTarget = $state<KeyRow | null>(null);
  let search = $state("");
  let sortKey = $state<"name" | "last_used">("name");
  let sortDir = $state<"asc" | "desc">("asc");

  const sources = $derived([
    { engine: "openai" as const, q: $openaiQuery },
    { engine: "claude" as const, q: $claudeQuery },
    { engine: "grok" as const, q: $grokQuery },
  ]);
  const scoped = $derived(sources.filter((entry) => vendor === "all" || entry.engine === vendor));
  const loading = $derived(scoped.some((entry) => entry.q.isLoading));
  const failure = $derived(scoped.find((entry) => entry.q.isError));
  const error = $derived(failure ? `Failed to load ${engineLabel(failure.engine)} keys: ${failure.q.error?.message ?? "Unknown error"}` : null);
  const all = $derived<KeyRow[]>(scoped.flatMap((entry) => (entry.q.data ?? []).map((record) => ({ ...record, format: entry.engine }))));

  const q = $derived(search.trim().toLowerCase());
  const rows = $derived.by(() => {
    const filtered = q ? all.filter((r) => r.name?.toLowerCase().includes(q) || r.key_prefix?.toLowerCase().includes(q)) : all;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const cmp = sortKey === "name"
        ? (a.name ?? "").localeCompare(b.name ?? "")
        : (a.last_used_at ?? "").localeCompare(b.last_used_at ?? "");
      return (cmp || (a.name ?? "").localeCompare(b.name ?? "") || a.id - b.id) * dir;
    });
  });

  function onSort(key: "name" | "last_used") {
    if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortKey = key; sortDir = "asc"; }
  }

  const toggleMutation = createMutation<unknown, Error, { engine: ApiKeyEngine; id: number; active: boolean }, { previousActive?: number | boolean }>({
    mutationFn: ({ engine, id, active }) => keysApi.toggle(engine, id, active),
    onMutate: async ({ engine, id, active }) => {
      const listKey = keyQueryKeys.list(engine);
      await qc.cancelQueries({ queryKey: listKey });
      const previousActive = qc.getQueryData<AdminApiKey[]>(listKey)?.find((k) => k.id === id)?.is_active;
      qc.setQueryData<AdminApiKey[]>(listKey, (current) => current?.map((k) => (k.id === id ? { ...k, is_active: active ? 1 : 0 } : k)));
      return { previousActive };
    },
    onError: (err, vars, ctx) => {
      // Patch only the row that failed so a concurrent change to another row survives.
      qc.setQueryData<AdminApiKey[]>(keyQueryKeys.list(vars.engine), (current) =>
        current?.map((k) => (k.id === vars.id && ctx?.previousActive !== undefined ? { ...k, is_active: ctx.previousActive } : k)),
      );
      toast.error(`Failed to ${vars.active ? "enable" : "disable"} key`, { description: err.message });
    },
    onSuccess: (_data, vars) => toast.success(vars.active ? "Key enabled" : "Key disabled"),
    onSettled: (_d, _e, vars) => void qc.invalidateQueries({ queryKey: keyQueryKeys.list(vars.engine) }),
  });

  const deleteMutation = createMutation<unknown, Error, { engine: ApiKeyEngine; id: number }, { previousRecord?: AdminApiKey; previousIndex?: number }>({
    mutationFn: ({ engine, id }) => keysApi.remove(engine, id),
    onMutate: async ({ engine, id }) => {
      const listKey = keyQueryKeys.list(engine);
      await qc.cancelQueries({ queryKey: listKey });
      const previous = qc.getQueryData<AdminApiKey[]>(listKey);
      const previousIndex = previous?.findIndex((k) => k.id === id);
      const previousRecord = previousIndex !== undefined && previousIndex >= 0 ? previous?.[previousIndex] : undefined;
      qc.setQueryData<AdminApiKey[]>(listKey, (current) => current?.filter((k) => k.id !== id));
      return { previousRecord, previousIndex };
    },
    onError: (err, vars, ctx) => {
      // Re-insert only the row that failed to delete.
      const record = ctx?.previousRecord;
      if (record) {
        qc.setQueryData<AdminApiKey[]>(keyQueryKeys.list(vars.engine), (current) => {
          if (!current || current.some((k) => k.id === record.id)) return current;
          const next = current.slice();
          next.splice(Math.min(ctx?.previousIndex ?? current.length, current.length), 0, record);
          return next;
        });
      }
      toast.error("Failed to revoke key", { description: err.message });
    },
    onSuccess: () => {
      toast.success("Key revoked");
      revokeOpen = false;
      revokeTarget = null;
    },
    onSettled: (_d, _e, vars) => void qc.invalidateQueries({ queryKey: keyQueryKeys.list(vars.engine) }),
  });

  function formatExpires(s: string | null | undefined): string {
    const d = s ? new Date(s) : null;
    if (!d || Number.isNaN(d.getTime())) return s ?? "Never";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  const vendorLabel = (v: Vendor) => VENDORS.find((entry) => entry.value === v)?.label ?? v;
</script>

<div class="space-y-3">
  <Toolbar
    bind:search
    searchPlaceholder="Search keys by name or prefix"
    count={q ? `${rows.length} of ${all.length}` : `${all.length} ${all.length === 1 ? "key" : "keys"}`}
  >
    {#snippet filters()}
      <div role="group" aria-label="Filter keys by API" class="inline-flex rounded-md border p-0.5">
        {#each VENDORS as option (option.value)}
          <button
            type="button"
            aria-pressed={vendor === option.value}
            class={cn(
              "h-8 rounded-md px-2.5 text-caption transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              vendor === option.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            onclick={() => (vendor = option.value)}
          >{option.label}</button>
        {/each}
      </div>
    {/snippet}
    {#snippet actions()}
      <EndpointSummary onSelect={(next) => (vendor = next)} />
      <Button onclick={onCreate}><Plus class="h-4 w-4" />New key</Button>
    {/snippet}
  </Toolbar>

  <DataTable
    items={rows}
    {loading}
    {error}
    onRetry={() => { void $openaiQuery.refetch(); void $claudeQuery.refetch(); void $grokQuery.refetch(); }}
    key={(r) => `${r.format}:${r.id}`}
    filtered={q !== ""}
    emptyIcon={KeyRound}
    emptyTitle={vendor === "all" ? "No API keys yet" : `No ${vendorLabel(vendor)} keys yet`}
    emptyDescription="Issue a key for each application that calls the fleet API."
    caption="API keys"
  >
    {#snippet head()}
      <SortableHead label="Name" active={sortKey === "name"} dir={sortDir} onclick={() => onSort("name")} />
      <Table.Head>API</Table.Head>
      <Table.Head>Engine</Table.Head>
      <Table.Head>Active</Table.Head>
      <SortableHead label="Last used" active={sortKey === "last_used"} dir={sortDir} onclick={() => onSort("last_used")} class="hidden md:table-cell" />
      <Table.Head class="hidden lg:table-cell">Expires</Table.Head>
      <Table.Head class="w-12"><span class="sr-only">Actions</span></Table.Head>
    {/snippet}
    {#snippet row(record)}
      {@const active = isActive(record)}
      {@const expired = record.expires_at ? new Date(record.expires_at).getTime() < Date.now() : false}
      <Table.Row>
        <Table.Cell>
          <div class="font-medium">{record.name}</div>
          <code class="font-mono text-caption text-muted-foreground">{record.key_prefix}</code>
        </Table.Cell>
        <Table.Cell class="text-body-sm">{vendorLabel(record.format)}</Table.Cell>
        <Table.Cell class="text-body-sm">{record.backend_engine ? BACKEND_LABEL[record.backend_engine] : "Endpoint default"}</Table.Cell>
        <Table.Cell>
          <Switch
            checked={active}
            disabled={$toggleMutation.isPending}
            aria-label={`Active: ${record.name}`}
            onCheckedChange={(next) => $toggleMutation.mutate({ engine: record.format, id: Number(record.id), active: next })}
          />
        </Table.Cell>
        <Table.Cell class="hidden text-body-sm md:table-cell">
          {#if record.last_used_at}
            <span title={record.last_used_at}><Timestamp value={record.last_used_at} /></span>
          {:else}
            <span class="text-muted-foreground">Never</span>
          {/if}
          <div class="text-caption text-muted-foreground">{record.use_count.toLocaleString()} {record.use_count === 1 ? "use" : "uses"}</div>
        </Table.Cell>
        <Table.Cell class="hidden text-body-sm lg:table-cell">
          {#if expired}
            <Badge variant="destructive">Expired</Badge>
          {:else if record.expires_at}
            <span title={record.expires_at}>{formatExpires(record.expires_at)}</span>
          {:else}
            <span class="text-muted-foreground">Never</span>
          {/if}
        </Table.Cell>
        <Table.Cell class="text-right">
          <RowActions
            label={`Actions for ${record.name}`}
            actions={[{ label: "Revoke key", icon: Trash2, destructive: true, onClick: () => { revokeTarget = record; revokeOpen = true; } }]}
          />
        </Table.Cell>
      </Table.Row>
    {/snippet}
  </DataTable>
</div>

<ConfirmDialog
  bind:open={revokeOpen}
  title="Revoke API key?"
  description={`${revokeTarget?.name || revokeTarget?.key_prefix || "This key"} will stop working immediately for every client that uses it. This cannot be undone.`}
  confirmLabel="Revoke key"
  destructive
  busy={$deleteMutation.isPending}
  onConfirm={() => { if (revokeTarget) $deleteMutation.mutate({ engine: revokeTarget.format, id: Number(revokeTarget.id) }); }}
  onClose={() => (revokeTarget = null)}
/>
