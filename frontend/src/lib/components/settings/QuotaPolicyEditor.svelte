<script lang="ts" module>
  export interface EmulationSettings {
    enabled: boolean;
    window_hours: 5 | 8;
    action: 'suggest_pause' | 'suggest_ignore' | 'hard_stop';
    auto_resume: boolean;
  }
  export interface QuotaPolicy {
    unlimited: boolean;
    short_warn_percent: number | null;
    long_warn_percent: number | null;
    short_auto_resume: boolean;
    long_auto_resume: boolean;
  }
</script>
<script lang="ts">
  import { untrack } from "svelte";
  import DraftGuard from "$lib/components/page/DraftGuard.svelte";
  import { derived } from "svelte/store";
  import { toStore } from "svelte/store";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { api } from "$lib/api/client";
  import type { Engine } from "$lib/constants/engines";
  import { Button } from "$lib/components/ui/button";
  import * as Select from "$lib/components/ui/select";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import StateBlock from "$lib/components/page/StateBlock.svelte";

  let { engine, accountId }: { engine: Engine; accountId?: number } = $props();
  const qc = useQueryClient();
  const path = $derived(accountId ? `/admin/accounts/${accountId}/quota-policy` : `/admin/quota-policy/${engine}`);
  const key = $derived(["settings", "quota-policy", engine, accountId ?? "default"]);
  type Value = { defaults: QuotaPolicy; override: QuotaPolicy | null; effective: QuotaPolicy; emulation?: EmulationSettings };
  const query = createQuery<Value>(derived(toStore(() => ({ key, path })), ({ key, path }) => ({ queryKey: key, queryFn: () => api.get<Value>(path) })));
  let draft = $state<QuotaPolicy | null>(null);
  let inherit = $state(false);
  let emulation = $state<EmulationSettings>({ enabled: false, window_hours: 5, action: 'suggest_pause', auto_resume: false });
  let baseline = $state("");
  const snapshot = () => JSON.stringify([draft, inherit, accountId ? null : emulation]);
  const dirty = $derived(draft !== null && baseline !== "" && snapshot() !== baseline);
  const actions = { suggest_pause: 'Warn only — suggest pause', suggest_ignore: 'Warn only — suggest ignore', hard_stop: 'Hard stop — block new work' };
  let initializedPath = "";
  $effect(() => {
    if ($query.data && initializedPath !== path) {
      draft = { ...$query.data.effective };
      if ($query.data.emulation) emulation = { ...$query.data.emulation };
      inherit = !!accountId && !$query.data.override;
      initializedPath = path;
      baseline = untrack(snapshot);
    }
  });
  const mutation = createMutation({
    mutationFn: () => api.put<Value>(path, { policy: inherit ? null : draft, ...(!accountId ? { emulation } : {}) }),
    onSuccess: async (value: Value) => {
      if (value.emulation) emulation = { ...value.emulation };
      draft = { ...value.effective }; inherit = !!accountId && !value.override;
      baseline = snapshot();
      qc.setQueryData(key, value);
      await qc.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
  const disabled = $derived($mutation.isPending || (!!accountId && inherit));
  const prefix = $derived(`quota-${engine}-${accountId ?? "default"}`);
</script>

<DraftGuard {dirty} preserveOnSamePath />

{#if $query.isError}
  <StateBlock state="error" cause={$query.error} message={`Could not load quota policy: ${$query.error.message}`} onRetry={() => $query.refetch()} />
{:else if !draft}
  <p role="status" class="text-body-sm text-muted-foreground">Loading quota policy…</p>
{:else}
  <form class="grid gap-4" onsubmit={(event) => { event.preventDefault(); $mutation.mutate(); }}>
    <fieldset disabled={$mutation.isPending} class="contents">
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
    <p class="text-body-sm text-muted-foreground">Provider-quota recovery requires a confirmed interruption. It retains the original native session; automatic launches require a persistent host.</p>
    {#if !accountId}
      <fieldset class="grid gap-3 border-t pt-3">
        <legend class="text-body-sm font-medium">Emulated short quota</legend>
        <div class="flex items-center gap-3">
          <Switch id={`${prefix}-emulation`} checked={emulation.enabled} onCheckedChange={(v) => emulation.enabled = v} />
          <Label for={`${prefix}-emulation`}>Enable when the provider has no native short window</Label>
        </div>
        <p class="text-body-sm text-muted-foreground">Shared by every host using the same account. Requires a reliable weekly quota. Missing or stale data warns and allows work. PayG / unlimited accounts are excluded.</p>
        <div class="grid gap-1.5">
          <Label for={`${prefix}-hours`}>Window duration</Label>
          <Select.Root type="single" value={String(emulation.window_hours)} onValueChange={(v) => emulation.window_hours = v === '8' ? 8 : 5}>
            <Select.Trigger id={`${prefix}-hours`}><Select.Value>{emulation.window_hours} hours</Select.Value></Select.Trigger>
            <Select.Content><Select.Item value="5" label="5 hours">5 hours</Select.Item><Select.Item value="8" label="8 hours">8 hours</Select.Item></Select.Content>
          </Select.Root>
          <p class="text-body-sm text-muted-foreground">{(100 * emulation.window_hours / 168).toFixed(2)}% of the weekly allowance per window, starting at the first observed consumption. Duration changes apply to the next window.</p>
        </div>
        <div class="grid gap-1.5">
          <Label for={`${prefix}-action`}>At the local limit</Label>
          <Select.Root type="single" value={emulation.action} onValueChange={(v) => emulation.action = v as EmulationSettings['action']}>
            <Select.Trigger id={`${prefix}-action`}><Select.Value>{actions[emulation.action]}</Select.Value></Select.Trigger>
            <Select.Content>{#each Object.entries(actions) as [value, label]}<Select.Item {value} {label}>{label}</Select.Item>{/each}</Select.Content>
          </Select.Root>
          <p class="text-body-sm text-muted-foreground">Hard stop blocks new managed starts and follow-up work, including VIP hosts. The current turn can finish. Warnings use the short-window warning threshold above.</p>
        </div>
        <div class="flex items-center gap-3">
          <Switch id={`${prefix}-emulated-resume`} checked={emulation.auto_resume} onCheckedChange={(v) => emulation.auto_resume = v} />
          <Label for={`${prefix}-emulated-resume`}>Server resume after reset</Label>
        </div>
        <p class="text-body-sm text-muted-foreground">Resumes only follow-up work held by this hard stop, in its original native session. Canceled, expired or completed work stays stopped. With resume off, held work requires an explicit retry or cancellation.</p>
      </fieldset>
    {/if}
    <div class="flex flex-wrap items-center gap-3">
      <Button type="submit" size="sm" disabled={$mutation.isPending}>Save quota policy</Button>
      {#if $mutation.isPending}<p role="status" class="text-body-sm">Saving…</p>{/if}
      {#if dirty && !$mutation.isPending}<p role="status" class="text-body-sm">Unsaved quota policy changes.</p>{:else if $mutation.isSuccess}<p role="status" class="text-body-sm">Quota policy saved.</p>{/if}
      {#if $mutation.isError}<p role="alert" class="text-body-sm text-destructive">{$mutation.error.message}</p>{/if}
    </div>
    </fieldset>
  </form>
{/if}
