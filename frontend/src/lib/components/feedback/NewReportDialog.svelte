<script lang="ts">
  /** "New report" as a dialog: the five essentials up front, the rest under "More detail". */
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { FormField } from "$lib/components/ui/form-field";
  import { feedbackApi, feedbackKeys, feedbackPriorities, feedbackTypes, type FeedbackPriority, type FeedbackType } from "$lib/api/feedback";
  import { areaClass, controlClass } from "./report-model";

  type Props = { open: boolean; disabled?: boolean; onCreated: (id: string) => void };
  let { open = $bindable(), disabled = false, onCreated }: Props = $props();

  const qc = useQueryClient();
  let title = $state("");
  let description = $state("");
  let type = $state<FeedbackType>("bug");
  let priority = $state<FeedbackPriority>("normal");
  let component = $state("other");
  let reproduction = $state("");
  let expected = $state("");
  let actual = $state("");
  let versions = $state("");
  // The same draft keeps the same request id, so a retry after a dropped connection is replayed, not duplicated.
  let identity: { digest: string; id: string } | null = null;

  const submitMutation = createMutation({
    mutationFn: feedbackApi.submit,
    onSuccess: ({ feedback }) => {
      title = ""; description = ""; reproduction = ""; expected = ""; actual = ""; versions = ""; identity = null;
      open = false;
      void qc.invalidateQueries({ queryKey: feedbackKeys.all });
      toast.success("Report submitted");
      onCreated(feedback.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function submit() {
    const report = {
      type, title, description, component, priority,
      ...(reproduction.trim() ? { reproduction } : {}),
      ...(expected.trim() ? { expected } : {}),
      ...(actual.trim() ? { actual } : {}),
      ...(versions.trim() ? { versions } : {}),
    };
    const digest = JSON.stringify(report);
    if (!identity || identity.digest !== digest) identity = { digest, id: crypto.randomUUID() };
    $submitMutation.mutate({ ...report, client_request_id: identity.id });
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-xl">
    <form class="grid gap-3" onsubmit={(e) => { e.preventDefault(); submit(); }}>
      <Dialog.Header>
        <Dialog.Title>New report</Dialog.Title>
        <Dialog.Description>Describe a bug, a missing feature or an improvement for the orchestrator.</Dialog.Description>
      </Dialog.Header>
      <FormField id="nr-title" label="Title"><input id="nr-title" class={controlClass} bind:value={title} required maxlength="255" /></FormField>
      <div class="grid gap-3 sm:grid-cols-3">
        <FormField id="nr-type" label="Type">
          <select id="nr-type" class={controlClass} bind:value={type}>{#each feedbackTypes as value (value)}<option>{value}</option>{/each}</select>
        </FormField>
        <FormField id="nr-priority" label="Priority">
          <select id="nr-priority" class={controlClass} bind:value={priority}>{#each feedbackPriorities as value (value)}<option>{value}</option>{/each}</select>
        </FormField>
        <FormField id="nr-component" label="Component">
          <input id="nr-component" class={controlClass} bind:value={component} required maxlength="100" placeholder="MCP, wrapper, WebUI…" />
        </FormField>
      </div>
      <FormField id="nr-description" label="Description">
        <textarea id="nr-description" class={areaClass} bind:value={description} required maxlength="32000" rows="4"></textarea>
      </FormField>
      <details class="rounded-md border">
        <summary class="cursor-pointer select-none px-3 py-2 text-body-sm font-medium">More detail (optional)</summary>
        <div class="grid gap-3 border-t p-3">
          <FormField id="nr-repro" label="Reproduction steps"><textarea id="nr-repro" class={areaClass} bind:value={reproduction} maxlength="32000" rows="3"></textarea></FormField>
          <div class="grid gap-3 sm:grid-cols-2">
            <FormField id="nr-expected" label="Expected behavior"><textarea id="nr-expected" class={areaClass} bind:value={expected} maxlength="32000"></textarea></FormField>
            <FormField id="nr-actual" label="Actual behavior"><textarea id="nr-actual" class={areaClass} bind:value={actual} maxlength="32000"></textarea></FormField>
          </div>
          <FormField id="nr-versions" label="Versions"><input id="nr-versions" class={controlClass} bind:value={versions} maxlength="1000" /></FormField>
        </div>
      </details>
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (open = false)}>Cancel</Button>
        <Button type="submit" disabled={$submitMutation.isPending || disabled}>Submit report</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
