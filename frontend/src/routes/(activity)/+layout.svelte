<script lang="ts">
  import type { Snippet } from "svelte";
  import HubTabs from "$lib/components/layout/HubTabs.svelte";

  let { children }: { children?: Snippet } = $props();
</script>

<HubTabs hub="activity" />
{@render children?.()}
