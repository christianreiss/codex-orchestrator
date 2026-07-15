<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Power from "@lucide/svelte/icons/power";
  import PowerOff from "@lucide/svelte/icons/power-off";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import * as Table from "$lib/components/ui/table";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Switch } from "$lib/components/ui/switch";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { keysApi, keyQueryKeys, engineLabel, isActive } from "$lib/api/keys";
  import type { AdminApiKey, ApiKeyEngine } from "$lib/api/types";
  import { relativeTime } from "$lib/utils/format";

  type Props = { engine: ApiKeyEngine };
  let { engine }: Props = $props();
  // Engine is fixed per component instance; snapshot it so the query-options
  // object doesn't capture a reactive proxy.
  // svelte-ignore state_referenced_locally
  const engineKey: ApiKeyEngine = engine;

  const qc = useQueryClient();
  const listKey = keyQueryKeys.list(engineKey);
  let revokeTarget = $state<AdminApiKey | null>(null);

  const keysQuery = createQuery<AdminApiKey[]>({
    queryKey: listKey,
    queryFn: () => keysApi.list(engineKey),
  });

  const toggleMutation = createMutation<
    unknown,
    Error,
    { id: number; active: boolean },
    { previousActive?: number | boolean }
  >({
    mutationFn: ({ id, active }) => keysApi.toggle(engineKey, id, active),
    onMutate: async ({ id, active }) => {
      await qc.cancelQueries({ queryKey: listKey });
      const previous = qc.getQueryData<AdminApiKey[]>(listKey);
      const previousActive = previous?.find((k) => k.id === id)?.is_active;
      qc.setQueryData<AdminApiKey[]>(listKey, (current) =>
        current?.map((k) =>
          k.id === id ? { ...k, is_active: active ? 1 : 0 } : k,
        ),
      );
      return { previousActive };
    },
    onError: (err, vars, ctx) => {
      // Patch only the row that failed rather than restoring the whole
      // snapshot, so a concurrent mutation on another row isn't clobbered.
      qc.setQueryData<AdminApiKey[]>(listKey, (current) =>
        current?.map((k) =>
          k.id === vars.id && ctx?.previousActive !== undefined
            ? { ...k, is_active: ctx.previousActive }
            : k,
        ),
      );
      toast.error(`Failed to ${vars.active ? "enable" : "disable"} key`, {
        description: err.message,
      });
    },
    onSuccess: (_data, vars) => {
      toast.success(vars.active ? "Key enabled" : "Key disabled");
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: listKey });
    },
  });

  const deleteMutation = createMutation<
    unknown,
    Error,
    number,
    { previousRecord?: AdminApiKey; previousIndex?: number }
  >({
    mutationFn: (id) => keysApi.remove(engineKey, id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: listKey });
      const previous = qc.getQueryData<AdminApiKey[]>(listKey);
      const previousIndex = previous?.findIndex((k) => k.id === id);
      const previousRecord =
        previousIndex !== undefined && previousIndex >= 0
          ? previous?.[previousIndex]
          : undefined;
      qc.setQueryData<AdminApiKey[]>(listKey, (current) =>
        current?.filter((k) => k.id !== id),
      );
      return { previousRecord, previousIndex };
    },
    onError: (err, _id, ctx) => {
      // Re-insert only the row that failed to delete rather than restoring
      // the whole snapshot, so a concurrent mutation on another row isn't
      // clobbered.
      const record = ctx?.previousRecord;
      if (record) {
        qc.setQueryData<AdminApiKey[]>(listKey, (current) => {
          if (!current || current.some((k) => k.id === record.id)) return current;
          const index = Math.min(ctx?.previousIndex ?? current.length, current.length);
          const next = current.slice();
          next.splice(index, 0, record);
          return next;
        });
      }
      toast.error("Failed to revoke key", { description: err.message });
    },
    onSuccess: () => {
      toast.success("Key revoked");
      revokeTarget = null;
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: listKey });
    },
  });

  function confirmRevoke(record: AdminApiKey) {
    revokeTarget = record;
  }

  function onToggle(record: AdminApiKey, next: boolean) {
    $toggleMutation.mutate({ id: Number(record.id), active: next });
  }

  function formatExpires(s: string | null | undefined): string {
    if (!s) return "Never";
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  const rows = $derived($keysQuery.data ?? []);
  const isLoading = $derived($keysQuery.isLoading);
  const error = $derived($keysQuery.error);
</script>

<div class="overflow-hidden rounded-xl border border-border/75 bg-card shadow-sm">
  {#if error}
    <div class="p-6 text-sm text-destructive">
      Failed to load keys: {error.message}
    </div>
  {:else}
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>Name</Table.Head>
          <Table.Head>Key prefix</Table.Head>
          <Table.Head class="text-right">Rate limit</Table.Head>
          <Table.Head class="text-center">Active</Table.Head>
          <Table.Head class="text-right">Uses</Table.Head>
          <Table.Head>Last used</Table.Head>
          <Table.Head>Expires</Table.Head>
          <Table.Head class="w-[80px] text-right">Actions</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#if isLoading}
          {#each Array(3) as _, i (i)}
            <Table.Row>
              {#each Array(8) as _2, j (j)}
                <Table.Cell><Skeleton class="h-4 w-full" /></Table.Cell>
              {/each}
            </Table.Row>
          {/each}
        {:else if rows.length === 0}
          <Table.Row>
            <Table.Cell colspan={8} class="py-12 text-center">
              <div class="flex flex-col items-center gap-2 text-muted-foreground">
                <KeyRound class="h-8 w-8 opacity-40" />
                <p class="text-sm">No {engineLabel(engine)} keys yet</p>
                <p class="text-xs">Use "New key" to issue your first one.</p>
              </div>
            </Table.Cell>
          </Table.Row>
        {:else}
          {#each rows as record (record.id)}
            {@const active = isActive(record)}
            <Table.Row>
              <Table.Cell class="font-medium">{record.name}</Table.Cell>
              <Table.Cell>
                <code
                  class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                  >{record.key_prefix}</code
                >
              </Table.Cell>
              <Table.Cell class="text-right tabular-nums">
                {record.rate_limit_rpm}/min
              </Table.Cell>
              <Table.Cell class="text-center">
                <Switch
                  checked={active}
                  onCheckedChange={(v) => onToggle(record, v)}
                  disabled={$toggleMutation.isPending}
                  aria-label="Toggle active"
                />
              </Table.Cell>
              <Table.Cell class="text-right tabular-nums">
                {record.use_count.toLocaleString()}
              </Table.Cell>
              <Table.Cell class="text-muted-foreground">
                {#if record.last_used_at}
                  <span title={record.last_used_at}
                    >{relativeTime(record.last_used_at)}</span
                  >
                {:else}
                  <span class="text-muted-foreground">Never</span>
                {/if}
              </Table.Cell>
              <Table.Cell>
                {#if record.expires_at}
                  {@const exp = new Date(record.expires_at)}
                  {@const expired = !Number.isNaN(exp.getTime()) && exp.getTime() < Date.now()}
                  {#if expired}
                    <Badge variant="destructive">Expired</Badge>
                  {:else}
                    <span class="text-sm" title={record.expires_at}
                      >{formatExpires(record.expires_at)}</span
                    >
                  {/if}
                {:else}
                  <span class="text-muted-foreground">Never</span>
                {/if}
              </Table.Cell>
              <Table.Cell class="text-right">
                <div class="flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={active ? "Disable key" : "Enable key"}
                    title={active ? "Disable" : "Enable"}
                    onclick={() => onToggle(record, !active)}
                    disabled={$toggleMutation.isPending}
                  >
                    {#if active}
                      <PowerOff class="h-4 w-4" />
                    {:else}
                      <Power class="h-4 w-4" />
                    {/if}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Revoke key"
                    title="Revoke"
                    class="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onclick={() => confirmRevoke(record)}
                    disabled={$deleteMutation.isPending}
                  >
                    <Trash2 class="h-4 w-4" />
                  </Button>
                </div>
              </Table.Cell>
            </Table.Row>
          {/each}
        {/if}
      </Table.Body>
    </Table.Root>
  {/if}
</div>

<Dialog.Root open={revokeTarget !== null} onOpenChange={(open) => open || (revokeTarget = null)}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Revoke API key?</Dialog.Title>
      <Dialog.Description>
        <span class="font-medium text-foreground">{revokeTarget?.name || revokeTarget?.key_prefix}</span>
        will stop working immediately for every client that uses it. This cannot be undone.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (revokeTarget = null)} disabled={$deleteMutation.isPending}>
        Cancel
      </Button>
      <Button
        variant="destructive"
        onclick={() => revokeTarget && $deleteMutation.mutate(Number(revokeTarget.id))}
        disabled={$deleteMutation.isPending}
      >
        {$deleteMutation.isPending ? "Revoking…" : "Revoke key"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
