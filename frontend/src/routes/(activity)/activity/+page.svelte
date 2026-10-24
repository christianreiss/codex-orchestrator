<script lang="ts">
  import { page } from "$app/state";
  import { useQueryClient } from "@tanstack/svelte-query";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import { PageShell } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import { ActivityFilters } from "$lib/components/logs/activity-filters.svelte";
  import ChangesPanel from "$lib/components/logs/ChangesPanel.svelte";

  const qc = useQueryClient();
  // svelte-ignore state_referenced_locally
  const feed = new ActivityFilters(page.url.searchParams);

  $effect(() => feed.syncUrl(page.url));
  // A new filter always starts at the first page.
  $effect(() => {
    void [feed.q, feed.host, feed.window, feed.action];
    feed.page = 1;
  });
</script>

<PageShell title="Activity" description="Configuration and system changes in the fleet.">
  {#snippet actions()}
    <Button variant="outline" size="sm" onclick={() => void qc.invalidateQueries({ queryKey: ["logs"] })}>
      <RefreshCw class="h-4 w-4" /> Refresh
    </Button>
  {/snippet}

  <ChangesPanel {feed} />
</PageShell>
