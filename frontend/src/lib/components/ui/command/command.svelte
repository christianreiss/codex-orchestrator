<script lang="ts">
  import { Command as CommandPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = CommandPrimitive.RootProps;
  let { class: className, ...rest }: Props = $props();
</script>

<CommandPrimitive.Root
  class={cn(
    "flex h-full w-full flex-col overflow-hidden rounded-2xl bg-popover text-popover-foreground",
    className,
  )}
  {...rest}
/>
