<script lang="ts">
  type Props = {
    /** What the confirmed change does, one sentence each. */
    items: readonly string[];
    /** Extra emphasis above the list; only for the riskiest edge. */
    warning?: string | null;
  };

  let { items, warning = null }: Props = $props();
</script>

{#if warning}
  <p
    role="alert"
    class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-body-sm font-medium text-destructive"
  >
    {warning}
  </p>
{/if}

<ul class="list-disc space-y-1.5 pl-5 text-body-sm text-muted-foreground">
  {#each items as item (item)}
    <li>{item}</li>
  {/each}
</ul>
