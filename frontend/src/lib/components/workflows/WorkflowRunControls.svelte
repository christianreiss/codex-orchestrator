<script lang="ts">
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { workflowsApi, workflowRunKeys, type WorkflowRun } from "$lib/api/workflows";
  import { ApiError } from "$lib/api/client";
  import { Section, SaveState } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Input } from "$lib/components/ui/input";
  import { FormField } from "$lib/components/ui/form-field";
  let { run, allowed = false }: { run: WorkflowRun; allowed?: boolean } = $props();
  let reason = $state(""), target = $state(""), pending = $state<{ fingerprint: string; id: string } | null>(null), saved = $state(false);
  const client = useQueryClient();
  const control = createMutation({ mutationFn: (action: string) => {
    const fingerprint = JSON.stringify({ action, reason, target, version: run.version });
    if (pending?.fingerprint !== fingerprint) pending = { fingerprint, id: crypto.randomUUID() };
    const input = { client_request_id: pending!.id, expected_run_version: run.version, reason };
    return action === "prepare_cancel" ? workflowsApi.cancelPrepared(run.run_id,input) : workflowsApi.control(run.run_id,{ ...input, action, ...(action === "coordinator_recover" ? { target_address_id: target.replace(/^agent:/, "") } : {}) });
  }, onSuccess: async () => { pending = null; saved = true; reason = ""; await client.invalidateQueries({ queryKey: workflowRunKeys.all }); } });
</script>
{#if allowed && run.status !== "completed"}
  <Section title="Run controls" description="Pause and cancellation stop new claims. They do not stop an external process already running."><div class="max-w-3xl space-y-3">
    <FormField id="run-control-reason" label="Reason for control or recovery" required><Textarea id="run-control-reason" rows={2} bind:value={reason} /></FormField>
    <div class="flex flex-wrap gap-2">{#if run.status === "running"}<Button variant="outline" disabled={!reason.trim() || $control.isPending} onclick={() => $control.mutate("pause")}>Pause new work</Button>{/if}{#if ["paused","blocked"].includes(run.status)}<Button variant="outline" disabled={!reason.trim() || $control.isPending} onclick={() => $control.mutate("resume")}>Resume run</Button>{/if}{#if ["running","paused"].includes(run.status)}<Button variant="outline" disabled={!reason.trim() || $control.isPending} onclick={() => $control.mutate("block")}>Record blocker</Button>{/if}{#if run.status === "pending" && (!run.coordinator || !!run.preparation)}<Button variant="outline" disabled={!reason.trim() || $control.isPending} onclick={() => $control.mutate("prepare_cancel")}>Cancel prepared run</Button>{:else if ["running","paused","blocked"].includes(run.status)}<Button variant="outline" disabled={!reason.trim() || $control.isPending || run.cancel_requested} onclick={() => $control.mutate("request_cancel")}>Request cancellation</Button>{/if}</div>
    <details class="text-body-sm"><summary class="cursor-pointer py-2">Assign a coordinator for recovery</summary><p class="mb-2 text-muted-foreground">Use an existing agent's canonical UUID. Assignment creates no process and grants no access to external systems.</p><FormField id="run-recovery-agent" label="Existing agent address"><Input id="run-recovery-agent" bind:value={target} placeholder="agent:…" /></FormField><Button class="mt-2" variant="outline" disabled={!reason.trim() || !target.trim() || $control.isPending} onclick={() => $control.mutate("coordinator_recover")}>Assign recovery coordinator</Button></details>
    {#if $control.error || $control.isPending || saved}<SaveState pending={$control.isPending} error={$control.error} {saved} />{/if}{#if $control.error instanceof ApiError && $control.error.status === 409}<Button variant="outline" onclick={() => client.invalidateQueries({queryKey:workflowRunKeys.all})}>Reload current run state</Button><p class="text-body-sm">Review the refreshed run before repeating the control. Your reason is retained.</p>{/if}
  </div></Section>
{/if}
