<script lang="ts">
  import { Dialog as SheetPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = SheetPrimitive.TitleProps;
  let { class: className, ...rest }: Props = $props();
</script>

<SheetPrimitive.Title class={cn("text-lg font-semibold text-foreground", className)} {...rest} />
