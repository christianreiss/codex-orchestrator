<script lang="ts">
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { workflowsApi, workflowKeys, type WorkflowDefinition, type WorkflowDocument } from "$lib/api/workflows";
  import WorkflowVersionDiff from "./WorkflowVersionDiff.svelte";
  import { ApiError } from "$lib/api/client";
  import { Section, SaveState, DraftGuard } from "$lib/components/page";
  import { FormField } from "$lib/components/ui/form-field";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { newWorkflowDocument, moveTask, validateDraft } from "./helpers";
  let { definition, canManage = false, enabled = false, asNew = false }: { definition?: WorkflowDefinition; canManage?: boolean; enabled?: boolean; asNew?: boolean } = $props();
  let document = $state<WorkflowDocument>(newWorkflowDocument()), slug = $state(""), reason = $state(""), loaded = $state(false), baseline = $state(""), expected = $state(0);
  let errors = $state<Record<string, string>>({}), saved = $state(false), request = $state<{ fingerprint: string; id: string } | null>(null);
  const client = useQueryClient();
  let conflictHead = $state<WorkflowDefinition | null>(null), conflictError = $state<string | null>(null);
  const conflictDiff = $derived(conflictHead ? Object.keys(document).filter(key => JSON.stringify(document[key as keyof WorkflowDocument]) !== JSON.stringify(conflictHead!.document[key as keyof WorkflowDocument])).map(field => ({ field, before: conflictHead!.document[field as keyof WorkflowDocument], after: document[field as keyof WorkflowDocument] })) : []);
  $effect(() => {
    if (loaded) return;
    if (definition) { document = structuredClone(definition.document); slug = asNew ? "" : definition.slug; expected = definition.version; }
    baseline = JSON.stringify({ document, slug }); loaded = true;
  });
  const dirty = $derived(loaded && JSON.stringify({ document, slug }) !== baseline);
  const frozenGoal = $derived(!!definition && !asNew);
  const save = createMutation({
    mutationFn: async () => {
      const fingerprint = JSON.stringify({ document, slug, reason, expected });
      if (request?.fingerprint !== fingerprint) request = { fingerprint, id: crypto.randomUUID() };
      const input = { client_request_id: request!.id, document: $state.snapshot(document), reason };
      return definition && !asNew ? workflowsApi.revise(definition.workflow_id, { ...input, expected_workflow_version: expected }) : workflowsApi.create({ ...input, slug });
    },
    onSuccess: async (result) => {
      baseline = JSON.stringify({ document, slug }); expected = result.version; saved = true; request = null;
      await client.invalidateQueries({ queryKey: workflowKeys.all });
      if (!definition || asNew) await goto(`${base}/workflows/definitions/${encodeURIComponent(result.slug)}`);
    },
  });
  function submit(event: SubmitEvent) {
    event.preventDefault(); errors = validateDraft(document);
    if ((!slug.match(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) || slug.length > 64)) errors.slug = "Use lowercase letters, numbers and single hyphens.";
    if (!reason.trim()) errors.reason = "Explain why this version is being published.";
    if (!Object.keys(errors).length) $save.mutate();
    else window.requestAnimationFrame(() => window.document.getElementById("workflow-errors")?.focus());
  }
  function addTask() {
    const previous = document.tasks.at(-1);
    document.tasks.push({ id: `task-${crypto.randomUUID().slice(0, 8)}`, title: "", instructions: "", acceptance_criteria: [""], depends_on: previous ? [previous.id] : [], knowledge_ids: [] });
  }
  function removeTask(id: string) {
    document.tasks = document.tasks.filter(t => t.id !== id);
    for (const task of document.tasks) task.depends_on = task.depends_on.filter(dep => dep !== id);
  }
</script>
<DraftGuard {dirty} />
<form class="space-y-6" onsubmit={submit}>
  {#if Object.keys(errors).length}<div id="workflow-errors" tabindex="-1" role="alert" class="rounded-md border border-destructive/40 bg-destructive-muted p-3 text-body-sm"><p class="font-semibold">Correct these fields before publishing</p><ul class="mt-2 list-inside list-disc">{#each Object.entries(errors) as [id, error]}<li><a class="underline" href={`#${id}`}>{error}</a></li>{/each}</ul></div>{/if}
  {#if !canManage}<p class="text-body-sm">Your account can read this workflow. Editing requires workflows.manage.</p>{:else if !enabled}<p class="text-body-sm">Workflows are disabled. You can maintain definitions; new runs remain unavailable.</p>{/if}
  <fieldset disabled={!canManage || $save.isPending} class="min-w-0 space-y-6">
    <Section title="Identity" description="Publish a complete instruction. Changes save only when you publish a version.">
      <div class="grid gap-3 md:grid-cols-2">
        <FormField id="title" label="Title" required error={errors.title}><Input id="title" bind:value={document.title} aria-invalid={!!errors.title} aria-describedby={errors.title ? "title-error" : undefined} /></FormField>
        <FormField id="slug" label="Slug" required hint={frozenGoal ? "Permanent identity; cannot be changed." : "Lowercase words separated by hyphens."} error={errors.slug}><Input id="slug" bind:value={slug} readonly={frozenGoal} aria-describedby={errors.slug ? "slug-error" : "slug-hint"} /></FormField>
        <FormField id="summary" label="Summary" class="md:col-span-2"><Textarea id="summary" rows={2} bind:value={document.summary} /></FormField>
      </div>
    </Section>
    <Section title="Goal and success criteria" description={frozenGoal ? "The goal and its criteria are fixed. Create a new workflow for a different outcome." : "One goal, with evidence that can verify its achievement."}>
      <div class="space-y-3">
        <FormField id="goal" label="Goal" required error={errors.goal}><Textarea id="goal" rows={3} bind:value={document.goal.statement} readonly={frozenGoal} aria-describedby={errors.goal ? "goal-error" : undefined} /></FormField>
        <div id="criteria" class="space-y-2">
          {#each document.goal.success_criteria as criterion, i (criterion.id)}
            <div class="flex items-end gap-2"><FormField id={`criterion-${i}`} label={`Success criterion ${i + 1}`} required class="flex-1"><Input id={`criterion-${i}`} bind:value={criterion.text} readonly={frozenGoal} /></FormField>{#if !frozenGoal}<Button type="button" variant="ghost" aria-label={`Remove success criterion ${i + 1}`} disabled={document.goal.success_criteria.length === 1} onclick={() => document.goal.success_criteria = document.goal.success_criteria.filter(c => c.id !== criterion.id)}>Remove</Button>{/if}</div>
          {/each}
          {#if errors.criteria}<p class="text-body-sm text-destructive">{errors.criteria}</p>{/if}
          {#if !frozenGoal}<Button type="button" size="sm" variant="outline" onclick={() => document.goal.success_criteria.push({ id: `criterion-${crypto.randomUUID().slice(0, 8)}`, text: "" })}>Add success criterion</Button>{/if}
        </div>
      </div>
    </Section>
    <Section title="Inputs" description="Optional parameters become typed fields when preparing a run. Keep credentials in the Secrets Store.">
      <div class="space-y-4">
        {#each document.inputs as input, i (i)}<fieldset class="min-w-0 space-y-3 border-b pb-4"><legend class="text-body font-semibold">Input {i + 1}</legend>
          <div class="grid gap-3 sm:grid-cols-2"><FormField id={`input-key-${i}`} error={errors[`input-key-${i}`]} label="Key" required><Input id={`input-key-${i}`} aria-invalid={!!errors[`input-key-${i}`]} aria-describedby={errors[`input-key-${i}`] ? `input-key-${i}-error` : undefined} bind:value={input.key} /></FormField><FormField id={`input-label-${i}`} error={errors[`input-label-${i}`]} label="Label" required><Input id={`input-label-${i}`} aria-invalid={!!errors[`input-label-${i}`]} aria-describedby={errors[`input-label-${i}`] ? `input-label-${i}-error` : undefined} bind:value={input.label} /></FormField>
          <FormField id={`input-type-${i}`} label="Type"><select id={`input-type-${i}`} class="h-9 w-full rounded border border-input bg-background px-2 text-body" value={input.type} onchange={e => { input.type = e.currentTarget.value as typeof input.type; delete input.default; if (input.type === "enum") input.options ??= []; else delete input.options; }}><option>string</option><option>number</option><option>boolean</option><option>enum</option></select></FormField>
          <FormField id={`input-default-${i}`} error={errors[`input-default-${i}`]} label="Default (optional)">{#if input.type === "boolean"}<select id={`input-default-${i}`} class="h-9 w-full rounded border border-input bg-background px-2" value={input.default === undefined ? "" : String(input.default)} onchange={e => { if (e.currentTarget.value === "") delete input.default; else input.default = e.currentTarget.value === "true"; }}><option value="">No default</option><option value="true">True</option><option value="false">False</option></select>{:else}<Input id={`input-default-${i}`} aria-invalid={!!errors[`input-default-${i}`]} aria-describedby={errors[`input-default-${i}`] ? `input-default-${i}-error` : undefined} type={input.type === "number" ? "number" : "text"} value={String(input.default ?? "")} oninput={e => { if (!e.currentTarget.value) delete input.default; else input.default = input.type === "number" ? Number(e.currentTarget.value) : e.currentTarget.value; }} />{/if}</FormField>
          {#if input.type === "enum"}<FormField id={`input-options-${i}`} error={errors[`input-options-${i}`]} label="Choices, one per line" required><Textarea id={`input-options-${i}`} aria-invalid={!!errors[`input-options-${i}`]} aria-describedby={errors[`input-options-${i}`] ? `input-options-${i}-error` : undefined} value={input.options?.join("\n") ?? ""} oninput={e => input.options = e.currentTarget.value.split("\n")} /></FormField>{/if}
          <FormField id={`input-description-${i}`} label="Description (optional)"><Input id={`input-description-${i}`} bind:value={input.description} /></FormField></div>
          <label class="flex min-h-9 items-center gap-2 text-body"><input type="checkbox" bind:checked={input.required} />Required for every run</label>
          <Button type="button" size="sm" variant="ghost" onclick={() => document.inputs.splice(i, 1)}>Remove input {i + 1}</Button>
        </fieldset>{/each}
        <Button type="button" variant="outline" size="sm" onclick={() => document.inputs.push({ key: "", label: "", type: "string", required: false })}>Add input</Button>
      </div>
    </Section>
    <Section id="tasks" title="Tasks" description="New tasks follow the previous task. Clear dependencies to allow independent work.">
      {#if errors.tasks}<p class="mb-3 text-body-sm text-destructive">{errors.tasks}</p>{/if}
      <ol class="space-y-6">{#each document.tasks as task, i (task.id)}<li id={`task-${task.id}`} class="space-y-3 border-b pb-4">
        <div class="flex flex-wrap items-center justify-between gap-2"><h3 class="text-body font-semibold">Task {i + 1}</h3><div class="flex flex-wrap gap-1"><Button type="button" variant="ghost" size="sm" disabled={i === 0} aria-label={`Move task ${i + 1} up`} onclick={() => document = moveTask(document, i, -1)}>Move up</Button><Button type="button" variant="ghost" size="sm" disabled={i === document.tasks.length - 1} aria-label={`Move task ${i + 1} down`} onclick={() => document = moveTask(document, i, 1)}>Move down</Button><Button type="button" variant="ghost" size="sm" disabled={document.tasks.length === 1} aria-label={`Remove task ${i + 1}`} onclick={() => removeTask(task.id)}>Remove</Button></div></div>
        {#if errors[`task-${task.id}`]}<p class="text-body-sm text-destructive">{errors[`task-${task.id}`]}</p>{/if}
        <FormField id={`task-title-${i}`} label={`Task ${i + 1} title`} required><Input id={`task-title-${i}`} bind:value={task.title} /></FormField>
        <FormField id={`task-instructions-${i}`} label={`Task ${i + 1} instructions`} required><Textarea id={`task-instructions-${i}`} rows={4} bind:value={task.instructions} /></FormField>
        <FormField id={`task-acceptance-${i}`} label={`Task ${i + 1} acceptance criteria, one per line`} required><Textarea id={`task-acceptance-${i}`} rows={2} value={task.acceptance_criteria.join("\n")} oninput={e => task.acceptance_criteria = e.currentTarget.value.split("\n")} /></FormField>
        <FormField id={`task-location-${i}`} label="Execution location or access (optional)" hint="Describes needed access; grants no permission."><Input id={`task-location-${i}`} bind:value={task.execution_hint} aria-describedby={`task-location-${i}-hint`} /></FormField>
        <fieldset class="min-w-0"><legend class="mb-1 text-body font-medium">Dependencies for task {i + 1}</legend>{#each document.tasks.filter(t => t.id !== task.id) as other}<label class="flex min-h-9 items-center gap-2 text-body"><input type="checkbox" value={other.id} bind:group={task.depends_on} />{other.title || other.id}</label>{/each}{#if document.tasks.length === 1}<p class="text-body-sm text-muted-foreground">No other tasks.</p>{/if}</fieldset>
        {#if document.knowledge.length}<fieldset class="min-w-0"><legend class="mb-1 text-body font-medium">Knowledge for task {i + 1}</legend>{#each document.knowledge as source}<label class="flex min-h-9 items-center gap-2 text-body"><input type="checkbox" value={source.id} bind:group={task.knowledge_ids} />{source.title || source.id}</label>{/each}</fieldset>{/if}
      </li>{/each}</ol>
      <Button type="button" class="mt-3" variant="outline" onclick={addTask}>Add task</Button>
    </Section>
    <Section title="Knowledge" description="Optional inline notes or references. Referenced content is read by agents with their existing permissions.">
      <div class="space-y-4">{#each document.knowledge as source, i (source.id)}<fieldset class="min-w-0 space-y-3 border-b pb-4"><legend class="text-body font-semibold">Source {i + 1}</legend>
        <FormField id={`source-title-${i}`} error={errors[`source-title-${i}`]} label={`Source ${i + 1} title`} required><Input id={`source-title-${i}`} aria-invalid={!!errors[`source-title-${i}`]} aria-describedby={errors[`source-title-${i}`] ? `source-title-${i}-error` : undefined} bind:value={source.title} /></FormField>
        <FormField id={`source-kind-${i}`} label="Source type"><select id={`source-kind-${i}`} class="h-9 w-full rounded border border-input bg-background px-2" value={source.reference ? "reference" : "inline"} onchange={e => { if (e.currentTarget.value === "reference") { source.reference = { uri: "" }; delete source.inline; } else { source.inline = ""; delete source.reference; } }}><option value="inline">Inline notes</option><option value="reference">Reference</option></select></FormField>
        {#if source.reference}<FormField id={`source-uri-${i}`} error={errors[`source-uri-${i}`]} label="Reference URI" required hint="shared://, project://, skill://, https:// or http://"><Input id={`source-uri-${i}`} aria-invalid={!!errors[`source-uri-${i}`]} aria-describedby={errors[`source-uri-${i}`] ? `source-uri-${i}-error` : `source-uri-${i}-hint`} bind:value={source.reference.uri} /></FormField><FormField id={`source-hint-${i}`} label="Reading hint (optional)"><Input id={`source-hint-${i}`} bind:value={source.reference.read_hint} /></FormField>{:else}<FormField id={`source-inline-${i}`} label="Notes (Markdown)"><Textarea id={`source-inline-${i}`} rows={4} bind:value={source.inline} /></FormField>{/if}
        <Button type="button" variant="ghost" size="sm" onclick={() => { document.knowledge = document.knowledge.filter(k => k.id !== source.id); for (const task of document.tasks) task.knowledge_ids = task.knowledge_ids.filter(k => k !== source.id); }}>Remove source {i + 1}</Button>
      </fieldset>{/each}<Button type="button" variant="outline" size="sm" onclick={() => document.knowledge.push({ id: `knowledge-${crypto.randomUUID().slice(0, 8)}`, title: "", inline: "" })}>Add knowledge</Button></div>
    </Section>
    <Section title="Publish version"><FormField id="reason" label="Change reason" required error={errors.reason}><Textarea id="reason" rows={2} bind:value={reason} aria-describedby={errors.reason ? "reason-error" : undefined} /></FormField></Section>
  </fieldset>
  <SaveState pending={$save.isPending} error={$save.error} {dirty} {saved} />
  {#if $save.error instanceof ApiError && $save.error.status === 409}
    <div class="space-y-3"><p class="text-body-sm">The current version changed. Your draft is kept. Load the head to compare it with your draft before publishing again.</p><Button type="button" variant="outline" onclick={async () => { if (definition) { try { conflictHead = await workflowsApi.get(definition.workflow_id); conflictError = null; } catch (error) { conflictError = error instanceof Error ? error.message : "Could not load current head."; } } }}>Load current head for comparison</Button>{#if conflictError}<p role="alert" class="text-body-sm text-destructive">{conflictError} Your draft is retained.</p>{/if}{#if conflictHead}<p class="text-body-sm">Current head: version {conflictHead.version}. Previous below is the server value; Published is your proposed draft.</p><WorkflowVersionDiff diff={conflictDiff} /><Button type="button" variant="outline" onclick={() => { expected = conflictHead!.version; $save.reset(); }}>I reviewed the comparison; use version {conflictHead.version} as base</Button>{/if}</div>
  {/if}
  <div class="flex flex-wrap gap-2"><Button type="submit" disabled={!canManage || $save.isPending}>{$save.isPending ? "Publishing…" : frozenGoal ? "Publish new version" : "Create workflow"}</Button>{#if frozenGoal}<Button type="button" variant="outline" href={`${base}/workflows/new?from=${encodeURIComponent(definition!.slug)}`}>Create as new workflow</Button>{/if}</div>
</form>
