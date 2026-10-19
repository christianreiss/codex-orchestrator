<script lang="ts">
  /** "New role": creates the role with an unpublished draft and opens it. */
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { ApiError } from "$lib/api/client";
  import { rolesApi, rolesKeys } from "$lib/api/roles";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { FormField } from "$lib/components/ui/form-field";
  import * as Sheet from "$lib/components/ui/sheet";
  import { starterManifest } from "./role-model";

  let { open = $bindable(), onCreated }: { open: boolean; onCreated: (slug: string) => void } = $props();

  const qc = useQueryClient();
  let slug = $state("");
  let name = $state("");
  let summary = $state("");
  let errors = $state<Record<string, string>>({});

  const create = createMutation({
    mutationFn: async () => {
      const value = slug.trim().toLowerCase();
      await rolesApi.create({ slug: value, display_name: name.trim(), summary: summary.trim() });
      await rolesApi.saveDraft(value, { manifest: starterManifest(value, summary.trim()), files: [] });
      return value;
    },
    onSuccess: (value) => {
      toast.success(`Role "${value}" created as a draft`);
      void qc.invalidateQueries({ queryKey: [...rolesKeys.all] });
      open = false;
      slug = name = summary = "";
      onCreated(value);
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Could not create the role"),
  });

  function submit() {
    const next: Record<string, string> = {};
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug.trim().toLowerCase())) next.slug = "Use 1–64 lowercase letters, digits, dots, underscores or hyphens.";
    if (!name.trim()) next.name = "Give the role a name.";
    if (!summary.trim()) next.summary = "Describe what the role is responsible for.";
    errors = next;
    if (!Object.keys(next).length) $create.mutate();
  }
</script>

<Sheet.Root bind:open>
  <Sheet.Content side="right" class="w-full sm:max-w-md">
    <Sheet.Header>
      <Sheet.Title>New role</Sheet.Title>
      <Sheet.Description>Creates the role with an unpublished draft. Agents can activate it once you publish version 1.</Sheet.Description>
    </Sheet.Header>
    <form class="mt-6 space-y-4" onsubmit={(event) => { event.preventDefault(); submit(); }}>
      <FormField id="new-role-slug" label="Slug" hint="What agents ask for, e.g. design." error={errors.slug}>
        <Input id="new-role-slug" placeholder="design" bind:value={slug} autocomplete="off" aria-describedby="new-role-slug-hint" aria-invalid={!!errors.slug} />
      </FormField>
      <FormField id="new-role-name" label="Name" error={errors.name}>
        <Input id="new-role-name" placeholder="Design agent" bind:value={name} aria-invalid={!!errors.name} />
      </FormField>
      <FormField id="new-role-summary" label="Summary" hint="Shown in the catalog agents choose from." error={errors.summary}>
        <Textarea id="new-role-summary" rows={4} bind:value={summary} maxlength={600} aria-invalid={!!errors.summary} />
      </FormField>
      <Sheet.Footer class="flex justify-end gap-2">
        <Button type="button" variant="outline" onclick={() => (open = false)}>Cancel</Button>
        <Button type="submit" disabled={$create.isPending}>{$create.isPending ? "Creating…" : "Create role"}</Button>
      </Sheet.Footer>
    </form>
  </Sheet.Content>
</Sheet.Root>
