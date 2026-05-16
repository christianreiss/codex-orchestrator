<script lang="ts">
  import { Command as CommandPrimitive } from "bits-ui";
  import Search from "@lucide/svelte/icons/search";
  import { cn } from "$lib/utils/cn";

  type Props = CommandPrimitive.InputProps;
  let { class: className, ...rest }: Props = $props();
</script>

<div class="flex items-center border-b px-3" data-cmdk-input-wrapper="">
  <Search class="mr-2 h-4 w-4 shrink-0 opacity-50" />
  <CommandPrimitive.Input
    class={cn(
      "flex h-11 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...rest}
  />
</div>
