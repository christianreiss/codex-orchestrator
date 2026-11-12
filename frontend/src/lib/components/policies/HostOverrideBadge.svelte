<script lang="ts">
  /**
   * Scope of a fleet setting: either "every host follows it" or a link to the
   * hosts that diverge. `count` is undefined while unknown (loading, no read
   * access), in which case nothing is claimed.
   */
  import { base } from "$app/paths";
  import { Badge } from "$lib/components/ui/badge";

  let { count, noun = "override" }: { count?: number | null; noun?: string } = $props();
</script>

{#if count != null}
  {#if count > 0}
    <a
      href={`${base}/hosts`}
      data-testid="host-override-badge"
      class="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`${count} ${count === 1 ? "host" : "hosts"} ${count === 1 ? `has its own ${noun}` : `have their own ${noun}s`}. Open Hosts.`}
    >
      <Badge variant="warning">{count} {count === 1 ? "host overrides" : "hosts override"}</Badge>
    </a>
  {:else}
    <span data-testid="host-override-none" class="text-caption text-muted-foreground">Every host follows this</span>
  {/if}
{/if}
