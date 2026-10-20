<script lang="ts">
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { workflowsApi, workflowRunKeys, type WorkflowDefinition, type WorkflowRun, type WorkflowQuestion } from "$lib/api/workflows";
  import { ApiError } from "$lib/api/client";
  import { FormField } from "$lib/components/ui/form-field";
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
<form class="space-y-3" oninput={() => dirty = true} onsubmit={e => { e.preventDefault(); $save.mutate(); }}>
  <p class="text-body-sm text-muted-foreground">{run ? "Answers can be saved while incomplete. Changes require a new summary and confirmation before execution." : `Uses workflow version ${definition.version}. Save the request first, then clarify questions and confirm the summary. Preparation does not start an agent.`} Secret values belong in the Secrets Store.</p>
  <fieldset disabled={!allowed || $save.isPending} class="min-w-0 space-y-3">
    <FormField id="run-title" label="Run title" required><Input id="run-title" bind:value={title} required /></FormField>
    {#each definition.document.inputs as input (input.key)}
      <FormField id={`run-input-${input.key}`} label={input.label} required={input.required} error={errors[`run-input-${input.key}`]} hint={[input.description, input.required ? "Required before confirmation." : ""].filter(Boolean).join(" ")}>
        {#if input.type === "boolean"}<select id={`run-input-${input.key}`} class="h-9 w-full rounded border border-input bg-background px-2" aria-required={input.required} value={inputs[input.key] === undefined ? "" : String(inputs[input.key])} aria-invalid={!!errors[`run-input-${input.key}`]} aria-describedby={errors[`run-input-${input.key}`] ? `run-input-${input.key}-error` : input.description || input.required ? `run-input-${input.key}-hint` : undefined} onchange={e => { if (!e.currentTarget.value) delete inputs[input.key]; else inputs[input.key] = e.currentTarget.value === "true"; dirty = true; }}><option value="">Not set</option><option value="true">True</option><option value="false">False</option></select>
        {:else if input.type === "enum"}<select id={`run-input-${input.key}`} class="h-9 w-full rounded border border-input bg-background px-2" aria-required={input.required} value={String(inputs[input.key] ?? "")} aria-invalid={!!errors[`run-input-${input.key}`]} aria-describedby={errors[`run-input-${input.key}`] ? `run-input-${input.key}-error` : input.description || input.required ? `run-input-${input.key}-hint` : undefined} onchange={e => { if (!e.currentTarget.value) delete inputs[input.key]; else inputs[input.key] = e.currentTarget.value; dirty = true; }}><option value="">Choose…</option>{#each input.options ?? [] as option}<option>{option}</option>{/each}</select>
        {:else}<Input id={`run-input-${input.key}`} type={input.type === "number" ? "number" : "text"} aria-required={input.required} value={String(inputs[input.key] ?? "")} aria-invalid={!!errors[`run-input-${input.key}`]} aria-describedby={errors[`run-input-${input.key}`] ? `run-input-${input.key}-error` : input.description || input.required ? `run-input-${input.key}-hint` : undefined} oninput={e => { if (e.currentTarget.value === "") delete inputs[input.key]; else inputs[input.key] = input.type === "number" ? Number(e.currentTarget.value) : e.currentTarget.value; }} />{/if}
      </FormField>
    {/each}
    {#if run?.preparation}
      <fieldset class="min-w-0 space-y-3"><legend class="text-body font-semibold">Additional questions</legend>
        {#each questions as question, i (question.id)}
          <div class="space-y-2 border-b pb-3">
            <FormField id={`followup-question-${question.id}`} label={`Additional question ${i + 1}`}><Input id={`followup-question-${question.id}`} bind:value={question.question} /></FormField>
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
  <Button type="submit" disabled={!allowed || $save.isPending}>{run ? "Save answers" : "Prepare run"}</Button>
</form>
