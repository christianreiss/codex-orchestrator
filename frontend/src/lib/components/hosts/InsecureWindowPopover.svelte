<script lang="ts">
  import * as Popover from "$lib/components/ui/popover";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";

  type Props = {
    /** Visible label for the trigger button. */
    label: string;
    /** Button variant. */
    variant?:
      | "default"
      | "outline"
      | "ghost"
      | "secondary"
      | "destructive"
      | "link";
    /** Button size. */
    size?: "default" | "sm" | "lg" | "icon";
    /** Disabled state. */
    disabled?: boolean;
    /** Initial duration in minutes (default 10). */
    initial?: number;
    /** Headline shown inside the popover. */
    heading?: string;
    /** Submit label inside the popover. */
    confirmLabel?: string;
    /** Fired when the operator confirms — receives the chosen duration. */
    onConfirm: (durationMinutes: number) => void | Promise<void>;
    /** Optional class for the trigger button. */
    class?: string;
    /** Optional snippet for an icon to render inside the trigger button. */
    icon?: import("svelte").Snippet;
  };

  let {
    label,
    variant = "default",
    size = "default",
    disabled = false,
    initial = 10,
    heading = "Open insecure window",
    confirmLabel = "Apply",
    onConfirm,
    class: triggerClass,
    icon,
  }: Props = $props();

  const MIN = 0;
  const MAX = 480;
  const STEP = 5;

  let open = $state(false);
  let value: number | null = $state(10);
  let busy = $state(false);

  // True when the field is empty/non-numeric — blocks submission until fixed.
  let invalid = $derived(!Number.isFinite(value));

  // Reset the slider when the popover opens (read prop inside the effect so it
  // re-runs when the parent changes the default).
  $effect(() => {
    if (open) {
      value = initial;
    }
  });

  function clamp(n: number | null): number {
    if (!Number.isFinite(n)) return clamp(initial);
    const truncated = Math.trunc(n as number);
    if (truncated < MIN) return MIN;
    if (truncated > MAX) return MAX;
    return truncated;
  }

  async function apply(): Promise<void> {
    if (invalid) return;
    busy = true;
    try {
      await onConfirm(clamp(value));
      open = false;
    } finally {
      busy = false;
    }
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button {...props} {variant} {size} {disabled} class={triggerClass}>
        {#if icon}
          {@render icon()}
        {/if}
        {label}
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content class="w-72 space-y-3" align="start">
    <header class="space-y-0.5">
      <p class="text-sm font-semibold">{heading}</p>
      <p class="text-[11px] text-muted-foreground">
        Pick a duration between {MIN} and {MAX} minutes. Default 10 min.
      </p>
    </header>

    <div class="space-y-1.5">
      <Label for="insecure-window-slider">Duration: {value} min</Label>
      <input
        id="insecure-window-slider"
        type="range"
        min={MIN}
        max={MAX}
        step={STEP}
        bind:value
        class="block w-full accent-primary"
      />
      <Input
        type="number"
        min={MIN}
        max={MAX}
        step={STEP}
        bind:value
        class="h-8 text-xs"
        aria-label="Duration in minutes"
      />
    </div>

    <div class="flex justify-end gap-2">
      <Button variant="ghost" size="sm" onclick={() => (open = false)} disabled={busy}>
        Cancel
      </Button>
      <Button size="sm" onclick={apply} disabled={busy}>
        {busy ? "Working…" : confirmLabel}
      </Button>
    </div>
  </Popover.Content>
</Popover.Root>
