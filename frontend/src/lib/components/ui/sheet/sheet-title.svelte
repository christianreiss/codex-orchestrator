<script lang="ts">
  import { Dialog as SheetPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = SheetPrimitive.TitleProps;
  let { class: className, ...rest }: Props = $props();
</script>

<SheetPrimitive.Title class={cn("text-h2 text-foreground", className)} {...rest} />
