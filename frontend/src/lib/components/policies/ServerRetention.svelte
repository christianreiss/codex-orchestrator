<script lang="ts">
  import { untrack } from "svelte";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { api } from "$lib/api/client";
  import { authStore } from "$lib/stores/auth";
  import DraftGuard from "$lib/components/page/DraftGuard.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Dialog from "$lib/components/ui/dialog";
  type Policy = { audit_days: number; history_hours: number; quota_days: number; armed: boolean };
  type Run = { id?: string; status?: string; started_at?: string; completed_at?: string; counts?: Record<string, number>; families?: Record<string, { at: string; changed: number }> };
  type Status = { policy: Policy; revision: string; observed_at: string; run: Run | null; limits: Record<string, [number, number]>; fixed: { receipt_result_days: number; internal_receipt_days: number; docker_max_files: number; docker_file_mb: number; docker_age_limit: boolean }; obligations: { family: string; due: boolean; due_at: string | null }[] };
  type Preview = { revision: string; observed_at: string; families: Record<string, { eligible: number; retained: number }>; history: { sessions: number; messages: number; note: string } };
  const qc = useQueryClient(), key = ["settings", "server-retention"];
  const query = createQuery<Status>({ queryKey: key, queryFn: () => api.get<Status>("/admin/server-retention") });
  let audit = $state(14), hours = $state(24), quota = $state(7);
  let baseline = $state(""), baselineRevision = $state("");
  let confirmOpen = $state(false), activation = $state(false), runRequest = $state<string | null>(null);
  const canManage = $derived($authStore.can("settings.manage"));
  const signature = (p: Pick<Policy, "audit_days" | "history_hours" | "quota_days">) => JSON.stringify([p.audit_days,p.history_hours,p.quota_days]);
  const draft = $derived({ audit_days: audit, history_hours: hours, quota_days: quota, armed: $query.data?.policy.armed ?? false });
  const dirty = $derived(!!baseline && signature(draft) !== baseline);
  const conflict = $derived(dirty && !!$query.data && $query.data.revision !== baselineRevision);
  const valid = $derived(Object.entries({ audit_days:audit, history_hours:hours, quota_days:quota }).every(([name,value]) => Number.isInteger(value) && value >= ($query.data?.limits[name]?.[0] ?? 1) && value <= ($query.data?.limits[name]?.[1] ?? (name === "history_hours" ? 87600 : 3650))));
  function adopt(data: Status) { audit=data.policy.audit_days; hours=data.policy.history_hours; quota=data.policy.quota_days; baseline=signature(data.policy); baselineRevision=data.revision; }
  $effect(() => { const data=$query.data; if (data) untrack(() => { if (!dirty) adopt(data); }); });
  const save = createMutation({ mutationFn: (policy: Policy) => api.post<Status>("/admin/server-retention", { policy, expected_revision: baselineRevision }),
    onSuccess: data => { adopt(data); qc.setQueryData(key,data); $preview.reset(); }, onSettled: () => { void qc.invalidateQueries({ queryKey:key }); } });
  const preview = createMutation({ mutationFn: () => api.post<Preview>("/admin/server-retention/preview", {}) });
  const start = createMutation({ mutationFn: async () => {
    if (!$query.data || !$preview.data || $preview.data.revision !== $query.data.revision) throw new Error("The policy changed. Refresh the preview before deleting history.");
    let status=$query.data;
    if (activation) { status=await api.post<Status>("/admin/server-retention", { policy:{...status.policy,armed:true}, expected_revision:status.revision }); qc.setQueryData(key,status); adopt(status); }
    runRequest ??= crypto.randomUUID();
    return api.post<Run>("/admin/server-retention/run", { client_request_id:runRequest, expected_revision:status.revision });
  }, onSuccess: () => { confirmOpen=false; runRequest=null; $preview.reset(); }, onSettled: () => { void qc.invalidateQueries({ queryKey:key }); } });
  const names: Record<string,string> = { auditlogs:"Audit records", adminaudit:"Admin events", quota:"Quota history", receipts:"Command receipts", portal:"Ended portal sessions", conversations:"Inactive conversations" };
  const count = (run: Run) => Object.values(run.counts ?? {}).reduce((sum,n) => sum+n,0);
  function confirmRun() { activation=!$query.data?.policy.armed; confirmOpen=true; }
</script>

<DraftGuard {dirty} />
<section class="space-y-4 py-4" aria-labelledby="server-retention-title">
  <div>
    <h3 id="server-retention-title" class="text-h3">Server history</h3>
    <p class="text-body-sm text-muted-foreground">Keep useful history in the orchestrator database. Active sessions, pending work and unresolved outcomes stay protected.</p>
  </div>
  {#if $query.isPending}
    <p role="status">Loading server retention…</p>
  {:else if $query.error}
    <p role="alert" class="text-body-sm text-destructive">{$query.error.message}</p>
    <Button variant="outline" onclick={() => $query.refetch()}>Retry</Button>
  {:else if $query.data}
    <p class="text-body-sm">Audit, quota and receipt cleanup: <strong>{$query.data.policy.armed ? "Active" : "Prepared — activation pending"}</strong>. Server communication history uses the protected lifecycle cleanup.</p>
    <form class="space-y-4" onsubmit={event => { event.preventDefault(); if (canManage && valid && !conflict) $save.mutate(draft); }}>
      <div class="grid gap-4 sm:grid-cols-3">
        <label class="grid gap-1 text-body-sm" for="retention-audit">Audit history (days)
          <Input id="retention-audit" type="number" min="1" max="3650" step="1" bind:value={audit} disabled={!canManage || $save.isPending} aria-describedby="retention-audit-help" required />
          <span id="retention-audit-help" class="text-caption text-muted-foreground">Authentication, admin and security audit.</span>
        </label>
        <label class="grid gap-1 text-body-sm" for="retention-history">Inactive history (hours)
          <Input id="retention-history" type="number" min="1" max="87600" step="1" bind:value={hours} disabled={!canManage || $save.isPending} aria-describedby="retention-history-help" required />
          <span id="retention-history-help" class="text-caption text-muted-foreground">Ended sessions and unreferenced communication history.</span>
        </label>
        <label class="grid gap-1 text-body-sm" for="retention-quota">Quota history (days)
          <Input id="retention-quota" type="number" min="1" max="3650" step="1" bind:value={quota} disabled={!canManage || $save.isPending} aria-describedby="retention-quota-help" required />
          <span id="retention-quota-help" class="text-caption text-muted-foreground">Current readings and calculation baselines remain protected.</span>
        </label>
      </div>
      {#if !valid}<p role="alert" class="text-body-sm text-destructive">Enter whole days from 1 to 3650 and hours from 1 to 87600.</p>{/if}
      {#if conflict}<p role="alert" class="text-body-sm text-destructive">The effective policy changed while you were editing. Your draft is preserved.</p><Button type="button" variant="outline" onclick={() => { if ($query.data) adopt($query.data); }}>Discard draft and reload</Button>{/if}
      {#if $save.error}<p role="alert" class="text-body-sm text-destructive">{$save.error.message}</p>{/if}
      <div class="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!canManage || !dirty || !valid || conflict || $save.isPending}>{$save.isPending ? "Saving…" : "Save changes"}</Button>
        <span role="status" class="text-body-sm text-muted-foreground">{dirty ? "Unsaved changes" : "Effective policy loaded"}</span>
      </div>
    </form>
    <div class="space-y-2 border-y py-3 text-body-sm">
      <p>Command results: {$query.data.fixed.receipt_result_days} days. Minimal external request IDs and checksums remain to prevent duplicate execution. Unreferenced internal receipts: {$query.data.fixed.internal_receipt_days} days.</p>
      <p>API and MySQL diagnostic logs: up to {$query.data.fixed.docker_max_files} × {$query.data.fixed.docker_file_mb} MB per container. Rotation limits size; it does not guarantee deletion after a number of days.</p>
      <p class="text-muted-foreground">Local transcripts, host overrides, library versions and account credentials use their separate existing rules.</p>
    </div>
    <div class="space-y-3">
      <h4 class="text-body font-semibold">Database cleanup</h4>
      <p class="text-body-sm text-muted-foreground">Preview saved rules before deleting eligible history. Cleanup creates no database or storage backup.</p>
      <Button variant="outline" disabled={dirty || $preview.isPending || $query.data.run?.status === "running"} onclick={() => $preview.mutate()}>{$preview.isPending ? "Checking…" : "Preview eligible history"}</Button>
      {#if dirty}<p class="text-caption text-muted-foreground">Save changes before previewing.</p>{/if}
      {#if $preview.error}<p role="alert" class="text-body-sm text-destructive">{$preview.error.message}</p>{/if}
      {#if $preview.data}
        <div class="overflow-x-auto" role="region" aria-label="Retention preview">
          <table class="w-full text-left text-body-sm"><caption class="sr-only">Eligibility under the saved server retention policy</caption><thead><tr><th class="py-2">History</th><th class="px-3 py-2 text-right">Eligible</th><th class="py-2 text-right">Retained</th></tr></thead>
            <tbody>{#each Object.entries($preview.data.families) as [family,summary]}<tr class="border-t"><th scope="row" class="py-2 font-normal">{names[family] ?? family}</th><td class="px-3 py-2 text-right tabular-nums">{summary.eligible.toLocaleString()}</td><td class="py-2 text-right tabular-nums">{summary.retained.toLocaleString()}</td></tr>{/each}</tbody>
          </table>
        </div>
        <p class="text-caption text-muted-foreground">{$preview.data.history.note} Observed <time datetime={$preview.data.observed_at}>{new Date($preview.data.observed_at).toLocaleString(undefined, { timeZoneName:"short" })}</time>.</p>
        <Button variant="destructive" disabled={!canManage || dirty || $preview.data.revision !== $query.data.revision || $start.isPending} onclick={confirmRun}>{$query.data.policy.armed ? "Delete eligible history" : "Activate and delete eligible history"}</Button>
      {/if}
      {#if $start.error}<p role="alert" class="text-body-sm text-destructive">{$start.error.message} Refresh the status before retrying.</p>{/if}
      {#if $query.data.run?.id}
        {@const run=$query.data.run}
        <p role="status" class="text-body-sm">Cleanup {run.status}: {count(run).toLocaleString()} primary records deleted or compacted.{#if run.completed_at} Completed <time datetime={run.completed_at}>{new Date(run.completed_at).toLocaleString(undefined, { timeZoneName:"short" })}</time>.{/if}</p>
        {#if run.status === "running"}<p class="text-caption text-muted-foreground">Runs in small batches. Protected work can remain older than the cutoff.</p>{/if}
      {/if}
    </div>
  {/if}
</section>
<Dialog.Root bind:open={confirmOpen}>
  <Dialog.Content>
    <Dialog.Header><Dialog.Title>Delete eligible server history</Dialog.Title><Dialog.Description>Apply the saved retention policy to this orchestrator database{activation ? " and activate automatic audit, quota and receipt cleanup" : ""}. Eligible history is permanently removed. No database or storage backup is created. Active work and necessary state stay protected.</Dialog.Description></Dialog.Header>
    {#if $start.error}<p role="alert" class="text-body-sm text-destructive">{$start.error.message}</p>{/if}
    <Dialog.Footer><Button variant="outline" disabled={$start.isPending} onclick={() => { confirmOpen=false; }}>Cancel</Button><Button variant="destructive" disabled={$start.isPending || !canManage} onclick={() => $start.mutate()}>{$start.isPending ? "Starting…" : "Delete eligible server history"}</Button></Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
