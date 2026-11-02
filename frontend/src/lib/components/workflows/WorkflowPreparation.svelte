<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
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
  const stage = $derived(["completed", "evaluating"].includes(run.status) ? 3 : run.status !== "pending" || preparation.confirmation ? 2 : preparation.phase === "awaiting_confirmation" ? 1 : 0);
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
  <div class="max-w-3xl space-y-6">
  <ol aria-label="Workflow progress" class="grid grid-cols-2 gap-3 border-b pb-6 sm:grid-cols-4">
    {#each ["Clarify questions", "Confirm summary", editable && preparation.confirmation ? "Ready to start" : "Execute", "Final report"] as label, i}
      <li aria-current={stage === i ? "step" : undefined} class="flex items-center gap-2 text-body-sm">
        <span class={["flex size-8 shrink-0 items-center justify-center rounded-full border", stage === i ? "border-primary bg-primary text-primary-foreground" : "border-border bg-muted text-muted-foreground"]}>
          {#if i < stage}<Check class="size-4" aria-hidden="true" /><span class="sr-only">Complete:</span>{:else}<span aria-hidden="true">{i + 1}</span>{/if}
        </span><span class={stage === i ? "font-semibold" : "text-muted-foreground"}>{label}</span>
      </li>
    {/each}
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
      <dl class="divide-y text-body [&>div]:py-3 [&_dd]:mt-1 [&_dt]:text-body-sm [&_dt]:text-muted-foreground">
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
    {#if editable && preparation.confirmation.start_notification?.status === "queued"}
      <p role="status" class="text-body">Start message queued for the coordinator. Execution has not started yet.</p>
    {:else if editable && preparation.confirmation.start_notification?.status === "not_queued"}
      <p role="status" class="text-body">No coordinator is assigned, so no start message was sent. Give the agent assignment below to an agent to continue.</p>
    {/if}
    <p class="mt-1 whitespace-pre-wrap break-words text-body-sm text-muted-foreground">{preparation.confirmation.user_confirmation}</p>
  {:else if editable && allowed}
    {#if preparation.phase === "clarifying"}
      <div class="space-y-4 border-t pt-6">
        <h3 class="text-body font-semibold">Additional agreements</h3>
        <FormField id="preparation-notes" label="Additional agreements (optional)"><Textarea id="preparation-notes" rows={2} disabled={$review.isPending} bind:value={notes} /></FormField>
        <Button disabled={dirty || $review.isPending} onclick={presentSummary}>Review execution summary</Button>
      </div>
    {:else}
      <p class="mt-4 text-body">Review these details before confirming. Confirmation allows execution and queues a start message for the assigned coordinator. Without a coordinator, the confirmed request waits for an agent.</p>
      <Button class="mt-3" disabled={dirty || $review.isPending} onclick={() => $review.mutate("confirm_summary")}>Confirm execution summary</Button>
    {/if}
    {#if dirty}<p role="status" class="mt-2 text-body-sm">Save your answers before reviewing or confirming the summary.</p>{/if}
  {/if}
  {#if $review.error || $review.isPending}<div class="mt-3"><SaveState pending={$review.isPending} error={$review.error} /><Button class="mt-2" variant="outline" onclick={() => client.invalidateQueries({ queryKey: workflowRunKeys.all })}>Reload current preparation</Button></div>{/if}
  </div>
</Section>
