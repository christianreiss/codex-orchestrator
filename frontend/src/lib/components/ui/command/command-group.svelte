<script lang="ts">
  import { Command as CommandPrimitive } from "bits-ui";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";

  type Props = CommandPrimitive.GroupProps & { heading?: string; children?: Snippet };
  let { class: className, heading, children, ...rest }: Props = $props();
</script>

<CommandPrimitive.Group
  class={cn(
    "overflow-hidden p-1 text-foreground",
    className,
  )}
  {...rest}
>
  {#if heading}
    <CommandPrimitive.GroupHeading class="px-2 py-1.5 text-xs font-medium text-muted-foreground">
      {heading}
    </CommandPrimitive.GroupHeading>
  {/if}
  <CommandPrimitive.GroupItems>
    {@render children?.()}
  </CommandPrimitive.GroupItems>
</CommandPrimitive.Group>
