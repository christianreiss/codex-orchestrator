<script lang="ts">
  /**
   * A single fleet-wide setting: label + description + control + inline
   * saved-state — what a settings section whose entire body is one switch
   * collapses into, in place of a full SectionCard. `bordered` is false
   * when several rows share one parent Card (divided by the parent's own
   * `divide-y`) instead of each carrying its own border.
   */
  import type { Snippet } from "svelte";
  import { Switch } from "$lib/components/ui/switch";
  import { Label } from "$lib/components/ui/label";
  import Check from "@lucide/svelte/icons/check";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";

  type Props = {
    /** Anchor id — must match the old section's id so existing deep links resolve. */
    id: string;
    /** Id of the switch/label pair. Defaults to `${id}-toggle`. */
    toggleId?: string;
    label: string;
    description?: string;
    checked: boolean;
    disabled?: boolean;
    bordered?: boolean;
    info?: Snippet;
    onCheckedChange: (value: boolean) => Promise<unknown>;
  };
  let {
    id,
    toggleId,
    label,
    description,
    checked,
    disabled = false,
    bordered = true,
    info,
    onCheckedChange,
  }: Props = $props();

  const resolvedToggleId = $derived(toggleId ?? `${id}-toggle`);

  let saved = $state(false);
  let busy = $state(false);
  let errorMsg = $state<string | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  async function handleChange(value: boolean): Promise<void> {
    busy = true;
    errorMsg = null;
    try {
      await onCheckedChange(value);
      saved = true;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        saved = false;
      }, 1600);
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Save failed";
    } finally {
      busy = false;
    }
  }
</script>

<div
  {id}
  class="flex scroll-mt-24 items-center justify-between gap-3 {bordered
    ? 'rounded-md border p-2.5'
    : 'py-3'}"
>
  <div class="min-w-0">
    <Label for={resolvedToggleId} class="text-sm font-medium">{label}</Label>
    {#if description}
      <p class="mt-0.5 text-xs text-muted-foreground">{description}</p>
    {/if}
    {#if info}
      <div class="mt-1.5">{@render info()}</div>
    {/if}
    {#if errorMsg}
      <p class="mt-1 flex items-center gap-1 text-xs text-destructive">
        <TriangleAlert class="h-3 w-3 flex-shrink-0" />
        {errorMsg}
      </p>
    {/if}
  </div>
  <div class="flex shrink-0 items-center gap-1.5">
    {#if saved}
      <Check class="h-3.5 w-3.5 text-success" aria-hidden="true" />
    {/if}
    <Switch
      id={resolvedToggleId}
      {checked}
      disabled={disabled || busy}
      onCheckedChange={(v) => void handleChange(Boolean(v))}
      aria-label={label}
    />
  </div>
</div>
