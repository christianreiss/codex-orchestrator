<script lang="ts">
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import DraftGuard from "$lib/components/page/DraftGuard.svelte";
  import { untrack } from "svelte";
  import { toast } from "svelte-sonner";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import { secretsApi, secretQueryKeys } from "$lib/api/secrets";
  import type { AdminSecret, AdminSecretResponse, CreateSecretPayload } from "$lib/api/types";

  type Props = {
    open: boolean;
    /** When set, the dialog edits that secret instead of creating one. */
    editing?: AdminSecret | null;
    onOpenChange?: (open: boolean) => void;
  };
  let { open = $bindable(false), editing = null, onOpenChange }: Props = $props();

  const qc = useQueryClient();

  let slug = $state("");
  let name = $state("");
  let description = $state("");
  let value = $state("");
  let tags = $state("");

  const isEdit = $derived(editing !== null);
  const snapshot = () => JSON.stringify([slug, name, description, value, tags]);
  let baseline = $state("");
  let error = $state("");
  let fieldErrors = $state<Record<string, string>>({});
  const dirty = $derived(open && snapshot() !== baseline);

  // Re-seed whenever the dialog opens, so a cancelled edit cannot bleed into the
  // next create.
  $effect(() => {
    if (!open) return;
    slug = editing?.slug ?? "";
    name = editing?.name ?? "";
    description = editing?.description ?? "";
    value = "";
    tags = (editing?.tags ?? []).join(", ");
    baseline = untrack(snapshot);
    error = ""; fieldErrors = {};
  });

  function parseTags(raw: string): string[] {
    return raw
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");
  }

  const saveMut = createMutation<AdminSecretResponse, Error, void>({
    mutationFn: async () => {
      if (editing) {
        // Only send a value when one was typed: an empty box means "leave the
        // stored credential alone", not "clear it".
        return await secretsApi.update(editing.id, {
          name: name.trim(),
          description: description.trim() || null,
          tags: parseTags(tags),
          ...(value ? { value } : {}),
        });
      }
      const payload: CreateSecretPayload = {
        slug: slug.trim().toLowerCase(),
        name: name.trim(),
        value,
        description: description.trim() || null,
        tags: parseTags(tags),
      };
      return await secretsApi.create(payload);
    },
    onSuccess: (data) => {
      const rotated = (data as { rotated?: boolean }).rotated;
      toast.success(isEdit ? "Secret updated" : "Secret created", {
        description: isEdit
          ? rotated
            ? "The value changed, so agents get the new one on their next read."
            : "Metadata updated; the stored value is unchanged."
          : `Agents can fetch it with secret_get ${data.secret.slug}.`,
      });
      void qc.invalidateQueries({ queryKey: secretQueryKeys.list() });
      void qc.invalidateQueries({ queryKey: secretQueryKeys.state() });
      // onSuccess still runs while the mutation is pending; the user-dismiss
      // guard in close() must not block completion of a successful save.
      open = false;
      onOpenChange?.(false);
    },
    onError: (err) => {
      error = err.message;
      toast.error(isEdit ? "Could not update the secret" : "Could not create the secret", {
        description: err.message,
      });
    },
  });

  function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    if ($saveMut.isPending) return;
    error = ""; fieldErrors = {};
    if (!name.trim()) {
      fieldErrors.name = "Name is required";
      toast.error("Name is required");
      return;
    }
    if (!isEdit) {
      if (!slug.trim()) {
        fieldErrors.slug = "Slug is required";
        toast.error("Slug is required", {
          description: "It is the key agents use, and it cannot be changed later.",
        });
        return;
      }
      if (!value) {
        fieldErrors.value = "Value is required";
        toast.error("Value is required");
        return;
      }
    }
    $saveMut.mutate();
  }

  function close() {
    if ($saveMut.isPending || (dirty && !window.confirm("Discard the unsaved secret changes?"))) return;
    open = false;
    onOpenChange?.(false);
  }

  function handleDialogOpenChange(next: boolean) {
    if (!next && ($saveMut.isPending || (dirty && !window.confirm("Discard the unsaved secret changes?")))) {
      open = true;
      return;
    }
    open = next;
    onOpenChange?.(next);
  }
</script>

<DraftGuard {dirty} />
<Dialog.Root bind:open={() => open, handleDialogOpenChange}>
  <Dialog.Content>
    <form onsubmit={handleSubmit}>
      <Dialog.Header>
        <Dialog.Title>{isEdit ? "Edit secret" : "New secret"}</Dialog.Title>
        <Dialog.Description>
          {isEdit
            ? "Leave the value blank to keep the stored credential and only change its metadata."
            : "A working credential agents fetch over MCP — an API token, database password, or service account."}
        </Dialog.Description>
      </Dialog.Header>

      <fieldset disabled={$saveMut.isPending} class="grid gap-4 py-4">
        <div class="grid gap-2">
          <Label for="secret-slug">Slug</Label>
          <Input
            id="secret-slug"
            aria-invalid={!!fieldErrors.slug}
            aria-describedby={fieldErrors.slug ? "secret-slug-error" : undefined}
            bind:value={slug}
            placeholder="e.g. powerdns-api-key"
            required={!isEdit}
            disabled={isEdit}
            autocomplete="off"
          />
          {#if fieldErrors.slug}<p id="secret-slug-error" role="alert" class="text-body-sm text-destructive">{fieldErrors.slug}</p>{/if}
          <p class="text-caption text-muted-foreground">
            {isEdit
              ? "Immutable — it is the key agents already hold. Delete and recreate to rename."
              : "Lowercase; letters, digits, dots, hyphens, underscores and colons. Cannot be changed later."}
          </p>
        </div>

        <div class="grid gap-2">
          <Label for="secret-name">Name</Label>
          <Input
            id="secret-name"
            aria-invalid={!!fieldErrors.name}
            aria-describedby={fieldErrors.name ? "secret-name-error" : undefined}
            bind:value={name}
            placeholder="e.g. PowerDNS Authoritative API key"
            required
            autocomplete="off"
          />
          {#if fieldErrors.name}<p id="secret-name-error" role="alert" class="text-body-sm text-destructive">{fieldErrors.name}</p>{/if}
        </div>

        <div class="grid gap-2">
          <Label for="secret-description">What is it for?</Label>
          <Textarea
            id="secret-description"
            bind:value={description}
            rows={3}
            placeholder="Which system it opens, and when an agent should reach for it."
          />
          <p class="text-caption text-muted-foreground">
            This is what an agent reads to decide whether this is the credential it needs — the
            only thing distinguishing it from every other entry. Worth a sentence.
          </p>
        </div>

        <div class="grid gap-2">
          <Label for="secret-value">Value</Label>
          <Input
            id="secret-value"
            aria-invalid={!!fieldErrors.value}
            aria-describedby={fieldErrors.value ? "secret-value-error" : undefined}
            type="password"
            bind:value
            required={!isEdit}
            autocomplete="new-password"
            placeholder={isEdit ? "Leave blank to keep the current value" : ""}
          />
          {#if fieldErrors.value}<p id="secret-value-error" role="alert" class="text-body-sm text-destructive">{fieldErrors.value}</p>{/if}
        </div>

        <div class="grid gap-2">
          <Label for="secret-tags">Tags</Label>
          <Input
            id="secret-tags"
            bind:value={tags}
            placeholder="comma separated, e.g. dns, infrastructure"
            autocomplete="off"
          />
        </div>
      </fieldset>
      {#if error}<p role="alert" class="text-body-sm text-destructive">{error}</p>{/if}

      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={close} disabled={$saveMut.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={$saveMut.isPending}>
          {$saveMut.isPending ? "Saving…" : isEdit ? "Save changes" : "Create secret"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
