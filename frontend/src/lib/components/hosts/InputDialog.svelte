<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { ModelSelect } from "$lib/components/ui/model-select";
  import type { ModelOption } from "$lib/constants/models";

  type Props = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    label: string;
    placeholder?: string;
    initialValue?: string | null;
    confirmLabel?: string;
    /** Allow clearing the field to send null. */
    allowEmpty?: boolean;
    /** When set, render an editable model combobox (constant suggestions) instead of a plain input. */
    options?: ModelOption[];
    onSubmit: (value: string | null) => void | Promise<void>;
  };

  let {
    open = $bindable(false),
    onOpenChange,
    title,
    description,
    label,
    placeholder,
    initialValue,
    confirmLabel = "Save",
    allowEmpty = true,
    options,
    onSubmit,
  }: Props = $props();

  let value = $state("");
  let busy = $state(false);

  // Reset to fresh `initialValue` each time the dialog opens.
  $effect(() => {
    if (open) {
      // capture inside the effect so subsequent prop changes also reset
      value = initialValue ?? "";
    }
  });

  function handleOpenChange(v: boolean): void {
    open = v;
    onOpenChange(v);
  }

  async function submit(): Promise<void> {
    busy = true;
    try {
      const trimmed = value.trim();
      const out = trimmed === "" ? (allowEmpty ? null : "") : trimmed;
      if (out === "") return;
      await onSubmit(out);
      handleOpenChange(false);
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      {#if description}<Dialog.Description>{description}</Dialog.Description>{/if}
    </Dialog.Header>
    <form
      class="space-y-3"
      onsubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div class="space-y-1.5">
        <Label for="inputdialog-field">{label}</Label>
        {#if options}
          <ModelSelect
            id="inputdialog-field"
            allowCustom
            bind:value
            {options}
            {label}
            {placeholder}
            class="w-full"
          />
        {:else}
          <Input id="inputdialog-field" bind:value {placeholder} autocomplete="off" />
        {/if}
        {#if allowEmpty}
          <p class="text-[11px] text-muted-foreground">Leave blank to clear.</p>
        {/if}
      </div>
      <Dialog.Footer>
        <Button variant="ghost" type="button" onclick={() => handleOpenChange(false)} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>{busy ? "Saving…" : confirmLabel}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
