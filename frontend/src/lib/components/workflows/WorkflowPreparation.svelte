<script lang="ts">
  import { tick, untrack } from "svelte";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { workflowsApi, workflowRunKeys, type WorkflowRun, type WorkflowDefinition } from "$lib/api/workflows";
  import { Section, SaveState, Timestamp, DraftGuard } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";
  import { FormField } from "$lib/components/ui/form-field";
  import WorkflowRunForm from "./WorkflowRunForm.svelte";
  import WorkflowMarkdown from "./WorkflowMarkdown.svelte";
  import { displayValue, preparationErrors } from "./helpers";
  let { run, allowed = false }: { run: WorkflowRun; allowed?: boolean } = $props();
  const client = useQueryClient();
  const preparation = $derived(run.preparation!);
  const summary = $derived(preparation.summary);
  const editable = $derived(run.status === "pending");
  const definition = $derived({ document: run.document!, workflow_id: run.workflow_id, version: run.workflow_version } as WorkflowDefinition);
  let dirty = $state(false), notes = $state("");
  let errors = $state<Record<string, string>>({});
  let notesBaseline = $state("");
  $effect(() => { const saved = preparation.notes ?? ""; if (untrack(() => notes === notesBaseline)) notes = saved; notesBaseline = saved; });
  const notesDirty = $derived(notes !== notesBaseline);
  async function presentSummary() {
    errors = preparationErrors(run.document!, run.inputs, preparation.questions);
    if (Object.keys(errors).length) { await tick(); document.getElementById("workflow-preparation-errors")?.focus(); return; }
    $review.mutate("present_summary");
  }
  let focusRevision = $state<number | null>(null);
  $effect(() => {
    if (summary && focusRevision === summary.revision) {
      focusRevision = null;
      requestAnimationFrame(() => document.getElementById("execution-summary-heading")?.focus());
    }
  });
  let request = $state<{ fingerprint: string; id: string } | null>(null);
  const review = createMutation({ mutationFn: (action: "present_summary" | "confirm_summary") => {
    const body = { action, expected_run_version: run.version, ...(action === "present_summary" ? { notes } : { summary_revision: summary!.revision }) };
    const fingerprint = JSON.stringify(body);
    if (request?.fingerprint !== fingerprint) request = { fingerprint, id: crypto.randomUUID() };
    return workflowsApi.control(run.run_id, { ...body, client_request_id: request.id });
  }, onSuccess: async (_result, action) => { request = null; errors = {}; notesBaseline = notes; await client.invalidateQueries({ queryKey: workflowRunKeys.all }); if (action === "present_summary") focusRevision = _result.preparation?.summary?.revision ?? null; } });
</script>
<DraftGuard dirty={notesDirty} />
<Section title={editable ? "Prepare execution" : preparation.confirmation ? "Confirmed request" : "Request clarification"}>
  <ol aria-label="Workflow progress" class="mb-4 flex flex-wrap gap-x-4 gap-y-2 text-body-sm">
    <li aria-current={editable && preparation.phase === "clarifying" ? "step" : undefined}>1. Clarify questions</li>
    <li aria-current={editable && preparation.phase === "awaiting_confirmation" ? "step" : undefined}>2. Confirm summary</li>
    <li aria-current={run.status === "running" ? "step" : undefined}>3. Execute</li>
    <li aria-current={run.status === "completed" ? "step" : undefined}>4. Final report</li>
  </ol>
  {#if editable && preparation.phase === "clarifying"}<p class="mb-3 text-body">Answer the questions here or ask an agent to clarify them with you. Execution waits for your confirmation.</p>{/if}
  {#if Object.keys(errors).length}<div id="workflow-preparation-errors" tabindex="-1" role="alert" class="mb-3 rounded-md border border-destructive/40 bg-destructive-muted p-3 text-body-sm"><p class="font-semibold">Complete these answers before reviewing</p><ul class="mt-2 list-inside list-disc">{#each Object.entries(errors) as [id, error]}<li><a class="underline" href={`#${id}`}>{error}</a></li>{/each}</ul></div>{/if}
  {#if editable && run.document}
    {#if preparation.phase === "clarifying"}
      <WorkflowRunForm {run} {definition} allowed={allowed && !$review.isPending} {errors} bind:dirty />
    {:else}
      <details class="mb-4"><summary class="cursor-pointer py-2 text-body font-semibold">Correct answers or add a question</summary><div class="mt-3"><WorkflowRunForm {run} {definition} allowed={allowed && !$review.isPending} {errors} bind:dirty /></div></details>
    {/if}
  {/if}
  {#if summary}
    <div class="mt-4 space-y-4" aria-label="Execution summary">
      <h3 id="execution-summary-heading" tabindex="-1" class="text-body font-semibold">{summary.title}</h3>
      <WorkflowMarkdown text={summary.goal} />
      <dl class="space-y-3 text-body">
        {#each run.document?.inputs ?? [] as input (input.key)}
          <div><dt class="font-medium">{input.label}</dt><dd class="whitespace-pre-wrap break-words">{summary.inputs[input.key] === undefined ? "Not specified" : displayValue(summary.inputs[input.key])}</dd></div>
        {/each}
        {#each summary.questions as question (question.id)}<div><dt class="font-medium">{question.question}</dt><dd class="whitespace-pre-wrap break-words">{question.answer}</dd></div>{/each}
      </dl>
      {#if summary.notes}<WorkflowMarkdown text={summary.notes} />{/if}
      <div><h3 class="text-body font-semibold">Planned tasks</h3><ol class="mt-2 list-inside list-decimal space-y-2 text-body">{#each summary.tasks as task (task.id)}<li>{task.title}<details class="mt-1"><summary class="cursor-pointer py-1 text-body-sm">Review task instructions</summary><WorkflowMarkdown text={task.instructions} /><ul class="list-inside list-disc">{#each task.acceptance_criteria as criterion}<li>{criterion}</li>{/each}</ul></details></li>{/each}</ol></div>
    </div>
  {/if}
  {#if preparation.confirmation}
    <p role="status" class="mt-4 text-body">Confirmed <Timestamp value={preparation.confirmation.time} /> via {preparation.confirmation.channel === "web" ? "web review" : "conversation"}.{editable ? " Ready for an agent to start execution." : ""}</p>
    <p class="mt-1 whitespace-pre-wrap break-words text-body-sm text-muted-foreground">{preparation.confirmation.user_confirmation}</p>
  {:else if editable && allowed}
    {#if preparation.phase === "clarifying"}
      <div class="mt-4 space-y-3">
        <FormField id="preparation-notes" label="Additional agreements (optional)"><Textarea id="preparation-notes" rows={2} disabled={$review.isPending} bind:value={notes} /></FormField>
        <Button disabled={dirty || $review.isPending} onclick={presentSummary}>Review execution summary</Button>
      </div>
    {:else}
      <p class="mt-4 text-body">Review these details before confirming. Confirmation allows an agent to start execution.</p>
      <Button class="mt-3" disabled={dirty || $review.isPending} onclick={() => $review.mutate("confirm_summary")}>Confirm execution summary</Button>
    {/if}
    {#if dirty}<p role="status" class="mt-2 text-body-sm">Save your answers before reviewing or confirming the summary.</p>{/if}
  {/if}
  {#if $review.error || $review.isPending}<div class="mt-3"><SaveState pending={$review.isPending} error={$review.error} /><Button class="mt-2" variant="outline" onclick={() => client.invalidateQueries({ queryKey: workflowRunKeys.all })}>Reload current preparation</Button></div>{/if}
</Section>
