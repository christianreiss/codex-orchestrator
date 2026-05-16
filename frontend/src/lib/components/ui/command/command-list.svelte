<script lang="ts">
  import { Command as CommandPrimitive } from "bits-ui";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";

  type Props = CommandPrimitive.ListProps & { children?: Snippet };
  let { class: className, children, ...rest }: Props = $props();
</script>

<CommandPrimitive.List
  class={cn("max-h-[300px] overflow-y-auto overflow-x-hidden", className)}
  {...rest}
>
  <CommandPrimitive.Viewport class="p-1">
    {@render children?.()}
  </CommandPrimitive.Viewport>
</CommandPrimitive.List>
