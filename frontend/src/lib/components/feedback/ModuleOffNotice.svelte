<script lang="ts">
  /** Page-level notice for a module that is switched off: what is blocked and what stays readable. */
  import type { Snippet } from "svelte";
  import Power from "@lucide/svelte/icons/power-off";
  let { children }: { children: Snippet } = $props();
</script>

<p role="status" class="flex items-start gap-2 rounded-md border border-warning/25 bg-warning-muted px-3 py-2 text-body-sm text-warning-muted-foreground">
  <Power class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
  <span class="min-w-0">{@render children()}</span>
</p>
