<script lang="ts">
  import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = DropdownMenuPrimitive.ItemProps & { inset?: boolean };
  let { class: className, inset, ...rest }: Props = $props();
</script>

<DropdownMenuPrimitive.Item
  class={cn(
    "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
    inset && "pl-8",
    className,
  )}
  {...rest}
/>
