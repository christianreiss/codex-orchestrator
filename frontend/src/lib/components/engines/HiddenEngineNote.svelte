<script lang="ts">
  /**
   * The one note for rows that belong to an engine switched off fleet-wide.
   * Those rows are kept server-side and listed nowhere but Engines; this tells
   * the operator why a list is shorter than the data, and where to get them back.
   */
  import { base } from "$app/paths";

  let { count }: { count: number } = $props();
</script>

{#if count > 0}
  <p class="text-body-sm text-muted-foreground" role="status">
    {count} {count === 1 ? "item" : "items"} from switched-off engines {count === 1 ? "is" : "are"} hidden. {count === 1 ? "It returns" : "They return"} when the engine is switched back on under <a class="text-primary underline-offset-2 hover:underline" href={`${base}/engines`}>Engines</a>.
  </p>
{/if}
