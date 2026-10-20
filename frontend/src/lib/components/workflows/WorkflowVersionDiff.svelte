<script lang="ts">
  import { displayValue, statusLabel } from "./helpers";
  let { diff }: { diff: unknown } = $props();
  const entries = $derived(Array.isArray(diff) ? diff as { field: string; before: unknown; after: unknown }[] : []);
</script>
{#if entries.length}<div class="space-y-3">{#each entries as entry}<section class="min-w-0 border-l-2 pl-3" aria-label={`Changes to ${entry.field}`}><h3 class="text-body font-semibold">{statusLabel(entry.field)}</h3><div class="mt-2 grid min-w-0 gap-3 md:grid-cols-2"><div class="min-w-0"><p class="text-caption text-muted-foreground">Previous</p><pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border bg-muted p-3 text-body-sm [overflow-wrap:anywhere]">{displayValue(entry.before)}</pre></div><div class="min-w-0"><p class="text-caption text-muted-foreground">Published</p><pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border bg-muted p-3 text-body-sm [overflow-wrap:anywhere]">{displayValue(entry.after)}</pre></div></div></section>{/each}</div>{:else}<p class="text-body-sm text-muted-foreground">No content changes recorded.</p>{/if}
