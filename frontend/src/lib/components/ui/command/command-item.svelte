<script lang="ts">
  import { Command as CommandPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = CommandPrimitive.ItemProps;
  let { class: className, ...rest }: Props = $props();
</script>

<CommandPrimitive.Item
  class={cn(
    "relative flex min-h-10 cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none data-[selected]:bg-accent data-[selected]:text-accent-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
    className,
  )}
  {...rest}
/>
