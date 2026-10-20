<script lang="ts">
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { workflowsApi, workflowRunKeys, type WorkflowDefinition, type WorkflowRun } from "$lib/api/workflows";
  import { FormField } from "$lib/components/ui/form-field";
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import { SaveState, DraftGuard } from "$lib/components/page";
  let { definition, run, allowed = false }: { definition: WorkflowDefinition; run?: WorkflowRun; allowed?: boolean } = $props();
  let title = $state(""), inputs = $state<Record<string, string | number | boolean>>({}), initialized = false, dirty = $state(false), saved = $state(false);
  let request = $state<{ fingerprint: string; id: string } | null>(null);
  $effect(() => {
    if (initialized) return;
    title = run?.title ?? definition.document.title;
    for (const input of definition.document.inputs) { const value = run?.inputs[input.key] ?? input.default; if (["string", "number", "boolean"].includes(typeof value)) inputs[input.key] = value as string | number | boolean; }
    initialized = true;
  });
  const client = useQueryClient();
  const save = createMutation({ mutationFn: () => {
    const fingerprint = JSON.stringify({ title, inputs });
    if (request?.fingerprint !== fingerprint) request = { fingerprint, id: crypto.randomUUID() };
    if (run) return workflowsApi.control(run.run_id, { client_request_id: request!.id, expected_run_version: run.version, action: "configure", title, inputs });
    return workflowsApi.prepare({ client_request_id: request!.id, workflow_id: definition.workflow_id, version: definition.version, title, inputs });
  }, onSuccess: async result => { dirty = false; saved = true; request = null; await client.invalidateQueries({ queryKey: workflowRunKeys.all }); if (!run) await goto(`${base}/workflows/runs/${result.run_id}`); } });
</script>
<DraftGuard {dirty} />
<form class="space-y-3" oninput={() => dirty = true} onsubmit={e => { e.preventDefault(); $save.mutate(); }}>
  <p class="text-body-sm text-muted-foreground">{run ? "These inputs can be changed until an agent starts the run." : `Uses workflow version ${definition.version}. Preparation creates a report link and a copyable assignment; it does not start an agent.`} Secret values belong in the Secrets Store.</p>
  <fieldset disabled={!allowed || $save.isPending} class="min-w-0 space-y-3">
    <FormField id="run-title" label="Run title" required><Input id="run-title" bind:value={title} required /></FormField>
    {#each definition.document.inputs as input (input.key)}
      <FormField id={`run-input-${input.key}`} label={input.label} required={input.required} hint={input.description}>
        {#if input.type === "boolean"}<select id={`run-input-${input.key}`} class="h-9 w-full rounded border border-input bg-background px-2" required={input.required} value={inputs[input.key] === undefined ? "" : String(inputs[input.key])} aria-describedby={input.description ? `run-input-${input.key}-hint` : undefined} onchange={e => { if (!e.currentTarget.value) delete inputs[input.key]; else inputs[input.key] = e.currentTarget.value === "true"; dirty = true; }}><option value="">Not set</option><option value="true">True</option><option value="false">False</option></select>
        {:else if input.type === "enum"}<select id={`run-input-${input.key}`} class="h-9 w-full rounded border border-input bg-background px-2" required={input.required} value={String(inputs[input.key] ?? "")} aria-describedby={input.description ? `run-input-${input.key}-hint` : undefined} onchange={e => { if (!e.currentTarget.value) delete inputs[input.key]; else inputs[input.key] = e.currentTarget.value; dirty = true; }}><option value="">Choose…</option>{#each input.options ?? [] as option}<option>{option}</option>{/each}</select>
        {:else}<Input id={`run-input-${input.key}`} type={input.type === "number" ? "number" : "text"} required={input.required} value={String(inputs[input.key] ?? "")} aria-describedby={input.description ? `run-input-${input.key}-hint` : undefined} oninput={e => { if (e.currentTarget.value === "") delete inputs[input.key]; else inputs[input.key] = input.type === "number" ? Number(e.currentTarget.value) : e.currentTarget.value; }} />{/if}
      </FormField>
    {/each}
  </fieldset>
  <SaveState pending={$save.isPending} error={$save.error} {dirty} {saved} />
  <Button type="submit" disabled={!allowed || $save.isPending}>{run ? "Save run inputs" : "Prepare run"}</Button>
</form>
