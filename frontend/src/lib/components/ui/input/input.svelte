<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";
  import { cn } from "$lib/utils/cn";

  type Props = HTMLInputAttributes & { class?: string; value?: string | number | null };
  let { class: className, value = $bindable(), ...rest }: Props = $props();
</script>

<input
  class={cn(
    "flex h-10 w-full rounded-lg border border-input bg-card/80 px-3 py-2 text-sm shadow-sm ring-offset-background transition-[border-color,box-shadow,background-color] duration-200 file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground/75 hover:border-foreground/20 focus-visible:border-ring focus-visible:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50",
    className,
  )}
  bind:value
  {...rest}
/>
