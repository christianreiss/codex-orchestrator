<script lang="ts">
  /**
   * A labeled switch row for ordinary (non-destructive, reversible) toggles.
   * Per the toast-budget rule: no success toast — an inline "Saved" check
   * flashes instead, and only errors surface a toast (the caller's
   * `onchange` is expected to do that itself, e.g. via a shared `run`
   * helper's catch block).
   */
  import { Switch } from "$lib/components/ui/switch";
  import Check from "@lucide/svelte/icons/check";

  type Props = {
    label: string;
    checked: boolean;
    disabled?: boolean;
    onchange: (value: boolean) => Promise<void>;
  };
  let { label, checked, disabled = false, onchange }: Props = $props();

  let saved = $state(false);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  async function handleChange(value: boolean): Promise<void> {
    try {
      await onchange(value);
      saved = true;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        saved = false;
      }, 1600);
    } catch {
      // The caller's onchange is responsible for surfacing an error toast.
    }
  }
</script>

<div class="flex items-center justify-between rounded-md border p-2.5">
  <span class="text-sm">{label}</span>
  <div class="flex items-center gap-1.5">
    {#if saved}
      <Check class="h-3.5 w-3.5 text-success" aria-hidden="true" />
    {/if}
    <Switch
      {checked}
      {disabled}
      onCheckedChange={(v) => void handleChange(Boolean(v))}
      aria-label={label}
    />
  </div>
</div>
