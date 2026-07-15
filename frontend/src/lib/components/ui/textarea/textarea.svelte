<script lang="ts">
  import type { HTMLTextareaAttributes } from "svelte/elements";
  import { cn } from "$lib/utils/cn";

  type Props = HTMLTextareaAttributes & { class?: string; value?: string | null };
  let { class: className, value = $bindable(), ...rest }: Props = $props();
</script>

<textarea
  class={cn(
    "flex min-h-[80px] w-full rounded-lg border border-input bg-card/80 px-3 py-2 text-sm shadow-sm ring-offset-background transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-muted-foreground/75 hover:border-foreground/20 focus-visible:border-ring focus-visible:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50",
    className,
  )}
  bind:value
  {...rest}
></textarea>
