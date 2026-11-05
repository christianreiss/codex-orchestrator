<script lang="ts">
  /** Create or edit one external client: name, one-line description, trust level, enabled. */
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { FormField } from "$lib/components/ui/form-field";
  import { controlClass } from "$lib/components/feedback/report-model";
  import {
    EXTERNAL_TRUST_HELP,
    EXTERNAL_TRUST_LEVELS,
    type ExternalClient,
    type ExternalClientInput,
    type ExternalTrust,
  } from "$lib/api/externalClients";

  type Props = {
    open: boolean;
    /** The client being edited; null creates a new one. */
    client: ExternalClient | null;
    busy?: boolean;
    onSubmit: (input: ExternalClientInput) => void;
    onClose: () => void;
  };
  let { open, client, busy = false, onSubmit, onClose }: Props = $props();

  let name = $state("");
  let description = $state("");
  let trust = $state<ExternalTrust>("untrusted");
  let enabled = $state(true);

  // Re-seed whenever the dialog opens for a (different) client.
  $effect(() => {
    if (!open) return;
    name = client?.name ?? "";
    description = client?.description ?? "";
    trust = client?.trust ?? "untrusted";
    enabled = client?.enabled ?? true;
  });
</script>

<Dialog.Root {open} onOpenChange={(next) => { if (!next) onClose(); }}>
  <Dialog.Content>
    <form class="grid gap-3" onsubmit={(event) => { event.preventDefault(); onSubmit({ name, description, trust, enabled }); }}>
      <Dialog.Header>
        <Dialog.Title>{client ? `Edit ${client.name}` : "New external client"}</Dialog.Title>
        <Dialog.Description>
          A bot or bridge that takes part in agent messaging without being a cdx/clx/cgx session. It only ever gets the communication surface.
        </Dialog.Description>
      </Dialog.Header>
      <FormField id="ec-name" label="Name" hint="How agents see and address it. Unique; one line.">
        <input id="ec-name" class={controlClass} bind:value={name} required maxlength="96" autocomplete="off" />
      </FormField>
      <FormField id="ec-description" label="Description" hint="Shown to receivers next to the name, e.g. “Hermes bot of the owner”.">
        <input id="ec-description" class={controlClass} bind:value={description} maxlength="160" autocomplete="off" />
      </FormField>
      <FormField id="ec-trust" label="Trust level" hint={EXTERNAL_TRUST_HELP[trust]}>
        <select id="ec-trust" class={controlClass} bind:value={trust}>
          {#each EXTERNAL_TRUST_LEVELS as level (level)}<option value={level}>{level}</option>{/each}
        </select>
      </FormField>
      <label class="flex items-center gap-2 text-body-sm">
        <input type="checkbox" bind:checked={enabled} />
        Enabled <span class="text-muted-foreground">— a disabled client cannot connect and is shown as offline</span>
      </label>
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={onClose}>Cancel</Button>
        <Button type="submit" disabled={busy || name.trim() === ""}>{client ? "Save client" : "Create client"}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
