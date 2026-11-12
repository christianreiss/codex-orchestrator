<script lang="ts">
  import { formatDateTime } from "$lib/utils/format";
  import DraftGuard from "$lib/components/page/DraftGuard.svelte";
  import { untrack } from "svelte";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { api } from "$lib/api/client";
  import { hostOverridesQuery } from "$lib/api/settings";
  import { authStore } from "$lib/stores/auth";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Switch } from "$lib/components/ui/switch";
  import PolicyRow from "./PolicyRow.svelte";
  type Engine = "codex" | "claude" | "grok";
  type Policy = { enabled: boolean; retention_days: number; max_bytes: number; min_age_days: number };
  type Effective = Policy & { source: "fleet" | "host"; override: Policy | null; fleet: Policy };
  type Policies = Record<Engine, Effective>;
  /** The fleet-wide rule. Per-host overrides are edited on the host's page; here they are only counted. */
  const qc = useQueryClient();
  const endpoint = "/admin/session-housekeeping";
  const queryKey = ["settings", "session-housekeeping"];
  const query = createQuery<Policies>({ queryKey, queryFn: async () => {
    const result = await api.get<Policies>(endpoint);
    if (!result?.codex || !result.claude || !result.grok) throw new Error("Session housekeeping rules are unavailable.");
    return result;
  } });
  const overrides = hostOverridesQuery();
  let engine = $state<Engine>("codex");
  let enabled = $state(true);
  let retention = $state(30);
  let budget = $state(5);
  let minimum = $state(7);
  let baseline = $state("");
  let adoptedEngine = $state<Engine | null>(null);
  const draft = $derived({ enabled, retention_days: retention, max_bytes: Math.round(budget * 1024 ** 3), min_age_days: minimum });
  const signature = (p: Effective) => JSON.stringify({ enabled: p.enabled, retention_days: p.retention_days, max_bytes: p.max_bytes, min_age_days: p.min_age_days });
  const draftSignature = $derived(JSON.stringify(draft));
  const dirty = $derived(baseline !== "" && draftSignature !== baseline);
  const conflict = $derived(dirty && !!$query.data && signature($query.data[engine]) !== baseline);
  const valid = $derived(Number.isInteger(retention) && retention >= 1 && retention <= 3650 && Number.isInteger(minimum) && minimum >= 1 && minimum <= retention && Number.isFinite(budget) && budget >= 1 / 1024 && budget <= 1024);
  const canManage = $derived($authStore.can("settings.manage"));
  function adopt(p: Effective) {
    enabled = p.enabled; retention = p.retention_days; budget = p.max_bytes / 1024 ** 3; minimum = p.min_age_days; baseline = signature(p); adoptedEngine = engine;
  }
  $effect(() => {
    const p = $query.data?.[engine];
    if (p) untrack(() => { if (adoptedEngine !== engine || !dirty) adopt(p); });
  });
  const save = createMutation({ mutationFn: (value: Policy) => api.post<Effective>(`${endpoint}/${engine}`, value),
    onSuccess: () => { baseline = ""; void qc.invalidateQueries({ queryKey }); },
    onSettled: () => { void qc.invalidateQueries({ queryKey }); },
  });
</script>
<DraftGuard {dirty} />
<PolicyRow
  id="session-housekeeping"
  stacked
  label="Clean up old agent sessions"
  term="session housekeeping"
  help="Keep recent conversations and remove older sessions to reclaim disk space, per engine and local user."
  details="Deletion permanently removes transcripts and their session history. Active sessions, pins, open goals, queued work and fleet resume or wake bindings stay protected. Protected or young sessions may exceed the budget. cxx waits for an idle engine and checks at most daily after a successful run."
  overrideCount={$overrides.data?.session_housekeeping[engine] ?? null}
  overrideNoun={`${engine} rule`}
>
  <div class="flex flex-wrap items-center gap-3">
    <label for="housekeeping-engine-fleet" class="text-body-sm font-medium">Engine</label>
    <select id="housekeeping-engine-fleet" class="h-9 rounded-md border bg-background px-3 text-body-sm" bind:value={engine} disabled={$save.isPending}>
      <option value="codex">Codex</option><option value="claude">Claude</option><option value="grok">Grok</option>
    </select>
  </div>
  {#if $query.isPending}<p role="status" class="text-body-sm text-muted-foreground">Loading rules…</p>
  {:else if $query.error}
    <p role="alert" class="text-body-sm text-destructive">{$query.error.message}</p>
    <Button variant="outline" size="sm" onclick={() => void $query.refetch()}>Retry loading</Button>
  {:else}
    <form class="space-y-4" onsubmit={(event) => { event.preventDefault(); if (canManage && !conflict && valid) $save.mutate(draft); }}>
      <fieldset disabled={!canManage || $save.isPending} class="space-y-3 disabled:opacity-60">
        <label class="flex items-center gap-2 text-body"><Switch checked={enabled} onCheckedChange={(value) => enabled = value} disabled={!canManage || $save.isPending} aria-label="Enable automatic housekeeping"/>Enable automatic housekeeping</label>
        <div class="grid gap-3 sm:grid-cols-3">
          <label class="grid gap-1 text-body">Retention (days)<Input class="h-9" type="number" min="1" max="3650" step="1" bind:value={retention} required/></label>
          <label class="grid gap-1 text-body">Budget (GiB)<Input class="h-9" type="number" min="0.0009765625" max="1024" step="any" bind:value={budget} required/></label>
          <label class="grid gap-1 text-body">Minimum age under pressure (days)<Input class="h-9" type="number" min="1" max={retention} step="1" bind:value={minimum} required/></label>
        </div>
      </fieldset>
      {#if !valid}<p role="alert" class="text-body text-destructive">Enter valid durations and a budget. Minimum age must not exceed retention.</p>{/if}
      {#if conflict}<p role="alert" class="text-body text-destructive">The saved rule changed. Reload it before saving.</p>{/if}
      {#if !canManage}<p class="text-body-sm text-muted-foreground">Read only: changes require <code class="font-mono">settings.manage</code>.</p>{/if}
      <div class="flex gap-2">
        <Button type="submit" size="sm" disabled={!canManage || !dirty || !valid || conflict || $save.isPending}>Save rule</Button>
        <Button type="button" variant="outline" size="sm" onclick={() => { if ($query.data) adopt($query.data[engine]); }} disabled={$save.isPending}>Reload saved rule</Button>
      </div>
      {#if $save.error}<p role="alert" class="text-body text-destructive">Save failed: {$save.error.message}</p>{/if}
      {#if $save.isSuccess}<p role="status" class="text-body text-muted-foreground">Rule saved.</p>{/if}
    </form>
  {/if}
</PolicyRow>
