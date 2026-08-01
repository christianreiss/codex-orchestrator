<script lang="ts">
  import { Tabs as TabsPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = TabsPrimitive.ListProps;
  let { class: className, ...rest }: Props = $props();
</script>

<TabsPrimitive.List
  class={cn(
    "inline-flex min-h-9 items-center justify-center rounded-md border border-border/70 bg-muted/60 p-0.5 text-muted-foreground",
    className,
  )}
  {...rest}
/>
