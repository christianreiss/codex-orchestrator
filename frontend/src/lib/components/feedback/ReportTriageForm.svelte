<script lang="ts">
  /**
   * Triage and outcome for one report: retitle, retype, change status, add
   * evidence, record the verified fix and (separately) its deployment.
   * Updates are versioned: a concurrent change keeps the draft and offers
   * "Load current version". Force-release and delete sit last.
   */
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import { FormField } from "$lib/components/ui/form-field";
  import { Section } from "$lib/components/page";
  import {
    feedbackApi, feedbackKeys, feedbackPriorities, feedbackStatuses, feedbackTypes,
    type FeedbackItem, type FeedbackPriority, type FeedbackType,
  } from "$lib/api/feedback";
  import { areaClass, controlClass, humanize } from "./report-model";

  type Props = { item: FeedbackItem; onDeleted: () => void };
  let { item, onDeleted }: Props = $props();

  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: feedbackKeys.all });

  let editingId = $state("");
  let draftVersion = $state(0);
  let editTitle = $state("");
  let editType = $state<FeedbackType>("bug");
  let editPriority = $state<FeedbackPriority>("normal");
  let editComponent = $state("");
  let nextStatus = $state("");
  let note = $state("");
  let reason = $state("");
  let resolution = $state("");
  let fixRef = $state("");
  let verification = $state("");
  let duplicateOf = $state("");
  let deployment = $state("");
  let deploymentRef = $state("");
  let confirmDelete = $state(false);

  function loadVersion(row: FeedbackItem) {
    editingId = row.id; draftVersion = row.version; editTitle = row.title;
    editType = row.type; editPriority = row.priority; editComponent = row.component;
  }
  $effect(() => {
    if (item.id !== editingId) {
      loadVersion(item);
      nextStatus = ""; note = ""; reason = ""; resolution = ""; fixRef = ""; verification = ""; duplicateOf = ""; deployment = ""; deploymentRef = "";
    }
  });

  const updateMutation = createMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => feedbackApi.update(id, body),
    onSuccess: ({ feedback }) => {
      loadVersion(feedback); nextStatus = ""; note = ""; reason = ""; deployment = ""; deploymentRef = "";
      void refresh(); toast.success("Report updated");
    },
    onError: (e: Error) => { toast.error(e.message); void refresh(); },
  });
  function update() {
    const body: Record<string, unknown> = {
      expected_version: draftVersion, title: editTitle, type: editType, priority: editPriority, component: editComponent,
    };
    if (nextStatus) body.status = nextStatus;
    if (note.trim()) body.note = note;
    if (reason.trim() && (nextStatus === "blocked" || nextStatus === "dismissed")) body.reason = reason;
    if (nextStatus === "resolved") Object.assign(body, { resolution, fix_ref: fixRef, verification });
    if (nextStatus === "duplicate") body.duplicate_of = duplicateOf;
    if (deployment) body.deployment = deployment;
    if (deploymentRef.trim()) body.deployment_ref = deploymentRef;
    $updateMutation.mutate({ id: item.id, body });
  }

  const releaseMutation = createMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => feedbackApi.forceRelease(id, reason),
    onSuccess: ({ feedback }) => { loadVersion(feedback); reason = ""; void refresh(); toast.success("Claim released; previous token is invalid"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const closed = ["resolved", "dismissed", "duplicate"];
  const deleteMutation = createMutation({
    mutationFn: (id: string) => feedbackApi.remove(id),
    onSuccess: ({ deleted, cascaded_duplicates }) => {
      confirmDelete = false;
      void refresh();
      toast.success(cascaded_duplicates ? `Deleted ${deleted} reports including ${cascaded_duplicates} duplicates` : "Report deleted");
      onDeleted();
    },
    onError: (e: Error) => { toast.error(e.message); void refresh(); },
  });
  const canDelete = $derived(closed.includes(item.status) && !item.claim_owner);
</script>

<Section title="Triage and outcome">
  <form class="grid gap-3 sm:grid-cols-2" onsubmit={(e) => { e.preventDefault(); update(); }}>
    {#if item.version !== draftVersion}
      <div role="alert" class="rounded-md border border-warning/50 bg-warning-muted p-3 text-body-sm sm:col-span-2">
        This report changed while you were editing. Your draft is retained.
        <Button type="button" variant="outline" size="sm" onclick={() => loadVersion(item)}>Load current version</Button>
      </div>
    {/if}
    <FormField id="tr-title" label="Title"><input id="tr-title" class={controlClass} bind:value={editTitle} required maxlength="255" /></FormField>
    <FormField id="tr-component" label="Component"><input id="tr-component" class={controlClass} bind:value={editComponent} required maxlength="100" /></FormField>
    <FormField id="tr-type" label="Type">
      <select id="tr-type" class={controlClass} bind:value={editType}>{#each feedbackTypes as value (value)}<option>{value}</option>{/each}</select>
    </FormField>
    <FormField id="tr-priority" label="Priority">
      <select id="tr-priority" class={controlClass} bind:value={editPriority}>{#each feedbackPriorities as value (value)}<option>{value}</option>{/each}</select>
    </FormField>
    <FormField id="tr-status" label="Report status" class="sm:col-span-2">
      <select id="tr-status" class={controlClass} bind:value={nextStatus}>
        <option value="">Keep current status</option>
        {#each feedbackStatuses.filter((s) => s !== "in_progress") as value (value)}<option value={value}>{value}</option>{/each}
      </select>
    </FormField>
    <FormField id="tr-note" label="Add evidence or comment" class="sm:col-span-2">
      <textarea id="tr-note" class={areaClass} bind:value={note} maxlength="32000" rows="3"></textarea>
    </FormField>
    {#if nextStatus === "blocked" || nextStatus === "dismissed"}
      <FormField id="tr-reason" label="Reason" class="sm:col-span-2"><input id="tr-reason" class={controlClass} bind:value={reason} required maxlength="1000" /></FormField>
    {/if}
    {#if nextStatus === "resolved"}
      <p class="text-caption text-muted-foreground sm:col-span-2">Resolved means a verified fix. Production deployment is recorded separately.</p>
      <FormField id="tr-resolution" label="Resolution" class="sm:col-span-2"><textarea id="tr-resolution" class={areaClass} bind:value={resolution} required maxlength="32000"></textarea></FormField>
      <FormField id="tr-fixref" label="Fix reference" class="sm:col-span-2"><input id="tr-fixref" class={controlClass} bind:value={fixRef} required maxlength="1000" placeholder="Commit, PR or durable patch reference" /></FormField>
      <FormField id="tr-verification" label="Verification" class="sm:col-span-2"><textarea id="tr-verification" class={areaClass} bind:value={verification} required maxlength="32000" placeholder="Checks performed and their results"></textarea></FormField>
    {/if}
    {#if nextStatus === "duplicate"}
      <FormField id="tr-dup" label="Canonical report ID" class="sm:col-span-2"><input id="tr-dup" class={controlClass} bind:value={duplicateOf} required /></FormField>
    {/if}
    <FormField id="tr-deployment" label="Deployment">
      <select id="tr-deployment" class={controlClass} bind:value={deployment}>
        <option value="">Keep current deployment</option>
        <option value="unknown">Unknown</option>
        <option value="not_deployed">Not deployed</option>
        <option value="deployed">Deployed</option>
      </select>
    </FormField>
    <FormField id="tr-depref" label="Deployment reference"><input id="tr-depref" class={controlClass} bind:value={deploymentRef} required={deployment === "deployed"} maxlength="1000" /></FormField>
    <div class="sm:col-span-2">
      <Button type="submit" disabled={$updateMutation.isPending || draftVersion !== item.version}>Save update</Button>
    </div>
  </form>
</Section>

{#if item.claim_owner}
  <form class="mt-4 flex flex-wrap items-end gap-2 border-t pt-4" onsubmit={(e) => { e.preventDefault(); $releaseMutation.mutate({ id: item.id, reason }); }}>
    <FormField id="tr-release" label="Release reason" class="min-w-0 flex-1"><input id="tr-release" class={controlClass} bind:value={reason} required maxlength="1000" /></FormField>
    <Button type="submit" variant="outline" disabled={$releaseMutation.isPending}>Force release</Button>
  </form>
{/if}

{#if canDelete}
  <Section title="Delete report" danger class="mt-4">
    <div class="flex flex-wrap items-center gap-2">
      <p class="min-w-0 flex-1 text-caption text-muted-foreground">Closed reports can be deleted with their history. Duplicates of this report are deleted too.</p>
      <Button variant="destructive" disabled={$deleteMutation.isPending} onclick={() => (confirmDelete = true)}>Delete report</Button>
    </div>
  </Section>
{/if}

<ConfirmDialog
  bind:open={confirmDelete}
  title="Delete this report?"
  description="Permanently delete this closed report, its history and any duplicates of it? This cannot be undone."
  confirmLabel="Delete report"
  destructive
  busy={$deleteMutation.isPending}
  onConfirm={() => $deleteMutation.mutate(item.id)}
/>
