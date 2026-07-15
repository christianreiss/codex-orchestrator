<script lang="ts">
  import { Tabs as TabsPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = TabsPrimitive.ListProps;
  let { class: className, ...rest }: Props = $props();
</script>

<TabsPrimitive.List
  class={cn(
    "inline-flex min-h-10 items-center justify-center rounded-xl border border-border/50 bg-muted/75 p-1 text-muted-foreground",
    className,
  )}
  {...rest}
/>
