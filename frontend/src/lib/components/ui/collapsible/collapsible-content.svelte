<script lang="ts">
  import { Collapsible as CollapsiblePrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = CollapsiblePrimitive.ContentProps;
  let { class: className, ...rest }: Props = $props();
</script>

<CollapsiblePrimitive.Content
  class={cn(
    "data-[state=closed]:hidden data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1",
    className,
  )}
  {...rest}
/>
