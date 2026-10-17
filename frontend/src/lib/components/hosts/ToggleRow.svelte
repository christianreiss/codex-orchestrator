<script lang="ts">
  /**
   * A labeled switch row for ordinary, reversible settings. No success toast:
   * a brief check flashes instead, and the caller's `onchange` surfaces errors.
   * `note` is the muted line under the label (plain explanation, canonical term).
   */
  import { Switch } from "$lib/components/ui/switch";
  import Check from "@lucide/svelte/icons/check";

  type Props = {
    label: string;
    checked: boolean;
    disabled?: boolean;
    note?: string;
    /** Accessible name when it should differ from the visible label. */
    ariaLabel?: string;
    onchange: (value: boolean) => Promise<void>;
  };
  let { label, checked, disabled = false, note, ariaLabel, onchange }: Props = $props();

  let saved = $state(false);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  async function handleChange(value: boolean): Promise<void> {
    try {
      await onchange(value);
      saved = true;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => (saved = false), 1600);
    } catch {
      // The caller's onchange is responsible for surfacing an error toast.
    }
  }
</script>

<div class="flex items-center justify-between gap-4 border-b py-2.5 last:border-b-0">
  <span class="min-w-0">
    <span class="block text-body">{label}</span>
    {#if note}<span class="block text-body-sm text-muted-foreground">{note}</span>{/if}
  </span>
  <div class="flex shrink-0 items-center gap-1.5">
    {#if saved}<Check class="h-4 w-4 text-success" aria-hidden="true" />{/if}
    <Switch {checked} {disabled} onCheckedChange={(v) => void handleChange(Boolean(v))} aria-label={ariaLabel ?? label} />
  </div>
</div>
