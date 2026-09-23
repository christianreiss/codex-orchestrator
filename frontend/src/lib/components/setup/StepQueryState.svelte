<script lang="ts">
  /**
   * Loading / error placeholder shared by every wizard step that reads its own
   * query, so each one fails the same way: say what could not be loaded and
   * offer a retry, instead of rendering controls seeded from nothing.
   */
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import { EmptyState } from "$lib/components/ui/empty-state";
  import { Button } from "$lib/components/ui/button";

  type Props = {
    loading: boolean;
    /** Message of the first failed query, if any. */
    error: string | null;
    /** What is being loaded, lower-case: "the fleet policy". */
    subject: string;
    onRetry: () => void;
  };

  let { loading, error, subject, onRetry }: Props = $props();
</script>

{#if error}
  <EmptyState size="sm" icon={CircleAlert} title={`Could not load ${subject}`} description={error}>
    {#snippet action()}
      <Button variant="outline" size="sm" onclick={onRetry}>Retry</Button>
    {/snippet}
  </EmptyState>
{:else if loading}
  <EmptyState size="sm" icon={LoaderCircle} title={`Loading ${subject}…`} aria-busy="true" />
{/if}
