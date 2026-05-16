<script lang="ts">
  import { Command as CommandPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = CommandPrimitive.EmptyProps;
  let { class: className, ...rest }: Props = $props();
</script>

<CommandPrimitive.Empty class={cn("py-6 text-center text-sm", className)} {...rest} />
