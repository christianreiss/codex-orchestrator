<script lang="ts">
  import { Select as SelectPrimitive } from "bits-ui";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";

  type Props = SelectPrimitive.TriggerProps & { children?: Snippet };
  let { class: className, children, ...rest }: Props = $props();
</script>

<SelectPrimitive.Trigger
  class={cn(
    "flex h-10 w-full items-center justify-between rounded-lg border border-input bg-card/80 px-3 py-2 text-sm shadow-sm ring-offset-background transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-muted-foreground hover:border-foreground/20 focus:border-ring focus:bg-card focus:outline-none focus:ring-2 focus:ring-ring/25 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50",
    className,
  )}
  {...rest}
>
  {@render children?.()}
  <ChevronDown class="h-4 w-4 opacity-50" />
</SelectPrimitive.Trigger>
