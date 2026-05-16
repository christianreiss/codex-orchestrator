<script lang="ts">
  import { Label as LabelPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = LabelPrimitive.RootProps;
  let { class: className, ...rest }: Props = $props();
</script>

<LabelPrimitive.Root
  class={cn(
    "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
    className,
  )}
  {...rest}
/>
