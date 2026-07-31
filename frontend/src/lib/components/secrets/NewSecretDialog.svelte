<script lang="ts">
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Select from "$lib/components/ui/select";
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
  let engine = $state<"any" | "codex" | "claude">("any");
  let tags = $state("");

  const isEdit = $derived(editing !== null);

  // Re-seed whenever the dialog opens, so a cancelled edit cannot bleed into the
  // next create.
  $effect(() => {
    if (!open) return;
    slug = editing?.slug ?? "";
    name = editing?.name ?? "";
    description = editing?.description ?? "";
    value = "";
    engine = (editing?.engine ?? "any") as "any" | "codex" | "claude";
    tags = (editing?.tags ?? []).join(", ");
  });

  function parseTags(raw: string): string[] {
    return raw
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");
  }

  const saveMut = createMutation<AdminSecretResponse, Error, void>({
    mutationFn: async () => {
      const engineValue = engine === "any" ? null : engine;
      if (editing) {
        // Only send a value when one was typed: an empty box means "leave the
        // stored credential alone", not "clear it".
        return await secretsApi.update(editing.id, {
          name: name.trim(),
          description: description.trim() || null,
          engine: engineValue,
          tags: parseTags(tags),
          ...(value ? { value } : {}),
        });
      }
      const payload: CreateSecretPayload = {
        slug: slug.trim().toLowerCase(),
        name: name.trim(),
        value,
        description: description.trim() || null,
        engine: engineValue,
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
      close();
    },
    onError: (err) => {
      toast.error(isEdit ? "Could not update the secret" : "Could not create the secret", {
        description: err.message,
      });
    },
  });

  function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (!isEdit) {
      if (!slug.trim()) {
        toast.error("Slug is required", {
          description: "It is the key agents use, and it cannot be changed later.",
        });
        return;
      }
      if (!value) {
        toast.error("Value is required");
        return;
      }
    }
    $saveMut.mutate();
  }

  function close() {
    if ($saveMut.isPending) return;
    open = false;
    onOpenChange?.(false);
  }

  function handleDialogOpenChange(next: boolean) {
    if (!next && $saveMut.isPending) {
      open = true;
      return;
    }
    open = next;
    onOpenChange?.(next);
  }
</script>

<Dialog.Root bind:open onOpenChange={handleDialogOpenChange}>
  <Dialog.Content class="sm:max-w-lg">
    <form onsubmit={handleSubmit}>
      <Dialog.Header>
        <Dialog.Title>{isEdit ? "Edit secret" : "New secret"}</Dialog.Title>
        <Dialog.Description>
          {isEdit
            ? "Leave the value blank to keep the stored credential and only change its metadata."
            : "A working credential agents fetch over MCP — an API token, database password, or service account."}
        </Dialog.Description>
      </Dialog.Header>

      <div class="grid gap-4 py-4">
        <div class="grid gap-2">
          <Label for="secret-slug">Slug</Label>
          <Input
            id="secret-slug"
            bind:value={slug}
            placeholder="e.g. powerdns-api-key"
            required={!isEdit}
            disabled={isEdit}
            autocomplete="off"
          />
          <p class="text-xs text-muted-foreground">
            {isEdit
              ? "Immutable — it is the key agents already hold. Delete and recreate to rename."
              : "Lowercase; letters, digits, dots, hyphens, underscores and colons. Cannot be changed later."}
          </p>
        </div>

        <div class="grid gap-2">
          <Label for="secret-name">Name</Label>
          <Input
            id="secret-name"
            bind:value={name}
            placeholder="e.g. PowerDNS Authoritative API key"
            required
            autocomplete="off"
          />
        </div>

        <div class="grid gap-2">
          <Label for="secret-description">What is it for?</Label>
          <Textarea
            id="secret-description"
            bind:value={description}
            rows={3}
            placeholder="Which system it opens, and when an agent should reach for it."
          />
          <p class="text-xs text-muted-foreground">
            This is what an agent reads to decide whether this is the credential it needs — the
            only thing distinguishing it from every other entry. Worth a sentence.
          </p>
        </div>

        <div class="grid gap-2">
          <Label for="secret-value">Value</Label>
          <Input
            id="secret-value"
            type="password"
            bind:value
            required={!isEdit}
            autocomplete="new-password"
            placeholder={isEdit ? "Leave blank to keep the current value" : ""}
          />
        </div>

        <div class="grid gap-2">
          <Label for="secret-engine">Visible to</Label>
          <Select.Root
            type="single"
            value={engine}
            onValueChange={(v) => (engine = (v as typeof engine) ?? engine)}
          >
            <Select.Trigger id="secret-engine">
              {engine === "codex" ? "Codex only" : engine === "claude" ? "Claude only" : "Both engines"}
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="any" label="Both engines" />
              <Select.Item value="codex" label="Codex only" />
              <Select.Item value="claude" label="Claude only" />
            </Select.Content>
          </Select.Root>
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
      </div>

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
