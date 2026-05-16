<script lang="ts">
  import { Dialog as SheetPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = SheetPrimitive.DescriptionProps;
  let { class: className, ...rest }: Props = $props();
</script>

<SheetPrimitive.Description class={cn("text-sm text-muted-foreground", className)} {...rest} />
