<script lang="ts">
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { workflowsApi, workflowRunKeys, type WorkflowDefinition, type WorkflowRun, type WorkflowQuestion } from "$lib/api/workflows";
  import { ApiError } from "$lib/api/client";
  import { FormField } from "$lib/components/ui/form-field";
  import * as Select from "$lib/components/ui/select";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Button } from "$lib/components/ui/button";
  import { SaveState, DraftGuard } from "$lib/components/page";
  let { definition, run, allowed = false, dirty = $bindable(false), errors = {} }: { definition: WorkflowDefinition; run?: WorkflowRun; allowed?: boolean; dirty?: boolean; errors?: Record<string, string> } = $props();
  let title = $state(""), inputs = $state<Record<string, string | number | boolean>>({}), initialized = $state(false), saved = $state(false);
  let conflictHead = $state<WorkflowRun | null>(null), conflictError = $state("");
  async function loadComparison() { try { conflictHead = await workflowsApi.report(run!.run_id); conflictError = ""; } catch (error) { conflictError = error instanceof Error ? error.message : "Could not load current answers."; } }
  let questions = $state<WorkflowQuestion[]>([]), expected = $state(0);
  let request = $state<{ fingerprint: string; id: string } | null>(null);
  $effect(() => {
    if (initialized && (dirty || expected === (run?.version ?? 0))) return;
    inputs = {};
    questions = structuredClone(run?.preparation?.questions ?? []);
    expected = run?.version ?? 0;
    title = run?.title ?? definition.document.title;
    for (const input of definition.document.inputs) { const value = run?.inputs[input.key] ?? input.default; if (["string", "number", "boolean"].includes(typeof value)) inputs[input.key] = value as string | number | boolean; }
    initialized = true;
  });
  const client = useQueryClient();
  const save = createMutation({ mutationFn: () => {
    const fingerprint = JSON.stringify({ title, inputs, questions, expected });
    if (request?.fingerprint !== fingerprint) request = { fingerprint, id: crypto.randomUUID() };
    if (run) return workflowsApi.control(run.run_id, { client_request_id: request!.id, expected_run_version: expected, action: "configure", title, inputs, ...(run.preparation ? { questions } : {}) });
    return workflowsApi.prepare({ client_request_id: request!.id, workflow_id: definition.workflow_id, version: definition.version, title, inputs });
  }, onSuccess: async result => { dirty = false; saved = true; request = null; conflictHead = null; await client.invalidateQueries({ queryKey: workflowRunKeys.all }); if (!run) await goto(`${base}/workflows/runs/${result.run_id}`); } });
</script>
<DraftGuard {dirty} />
<form class="max-w-3xl space-y-6" oninput={() => dirty = true} onsubmit={e => { e.preventDefault(); $save.mutate(); }}>
  <p class="text-body-sm text-muted-foreground">{run ? "Save your answers, then review the execution summary." : `Uses workflow version ${definition.version}. Save the request first, then clarify questions and confirm the summary. Preparation does not start an agent.`} Secret values belong in the Secrets Store.</p>
  <fieldset disabled={!allowed || $save.isPending} class="min-w-0 space-y-4">
    <legend class="text-body font-semibold">Request</legend>
    <FormField id="run-title" label="Run title" required><Input id="run-title" bind:value={title} required /></FormField>
    <fieldset class="min-w-0 space-y-4"><legend class="text-body font-semibold">Workflow answers</legend>
    <p class="text-body-sm text-muted-foreground">Fields marked * are required before review. You can save incomplete answers.</p>
    {#each definition.document.inputs as input (input.key)}
      <FormField id={`run-input-${input.key}`} label={input.label} required={input.required} error={errors[`run-input-${input.key}`]} hint={input.description} class={input.type === "number" ? "max-w-xs" : ""}>
        {@const fieldId = `run-input-${input.key}`}
        {@const describedBy = errors[fieldId] ? `${fieldId}-error` : input.description ? `${fieldId}-hint` : undefined}
        {#if input.type === "boolean" || input.type === "enum"}
          <Select.Root type="single" disabled={!allowed || $save.isPending} value={inputs[input.key] === undefined ? "" : String(inputs[input.key])}
            onValueChange={value => { if (!value) delete inputs[input.key]; else inputs[input.key] = input.type === "boolean" ? value === "true" : value; dirty = true; }}>
            <Select.Trigger id={fieldId} aria-required={input.required} aria-invalid={!!errors[fieldId]} aria-describedby={describedBy}>
              <span class="truncate">{inputs[input.key] === undefined ? "Choose…" : input.type === "boolean" ? inputs[input.key] ? "Yes" : "No" : String(inputs[input.key])}</span>
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="" label="Not set">Not set</Select.Item>
              {#if input.type === "boolean"}
                <Select.Item value="true" label="Yes">Yes</Select.Item><Select.Item value="false" label="No">No</Select.Item>
              {:else}{#each input.options ?? [] as option}<Select.Item value={option} label={option}>{option}</Select.Item>{/each}{/if}
            </Select.Content>
          </Select.Root>
        {:else if input.type === "number"}
          <Input id={fieldId} type="number" aria-required={input.required} value={String(inputs[input.key] ?? "")} aria-invalid={!!errors[fieldId]} aria-describedby={describedBy}
            oninput={e => { if (e.currentTarget.value === "") delete inputs[input.key]; else inputs[input.key] = Number(e.currentTarget.value); }} />
        {:else}
          <Textarea id={fieldId} rows={2} class="resize-y [field-sizing:content] max-h-80" aria-required={input.required} value={String(inputs[input.key] ?? "")} aria-invalid={!!errors[fieldId]} aria-describedby={describedBy}
            oninput={e => { if (e.currentTarget.value === "") delete inputs[input.key]; else inputs[input.key] = e.currentTarget.value; }} />
        {/if}
      </FormField>
    {/each}
    </fieldset>
    {#if run?.preparation}
      <fieldset class="min-w-0 space-y-3"><legend class="text-body font-semibold">Follow-up questions</legend>
        {#each questions as question, i (question.id)}
          <div class="space-y-2 border-b pb-3">
            <FormField id={`followup-question-${question.id}`} label={`Additional question ${i + 1}`}><Textarea id={`followup-question-${question.id}`} rows={2} class="resize-y [field-sizing:content] max-h-80" bind:value={question.question} /></FormField>
            <FormField id={`followup-answer-${question.id}`} label={`Answer ${i + 1}`} error={errors[`followup-answer-${question.id}`]}><Textarea id={`followup-answer-${question.id}`} rows={2} aria-invalid={!!errors[`followup-answer-${question.id}`]} aria-describedby={errors[`followup-answer-${question.id}`] ? `followup-answer-${question.id}-error` : undefined} bind:value={question.answer} /></FormField>
            <Button type="button" variant="ghost" size="sm" onclick={() => { questions = questions.filter(q => q.id !== question.id); dirty = true; }}>Remove question {i + 1}</Button>
          </div>
        {/each}
        <Button type="button" variant="outline" size="sm" disabled={questions.length >= 64} onclick={() => { questions = [...questions, { id: `question-${crypto.randomUUID()}`, question: "", answer: "" }]; dirty = true; }}>Add follow-up question</Button>
      </fieldset>
    {/if}
  </fieldset>
  <SaveState pending={$save.isPending} error={$save.error} {dirty} {saved} />
  {#if run && $save.error instanceof ApiError && $save.error.status === 409}
    <p class="text-body-sm">The saved run changed. Your draft is retained. Compare the current answers before saving again.</p>
    <Button type="button" variant="outline" onclick={loadComparison}>Load current answers for comparison</Button>
    {#if conflictError}<p role="alert" class="text-body-sm text-destructive">{conflictError}</p>{/if}
    {#if conflictHead}<div class="space-y-3 rounded-md border p-3" aria-label="Current saved answers"><h3 class="text-body font-semibold">Current saved answers</h3><p class="text-body">{conflictHead.title}</p><dl class="space-y-2 text-body-sm">{#each definition.document.inputs as input (input.key)}<div><dt class="font-medium">{input.label}</dt><dd class="whitespace-pre-wrap break-words">{conflictHead.inputs[input.key] === undefined ? "Not specified" : String(conflictHead.inputs[input.key])}</dd></div>{/each}{#each conflictHead.preparation?.questions ?? [] as question (question.id)}<div><dt class="font-medium">{question.question}</dt><dd class="whitespace-pre-wrap break-words">{question.answer ?? "Not specified"}</dd></div>{/each}</dl>
      {#if conflictHead.status === "pending"}<Button type="button" variant="outline" onclick={() => { expected = conflictHead!.version; request = null; conflictHead = null; }}>I reviewed the saved answers; keep my draft</Button>{:else}<p class="text-body-sm">This run has left preparation. Its answers can no longer be changed.</p>{/if}
    </div>{/if}
  {/if}
  <Button type="submit" variant={run && !dirty ? "outline" : "default"} disabled={!allowed || $save.isPending}>{run ? "Save answers" : "Prepare run"}</Button>
</form>
