<script lang="ts" module>
  export interface QuotaPolicy {
    unlimited: boolean;
    short_warn_percent: number | null;
    long_warn_percent: number | null;
    short_auto_resume: boolean;
    long_auto_resume: boolean;
  }
</script>
<script lang="ts">
  import { derived } from "svelte/store";
  import { toStore } from "svelte/store";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { api } from "$lib/api/client";
  import type { Engine } from "$lib/constants/engines";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import StateBlock from "$lib/components/page/StateBlock.svelte";

  let { engine, accountId }: { engine: Engine; accountId?: number } = $props();
  const qc = useQueryClient();
  const path = $derived(accountId ? `/admin/accounts/${accountId}/quota-policy` : `/admin/quota-policy/${engine}`);
  const key = $derived(["settings", "quota-policy", engine, accountId ?? "default"]);
  type Value = { defaults: QuotaPolicy; override: QuotaPolicy | null; effective: QuotaPolicy };
  const query = createQuery<Value>(derived(toStore(() => ({ key, path })), ({ key, path }) => ({ queryKey: key, queryFn: () => api.get<Value>(path) })));
  let draft = $state<QuotaPolicy | null>(null);
  let inherit = $state(false);
  let initializedPath = "";
  $effect(() => {
    if ($query.data && initializedPath !== path) {
      draft = { ...$query.data.effective };
      inherit = !!accountId && !$query.data.override;
      initializedPath = path;
    }
  });
  const mutation = createMutation({
    mutationFn: () => api.put<Value>(path, { policy: inherit ? null : draft }),
    onSuccess: async (value: Value) => {
      draft = { ...value.effective }; inherit = !!accountId && !value.override;
      qc.setQueryData(key, value);
      await qc.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
  const disabled = $derived(!!accountId && inherit);
  const prefix = $derived(`quota-${engine}-${accountId ?? "default"}`);
</script>

{#if $query.isError}
  <StateBlock state="error" message={`Could not load quota policy: ${$query.error.message}`} onRetry={() => $query.refetch()} />
{:else if !draft}
  <p role="status" class="text-body-sm text-muted-foreground">Loading quota policy…</p>
{:else}
  <form class="grid gap-4" onsubmit={(event) => { event.preventDefault(); $mutation.mutate(); }}>
    {#if accountId}
      <div class="flex items-center gap-3">
        <Switch id={`${prefix}-inherit`} checked={inherit} onCheckedChange={(v) => { inherit = v; if (v && $query.data) draft = { ...$query.data.defaults }; }} />
        <Label for={`${prefix}-inherit`}>Use engine defaults</Label>
      </div>
      <div class="flex items-center gap-3">
        <Switch id={`${prefix}-unlimited`} checked={draft.unlimited} {disabled} onCheckedChange={(v) => { if (draft) draft.unlimited = v; }} />
        <Label for={`${prefix}-unlimited`}>PayG / unlimited</Label>
      </div>
      <p class="text-body-sm text-muted-foreground">Unlimited disables quota warnings, startup blocks and quota-triggered resume for this account. Configure billing at the provider separately.</p>
    {/if}
    {#each ["short", "long"] as kind}
      {@const window = kind as "short" | "long"}
      {@const warnKey = `${window}_warn_percent` as "short_warn_percent" | "long_warn_percent"}
      {@const resumeKey = `${window}_auto_resume` as "short_auto_resume" | "long_auto_resume"}
      <fieldset disabled={disabled || draft.unlimited} class="grid gap-3 border-t pt-3">
        <legend class="text-body-sm font-medium">{window === "short" ? "Short window (when available)" : "Long window (weekly or monthly)"}</legend>
        <div class="flex items-center gap-3">
          <Switch id={`${prefix}-${window}-warn`} checked={draft[warnKey] !== null} onCheckedChange={(v) => { if (draft) draft[warnKey] = v ? 85 : null; }} />
          <Label for={`${prefix}-${window}-warn`}>Warn agents</Label>
        </div>
        {#if draft[warnKey] !== null}
          <div class="grid gap-1.5"><Label for={`${prefix}-${window}-percent`}>Warning threshold (%)</Label><Input id={`${prefix}-${window}-percent`} type="number" min={1} max={100} step={1} required bind:value={draft[warnKey]} /></div>
        {/if}
        <div class="flex items-center gap-3">
          <Switch id={`${prefix}-${window}-resume`} checked={draft[resumeKey]} onCheckedChange={(v) => { if (draft) draft[resumeKey] = v; }} />
          <Label for={`${prefix}-${window}-resume`}>Resume interrupted work after reset</Label>
        </div>
      </fieldset>
    {/each}
    <p class="text-body-sm text-muted-foreground">Only a confirmed quota interruption can arm resume. The original native session is retained. Automatic starts require a persistent host.</p>
    <div class="flex flex-wrap items-center gap-3">
      <Button type="submit" size="sm" disabled={$mutation.isPending}>Save quota policy</Button>
      {#if $mutation.isPending}<p role="status" class="text-body-sm">Saving…</p>{/if}
      {#if $mutation.isSuccess}<p role="status" class="text-body-sm">Quota policy saved.</p>{/if}
      {#if $mutation.isError}<p role="alert" class="text-body-sm text-destructive">{$mutation.error.message}</p>{/if}
    </div>
  </form>
{/if}
