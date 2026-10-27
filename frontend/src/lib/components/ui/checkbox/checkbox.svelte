<script lang="ts">
  import { Checkbox as CheckboxPrimitive } from "bits-ui";
  import Check from "@lucide/svelte/icons/check";
  import Minus from "@lucide/svelte/icons/minus";
  import { cn } from "$lib/utils/cn";

  type Props = CheckboxPrimitive.RootProps;
  let {
    class: className,
    checked = $bindable(false),
    indeterminate = $bindable(false),
    ...rest
  }: Props = $props();
</script>

<CheckboxPrimitive.Root
  bind:checked
  bind:indeterminate
  class={cn(
    "peer relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md ring-offset-background after:absolute after:-inset-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
    className,
  )}
  {...rest}
>
  {#snippet children({
    checked: isChecked,
    indeterminate: isIndeterminate,
  }: {
    checked: boolean;
    indeterminate: boolean;
  })}
    <span aria-hidden="true" class={cn("pointer-events-none flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-primary/70", (isChecked || isIndeterminate) && "bg-primary text-primary-foreground")}>
      {#if isIndeterminate}
        <Minus class="h-3.5 w-3.5" />
      {:else if isChecked}
        <Check class="h-3.5 w-3.5" />
      {/if}
    </span>
  {/snippet}
</CheckboxPrimitive.Root>
