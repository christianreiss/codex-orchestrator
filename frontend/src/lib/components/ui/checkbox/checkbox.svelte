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
    "peer relative h-5 w-5 shrink-0 rounded-md border border-primary/70 ring-offset-background after:absolute after:-inset-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
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
    <div class="flex h-full w-full items-center justify-center text-current">
      {#if isIndeterminate}
        <Minus class="h-3.5 w-3.5" />
      {:else if isChecked}
        <Check class="h-3.5 w-3.5" />
      {/if}
    </div>
  {/snippet}
</CheckboxPrimitive.Root>
