<script lang="ts">
  import { untrack } from "svelte";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { api } from "$lib/api/client";
  import { authStore } from "$lib/stores/auth";
  import PolicyCard from "./PolicyCard.svelte";
  type Engine = "codex" | "claude" | "grok";
  type Policy = { enabled: boolean; retention_days: number; max_bytes: number; min_age_days: number };
  type Effective = Policy & { source: "fleet" | "host"; override: Policy | null; fleet: Policy };
  type Policies = Record<Engine, Effective>;
  let { hostId }: { hostId?: string } = $props();
  const qc = useQueryClient();
  const targetHost = untrack(() => hostId);
  const endpoint = targetHost ? `/admin/hosts/${targetHost}/session-housekeeping` : "/admin/session-housekeeping";
  const queryKey = targetHost ? ["hosts", targetHost, "session-housekeeping"] : ["settings", "session-housekeeping"];
  const query = createQuery<{ policies: Policies; last_run: string | null }>({ queryKey, queryFn: async () => {
    const result = targetHost ? await api.get<{ policies: Policies; last_run: string | null }>(endpoint) : { policies: await api.get<Policies>(endpoint), last_run: null };
    if (!result.policies?.codex || !result.policies.claude || !result.policies.grok) throw new Error("Session housekeeping rules are unavailable.");
    return result;
  } });
  const lastRun = $derived.by(() => { try { return $query.data?.last_run ? JSON.parse($query.data.last_run) as { engine: string; observed_at: string; freed_bytes: number; outcome: string } : null; } catch { return null; } });
  let engine = $state<Engine>("codex");
  let enabled = $state(true);
  let retention = $state(30);
  let budget = $state(5);
  let minimum = $state(7);
  let inherit = $state(true);
  let baseline = $state("");
  let adoptedEngine = $state<Engine | null>(null);
  const draft = $derived({ enabled, retention_days: retention, max_bytes: Math.round(budget * 1024 ** 3), min_age_days: minimum });
  const signature = (p: Effective) => JSON.stringify({ enabled: p.enabled, retention_days: p.retention_days, max_bytes: p.max_bytes, min_age_days: p.min_age_days, inherit: p.source === "fleet" });
  const draftSignature = $derived(JSON.stringify({ ...draft, inherit }));
  const dirty = $derived(baseline !== "" && draftSignature !== baseline);
  const conflict = $derived(dirty && !!$query.data && signature($query.data.policies[engine]) !== baseline);
  const valid = $derived(Number.isInteger(retention) && retention >= 1 && retention <= 3650 && Number.isInteger(minimum) && minimum >= 1 && minimum <= retention && Number.isFinite(budget) && budget >= 1 / 1024 && budget <= 1024);
  const canManage = $derived($authStore.can(hostId ? "hosts.manage" : "settings.manage"));
  function adopt(p: Effective) {
    enabled = p.enabled; retention = p.retention_days; budget = p.max_bytes / 1024 ** 3; minimum = p.min_age_days; inherit = p.source === "fleet"; baseline = signature(p); adoptedEngine = engine;
  }
  $effect(() => {
    const p = $query.data?.policies[engine];
    if (p) untrack(() => { if (adoptedEngine !== engine || !dirty) adopt(p); });
  });
  const save = createMutation({ mutationFn: (value: Policy | null) => api.post<Effective>(`${endpoint}/${engine}`, value === null ? { inherit: true } : value),
    onSuccess: () => { baseline = ""; void qc.invalidateQueries({ queryKey }); },
    onSettled: () => { void qc.invalidateQueries({ queryKey }); },
  });
</script>
<PolicyCard id={hostId ? "host-session-housekeeping" : "session-housekeeping"} title="Session housekeeping"
  scope={hostId ? "Local session storage · host override" : "Local session storage · fleet defaults"}
  description="Keep recent conversations and remove older sessions to reclaim disk space. cxx applies these rules separately for each engine and local user."
  details="Deletion permanently removes transcripts and their session history. Active sessions, pins, open goals, queued work and fleet resume or wake bindings stay protected. Protected or young sessions may exceed the budget. cxx waits for an idle engine and checks at most daily after a successful run.">
  {#if lastRun}<p class="text-xs text-muted-foreground">Last host report: {lastRun.engine} · {lastRun.outcome} · {new Date(lastRun.observed_at).toLocaleString()} · {((lastRun.freed_bytes ?? 0) / 1024 ** 3).toFixed(2)} GiB reclaimed</p>{/if}
  <div class="flex flex-wrap items-center gap-3">
    <label for={`housekeeping-engine-${hostId ?? 'fleet'}`} class="text-sm font-medium">Engine</label>
    <select id={`housekeeping-engine-${hostId ?? 'fleet'}`} class="rounded-md border bg-background px-3 py-2 text-sm" bind:value={engine} disabled={$save.isPending}>
      <option value="codex">Codex</option><option value="claude">Claude</option><option value="grok">Grok</option>
    </select>
    {#if $query.data}<span class="text-xs text-muted-foreground">{$query.data.policies[engine].source === "host" ? "Host override" : "Fleet rule"}</span>{/if}
  </div>
  {#if $query.isPending}<p role="status" class="text-sm text-muted-foreground">Loading rules…</p>
  {:else if $query.error}<p role="alert" class="text-sm text-destructive">{$query.error.message}</p>
  {:else}
    <form class="space-y-4" onsubmit={(event) => { event.preventDefault(); if (canManage && !conflict && valid) $save.mutate(hostId && inherit ? null : draft); }}>
      {#if hostId}<label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={inherit} disabled={!canManage || $save.isPending}/>Use fleet rule</label>{/if}
      <fieldset disabled={!canManage || $save.isPending || !!hostId && inherit} class="space-y-3 disabled:opacity-60">
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={enabled}/>Enable automatic housekeeping</label>
        <div class="grid gap-3 sm:grid-cols-3">
          <label class="grid gap-1 text-sm">Retention (days)<input class="rounded-md border bg-background px-3 py-2" type="number" min="1" max="3650" step="1" bind:value={retention} required/></label>
          <label class="grid gap-1 text-sm">Budget (GiB)<input class="rounded-md border bg-background px-3 py-2" type="number" min="0.0009765625" max="1024" step="any" bind:value={budget} required/></label>
          <label class="grid gap-1 text-sm">Minimum age under pressure (days)<input class="rounded-md border bg-background px-3 py-2" type="number" min="1" max={retention} step="1" bind:value={minimum} required/></label>
        </div>
      </fieldset>
      {#if !valid}<p role="alert" class="text-sm text-destructive">Enter valid durations and a budget. Minimum age must not exceed retention.</p>{/if}
      {#if conflict}<p role="alert" class="text-sm text-destructive">The saved rule changed. Reload it before saving.</p>{/if}
      <div class="flex gap-2">
        <button type="submit" class="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={!canManage || !dirty || !valid || conflict || $save.isPending}>Save rule</button>
        <button type="button" class="rounded-md border px-3 py-2 text-sm" onclick={() => { if ($query.data) adopt($query.data.policies[engine]); }} disabled={$save.isPending}>Reload saved rule</button>
      </div>
      {#if $save.error}<p role="alert" class="text-sm text-destructive">Save failed: {$save.error.message}</p>{/if}
      {#if $save.isSuccess}<p role="status" class="text-sm text-muted-foreground">Rule saved.</p>{/if}
    </form>
  {/if}
</PolicyCard>
