<script lang="ts">
  import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = DropdownMenuPrimitive.SeparatorProps;
  let { class: className, ...rest }: Props = $props();
</script>

<DropdownMenuPrimitive.Separator class={cn("-mx-1 my-1 h-px bg-muted", className)} {...rest} />
