<script lang="ts">
  let { name, text, onjump }: { name?: string; text?: string; onjump?: () => void } = $props();
</script>
{#if onjump}<button type="button" class="mb-3 block min-h-11 w-full min-w-0 rounded border bg-background p-2 text-left text-caption hover:bg-muted" onclick={onjump}>
    <span class="block font-medium">Reply to {name}</span><span class="line-clamp-2 break-words text-muted-foreground">{text}</span>
  </button>
{:else}<p class="mb-3 rounded border bg-background p-2 text-caption text-muted-foreground">Reply to an earlier message · Load earlier history to see the original.</p>{/if}
