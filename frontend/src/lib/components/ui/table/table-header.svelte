<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  type Props = HTMLAttributes<HTMLTableSectionElement> & { class?: string; children?: Snippet };
  let { class: className, children, ...rest }: Props = $props();
</script>

<!-- Sticky inside its scroll region; the opaque background keeps scrolled rows from showing
     through the translucent header tint, and the header cells draw their own rule because a
     collapsed table border does not travel with a sticky row. -->
<thead class={cn("sticky top-0 z-10 bg-background [&_tr]:border-b-0", className)} {...rest}>
  {@render children?.()}
</thead>
