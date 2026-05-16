<script lang="ts">
  import { RadioGroup as RadioGroupPrimitive } from "bits-ui";
  import Circle from "@lucide/svelte/icons/circle";
  import { cn } from "$lib/utils/cn";

  type Props = RadioGroupPrimitive.ItemProps;
  let { class: className, ...rest }: Props = $props();
</script>

<RadioGroupPrimitive.Item
  class={cn(
    "aspect-square h-4 w-4 rounded-full border border-primary text-primary ring-offset-background focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
    className,
  )}
  {...rest}
>
  {#snippet children({ checked })}
    <div class="flex items-center justify-center">
      {#if checked}
        <Circle class="h-2.5 w-2.5 fill-current text-current" />
      {/if}
    </div>
  {/snippet}
</RadioGroupPrimitive.Item>
