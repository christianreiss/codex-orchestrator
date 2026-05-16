<script lang="ts">
  import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = DropdownMenuPrimitive.GroupHeadingProps & { inset?: boolean };
  let { class: className, inset, ...rest }: Props = $props();
</script>

<DropdownMenuPrimitive.GroupHeading
  class={cn("px-2 py-1.5 text-sm font-semibold", inset && "pl-8", className)}
  {...rest}
/>
