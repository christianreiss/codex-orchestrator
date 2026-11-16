<script lang="ts">
  import type { Snippet } from "svelte";
  import { DropdownMenu as Primitive } from "bits-ui";
  import Check from "@lucide/svelte/icons/check";
  import { cn } from "$lib/utils/cn";
  let { class: className, children: content, ...rest }: Omit<Primitive.RadioItemProps, "children"> & { children?: Snippet } = $props();
</script>
<Primitive.RadioItem {...rest} class={cn("relative flex min-h-9 cursor-default select-none items-center gap-2 rounded px-2.5 py-1.5 text-body-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring transition-colors focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 pointer-coarse:min-h-11", className)}>
  {#snippet children({ checked })}
    {@render content?.()}
    <span class="ml-auto grid h-4 w-4 place-items-center" aria-hidden="true">{#if checked}<Check class="h-4 w-4" />{/if}</span>
  {/snippet}
</Primitive.RadioItem>
