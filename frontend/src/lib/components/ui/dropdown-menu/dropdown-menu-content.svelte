<script lang="ts">
  import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = DropdownMenuPrimitive.ContentProps & { sideOffset?: number };
  let { class: className, sideOffset = 4, ...rest }: Props = $props();
</script>

<DropdownMenuPrimitive.Portal>
  <DropdownMenuPrimitive.Content
    {sideOffset}
    class={cn(
      "z-50 min-w-[8rem] overflow-hidden rounded-md border border-border/80 bg-popover p-1.5 text-popover-foreground shadow-pop data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
      className,
    )}
    {...rest}
  />
</DropdownMenuPrimitive.Portal>
