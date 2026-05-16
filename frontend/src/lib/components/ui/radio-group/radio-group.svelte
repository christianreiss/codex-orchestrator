<script lang="ts">
  import { RadioGroup as RadioGroupPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = RadioGroupPrimitive.RootProps;
  let { class: className, ...rest }: Props = $props();
</script>

<RadioGroupPrimitive.Root class={cn("grid gap-2", className)} {...rest} />
