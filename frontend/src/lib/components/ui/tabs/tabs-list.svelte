<script lang="ts">
  import { Tabs as TabsPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = TabsPrimitive.ListProps;
  let { class: className, ...rest }: Props = $props();
</script>

<TabsPrimitive.List
  class={cn(
    "inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground",
    className,
  )}
  {...rest}
/>
