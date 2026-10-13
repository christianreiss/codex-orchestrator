<script lang="ts">
  import { untrack } from "svelte";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { api } from "$lib/api/client";
  import { authStore } from "$lib/stores/auth";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Switch } from "$lib/components/ui/switch";
  import * as Dialog from "$lib/components/ui/dialog";
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
  let editorOpen = $state(false);
  let requestedEngine = $state<Engine | null>(null);
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
  function editEngine(next: Engine) {
    if (next !== engine && dirty) { requestedEngine = next; return; }
    engine = next;
    editorOpen = true;
  }
  function discardAndSwitch() {
    if (!requestedEngine || !$query.data) return;
    engine = requestedEngine;
    adopt($query.data.policies[engine]);
    requestedEngine = null;
    editorOpen = true;
  }
  async function saveAndSwitch() {
    if (!canManage || !valid || conflict || !requestedEngine) return;
    try {
      await $save.mutateAsync(hostId && inherit ? null : draft);
      discardAndSwitch();
    } catch { /* Keep the current draft and show the mutation error. */ }
  }

</script>
{#if hostId}
<section id="host-session-housekeeping" class="space-y-3 rounded-lg border bg-card p-4" aria-labelledby="host-housekeeping-heading">
  <h2 id="host-housekeeping-heading" class="text-sm font-semibold">Session housekeeping</h2>
  <p class="text-xs text-muted-foreground">Local session storage rules for each engine.</p>
  {#if $query.isPending}<p role="status">Loading rules…</p>
  {:else if $query.error}<p role="alert" class="text-sm text-destructive">{$query.error.message}</p>
  {:else if $query.data}
    <div class="divide-y">
      {#each ["codex", "claude", "grok"] as item}
        {@const key = item as Engine}
        {@const policy = $query.data.policies[key]}
        <div class="flex flex-wrap items-center justify-between gap-2 py-3">
          <div class="min-w-0">
            <span class="text-sm font-medium capitalize">{item}</span>
            <span class="ml-2 text-xs text-muted-foreground">{policy.source === "host" ? "Host override" : "Fleet rule"}</span>
            <p class="text-xs text-muted-foreground">{policy.enabled ? "Enabled" : "Disabled"} · {policy.retention_days} days · {(policy.max_bytes / 1024 ** 3).toLocaleString()} GiB</p>
          </div>
          <Button variant="outline" size="sm" aria-label={`Edit ${item} housekeeping`} disabled={$save.isPending} onclick={() => editEngine(key)}>Edit{dirty && engine === key ? " · unsaved" : ""}</Button>
        </div>
      {/each}
    </div>
  {/if}
  {#if lastRun}<p class="text-xs text-muted-foreground">Last host report: {lastRun.engine} · {lastRun.outcome} · {new Date(lastRun.observed_at).toLocaleString()} · {((lastRun.freed_bytes ?? 0) / 1024 ** 3).toFixed(2)} GiB reclaimed</p>{/if}
  {#if editorOpen}
    <div class="space-y-3 border-t pt-3">
      <h3 class="text-sm font-semibold capitalize">{engine} rule</h3>
      <p class="text-xs text-muted-foreground">Deletion permanently removes transcripts and their session history.</p>
      {@render ruleForm()}
      <details class="text-xs text-muted-foreground"><summary class="cursor-pointer">Protection details</summary><p class="mt-2">Active sessions, pins, open goals, queued work and fleet resume or wake bindings stay protected. Protected or young sessions may exceed the budget. cxx waits for an idle engine and checks at most daily after a successful run.</p></details>
    </div>
  {/if}
</section>
<Dialog.Root open={requestedEngine !== null} onOpenChange={(open) => { if (!open && !$save.isPending) requestedEngine = null; }}>
  <Dialog.Content>
    <Dialog.Header><Dialog.Title>Unsaved housekeeping rule</Dialog.Title><Dialog.Description>Save or discard the {engine} draft before editing {requestedEngine}.</Dialog.Description></Dialog.Header>
    {#if $save.error}<p role="alert" class="text-sm text-destructive">{$save.error.message}</p>{/if}
    <Dialog.Footer>
      <Button variant="ghost" disabled={$save.isPending} onclick={() => requestedEngine = null}>Cancel</Button>
      <Button variant="outline" disabled={$save.isPending} onclick={discardAndSwitch}>Discard and switch</Button>
      <Button disabled={!canManage || !valid || conflict || $save.isPending} onclick={saveAndSwitch}>Save and switch</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
{:else}
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
    {@render ruleForm()}
  {/if}
</PolicyCard>

{/if}

{#snippet ruleForm()}
    <form class="space-y-4" onsubmit={(event) => { event.preventDefault(); if (canManage && !conflict && valid) $save.mutate(hostId && inherit ? null : draft); }}>
      {#if hostId}<label class="flex items-center gap-2 text-sm"><Switch checked={inherit} onCheckedChange={(value) => inherit = value} disabled={!canManage || $save.isPending} aria-label="Use fleet rule"/>Use fleet rule</label>{/if}
      <fieldset disabled={!canManage || $save.isPending || !!hostId && inherit} class="space-y-3 disabled:opacity-60">
        <label class="flex items-center gap-2 text-sm"><Switch checked={enabled} onCheckedChange={(value) => enabled = value} disabled={!canManage || $save.isPending || !!hostId && inherit} aria-label="Enable automatic housekeeping"/>Enable automatic housekeeping</label>
        <div class="grid gap-3 sm:grid-cols-3">
          <label class="grid gap-1 text-sm">Retention (days)<Input class="h-9" type="number" min="1" max="3650" step="1" bind:value={retention} required/></label>
          <label class="grid gap-1 text-sm">Budget (GiB)<Input class="h-9" type="number" min="0.0009765625" max="1024" step="any" bind:value={budget} required/></label>
          <label class="grid gap-1 text-sm">Minimum age under pressure (days)<Input class="h-9" type="number" min="1" max={retention} step="1" bind:value={minimum} required/></label>
        </div>
      </fieldset>
      {#if !valid}<p role="alert" class="text-sm text-destructive">Enter valid durations and a budget. Minimum age must not exceed retention.</p>{/if}
      {#if conflict}<p role="alert" class="text-sm text-destructive">The saved rule changed. Reload it before saving.</p>{/if}
      <div class="flex gap-2">
        <Button type="submit" size="sm" disabled={!canManage || !dirty || !valid || conflict || $save.isPending}>Save rule</Button>
        <Button type="button" variant="outline" size="sm" onclick={() => { if ($query.data) adopt($query.data.policies[engine]); }} disabled={$save.isPending}>Reload saved rule</Button>
      </div>
      {#if $save.error}<p role="alert" class="text-sm text-destructive">Save failed: {$save.error.message}</p>{/if}
      {#if $save.isSuccess}<p role="status" class="text-sm text-muted-foreground">Rule saved.</p>{/if}
    </form>
{/snippet}
