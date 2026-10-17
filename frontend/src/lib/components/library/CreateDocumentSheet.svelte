<script lang="ts">
  /** The "New …" form for any named Library document. Opens the editor on success. */
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { toast } from "svelte-sonner";
  import { ApiError } from "$lib/api/client";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { FormField } from "$lib/components/ui/form-field";
  import * as Sheet from "$lib/components/ui/sheet";
  import { libraryDocHref, type CreateInput, type DocListConfig } from "./library-types";

  let { open = $bindable(), config }: { open: boolean; config: DocListConfig } = $props();

  const qc = useQueryClient();
  let slug = $state("");
  let name = $state("");
  let description = $state("");

  const create = createMutation({
    mutationFn: (input: CreateInput) => config.create(input),
    onSuccess: (data, input) => {
      toast.success(`${config.singular[0]!.toUpperCase()}${config.singular.slice(1)} "${input.slug}" created`);
      void qc.invalidateQueries({ queryKey: [...config.invalidateKey] });
      open = false;
      slug = name = description = "";
      void goto(`${base}${libraryDocHref(config.id, data.slug ?? input.slug)}`);
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : `Failed to create ${config.singular}`),
  });

  function submit() {
    const value = slug.trim();
    if (!value) return void toast.error("Slug is required");
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value)) return void toast.error("Slug must be alphanumeric with . _ - separators");
    $create.mutate({ slug: value, name: name.trim() || value, description: description.trim() });
  }
</script>

<Sheet.Root bind:open>
  <Sheet.Content side="right" class="w-full sm:max-w-md">
    <Sheet.Header>
      <Sheet.Title>New {config.singular}</Sheet.Title>
      <Sheet.Description>Creates an empty {config.singular} and opens it in the editor.</Sheet.Description>
    </Sheet.Header>
    <form class="mt-6 space-y-4" onsubmit={(event) => { event.preventDefault(); submit(); }}>
      <FormField id="new-doc-slug" label="Slug" hint="Letters, numbers, hyphens, periods or underscores.">
        <Input id="new-doc-slug" placeholder={config.slugPlaceholder} bind:value={slug} autocomplete="off" aria-describedby="new-doc-slug-hint" />
      </FormField>
      {#if config.hasDisplayName}
        <FormField id="new-doc-name" label="Display name">
          <Input id="new-doc-name" bind:value={name} />
        </FormField>
      {/if}
      <FormField id="new-doc-description" label="Description">
        <Textarea id="new-doc-description" rows={4} placeholder={config.descriptionPlaceholder} bind:value={description} />
      </FormField>
      <Sheet.Footer class="flex justify-end gap-2">
        <Button type="button" variant="outline" onclick={() => (open = false)}>Cancel</Button>
        <Button type="submit" disabled={$create.isPending}>{$create.isPending ? "Creating…" : `Create ${config.singular}`}</Button>
      </Sheet.Footer>
    </form>
  </Sheet.Content>
</Sheet.Root>
