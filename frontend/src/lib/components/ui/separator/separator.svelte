<script lang="ts">
  import { Separator as SeparatorPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = SeparatorPrimitive.RootProps;
  let { class: className, orientation = "horizontal", ...rest }: Props = $props();
</script>

<SeparatorPrimitive.Root
  class={cn(
    "shrink-0 bg-border",
    orientation === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]",
    className,
  )}
  {orientation}
  {...rest}
/>
