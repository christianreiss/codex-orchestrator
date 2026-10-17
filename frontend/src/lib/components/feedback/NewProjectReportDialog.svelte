<script lang="ts">
  /** "New report" for one project: a type, a title and a description. */
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { FormField } from "$lib/components/ui/form-field";
  import { ApiError } from "$lib/api/client";
  import { createFeedback, projectKeys } from "$lib/api/projects";
  import type { ProjectFeedbackType } from "$lib/api/types";
  import { areaClass, controlClass } from "./report-model";

  type Props = { slug: string; open: boolean; onCreated?: () => void };
  let { slug, open = $bindable(), onCreated }: Props = $props();

  const TYPES: ProjectFeedbackType[] = ["feature", "bug", "issue", "test", "note"];
  const qc = useQueryClient();
  let type = $state<ProjectFeedbackType>("feature");
  let title = $state("");
  let body = $state("");

  const mutation = createMutation({
    mutationFn: () => createFeedback(slug, { type, title: title.trim(), body: body.trim() }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not save report"),
    onSuccess: () => { toast.success("Report recorded"); type = "feature"; title = ""; body = ""; open = false; onCreated?.(); },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: projectKeys.feedback(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
    },
  });
  const canSubmit = $derived(title.trim().length > 0 && body.trim().length > 0);
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-lg">
    <form class="grid gap-3" onsubmit={(e) => { e.preventDefault(); $mutation.mutate(); }}>
      <Dialog.Header>
        <Dialog.Title>New report</Dialog.Title>
        <Dialog.Description>Track a feature request, issue, test result or note for this project.</Dialog.Description>
      </Dialog.Header>
      <div class="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <FormField id="pr-type" label="Type">
          <select id="pr-type" class={controlClass} bind:value={type}>{#each TYPES as value (value)}<option {value}>{value}</option>{/each}</select>
        </FormField>
        <FormField id="pr-title" label="Title"><input id="pr-title" class={controlClass} bind:value={title} placeholder="Short summary" /></FormField>
      </div>
      <FormField id="pr-body" label="Description"><textarea id="pr-body" class={areaClass} bind:value={body} rows="6" placeholder="Describe the report…"></textarea></FormField>
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (open = false)}>Cancel</Button>
        <Button type="submit" disabled={!canSubmit || $mutation.isPending}>{$mutation.isPending ? "Saving…" : "Save"}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
