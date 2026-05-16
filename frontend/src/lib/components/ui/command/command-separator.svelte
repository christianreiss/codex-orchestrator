<script lang="ts">
  import { Command as CommandPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = CommandPrimitive.SeparatorProps;
  let { class: className, ...rest }: Props = $props();
</script>

<CommandPrimitive.Separator class={cn("-mx-1 h-px bg-border", className)} {...rest} />
