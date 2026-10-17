<script lang="ts">
  import { page } from "$app/state";
  import { useQueryClient } from "@tanstack/svelte-query";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import { PageShell } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import SegmentedControl from "$lib/components/page/SegmentedControl.svelte";
  import { ActivityFilters } from "$lib/components/logs/activity-filters.svelte";
  import ChangesPanel from "$lib/components/logs/ChangesPanel.svelte";
  import ToolCallsPanel from "$lib/components/logs/ToolCallsPanel.svelte";
  import type { ActivityType } from "$lib/components/logs/event-model";

  const TYPES: Array<{ value: ActivityType; label: string; hint: string }> = [
    { value: "changes", label: "Admin changes", hint: "Audit trail of configuration and system changes" },
    { value: "tools", label: "Tool calls", hint: "MCP requests made by agents" },
  ];

  const qc = useQueryClient();
  // svelte-ignore state_referenced_locally
  const feed = new ActivityFilters(page.url.searchParams);

  $effect(() => feed.syncUrl(page.url));
  // A new filter always starts at the first page.
  $effect(() => {
    void [feed.type, feed.q, feed.host, feed.window, feed.action, feed.status];
    feed.page = 1;
  });
</script>

<PageShell title="Activity" description="What changed in the fleet, and which tools agents called.">
  {#snippet actions()}
    <Button variant="outline" size="sm" onclick={() => void qc.invalidateQueries({ queryKey: ["logs"] })}>
      <RefreshCw class="h-4 w-4" /> Refresh
    </Button>
  {/snippet}

  <SegmentedControl label="Activity type" value={feed.type} options={TYPES} onChange={(next) => feed.setType(next)} />

  {#if feed.type === "changes"}
    <ChangesPanel {feed} />
  {:else}
    <ToolCallsPanel {feed} />
  {/if}
</PageShell>
