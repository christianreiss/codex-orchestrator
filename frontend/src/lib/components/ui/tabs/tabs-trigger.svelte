<script lang="ts">
  import { Tabs as TabsPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = TabsPrimitive.TriggerProps;
  let { class: className, ...rest }: Props = $props();
</script>

<TabsPrimitive.Trigger
  class={cn(
    "inline-flex min-h-8 items-center justify-center whitespace-nowrap rounded px-3 py-1.5 text-sm font-medium ring-offset-background transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-card data-[state=active]:text-foreground",
    className,
  )}
  {...rest}
/>
