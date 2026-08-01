<script lang="ts">
  import type { Snippet } from "svelte";
  import { base } from "$app/paths";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import TabNav from "$lib/components/layout/TabNav.svelte";

  let { children }: { children?: Snippet } = $props();

  const TABS = [
    { href: `${base}/logs/events`, label: "Audit trail" },
    { href: `${base}/logs/mcp`, label: "MCP requests" },
  ];
</script>

<PageHeader
  title="Activity"
  subtitle="Investigate administrative changes and MCP requests with persistent, shareable filters."
/>

<TabNav items={TABS} class="mb-5" />

<div class="min-w-0">
  {@render children?.()}
</div>
