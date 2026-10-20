<script lang="ts">
  import { factLabel, safeWorkflowUrl } from "./helpers";
  let { value }: { value: unknown } = $props();
</script>

{#snippet readable(item: unknown)}
  {#if Array.isArray(item)}
    {#if item.length}<ul class="list-disc space-y-2 pl-5">{#each item as entry}<li class="min-w-0">{@render readable(entry)}</li>{/each}</ul>{:else}<span class="text-muted-foreground">None recorded</span>{/if}
  {:else if item !== null && typeof item === "object"}
    {#if Object.keys(item).length}
      <dl class="space-y-3">{#each Object.entries(item) as [key, entry]}<div class="grid min-w-0 gap-1 sm:grid-cols-[minmax(8rem,1fr)_minmax(0,3fr)]"><dt class="font-medium text-muted-foreground">{factLabel(key)}</dt><dd class="min-w-0">{@render readable(entry)}</dd></div>{/each}</dl>
    {:else}<span class="text-muted-foreground">None recorded</span>{/if}
  {:else if safeWorkflowUrl(item)}
    <a class="break-all underline" href={safeWorkflowUrl(item)!} rel="noopener noreferrer" target="_blank">{String(item)}</a>
  {:else}
    <span class="whitespace-pre-wrap">{item == null || item === "" ? "Not recorded" : typeof item === "boolean" ? (item ? "Yes" : "No") : String(item)}</span>
  {/if}
{/snippet}
<div class="min-w-0 break-words text-body [overflow-wrap:anywhere]">{@render readable(value)}</div>
