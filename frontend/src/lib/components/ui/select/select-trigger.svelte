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
    "flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
    className,
  )}
  {...rest}
>
  {@render children?.()}
  <ChevronDown class="h-4 w-4 opacity-50" />
</SelectPrimitive.Trigger>
