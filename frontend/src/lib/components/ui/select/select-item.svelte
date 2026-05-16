<script lang="ts">
  import { Select as SelectPrimitive } from "bits-ui";
  import Check from "@lucide/svelte/icons/check";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";

  type Props = SelectPrimitive.ItemProps & { children?: Snippet };
  let { class: className, children, label, value, ...rest }: Props = $props();
</script>

<SelectPrimitive.Item
  {value}
  {label}
  class={cn(
    "relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
    className,
  )}
  {...rest}
>
  <span
    class="absolute left-2 flex h-3.5 w-3.5 items-center justify-center group-data-[state=checked]:opacity-100"
  >
    <Check class="hidden h-4 w-4 group-data-[state=checked]:block" />
  </span>
  {#if children}{@render children()}{:else}{label ?? value}{/if}
</SelectPrimitive.Item>
