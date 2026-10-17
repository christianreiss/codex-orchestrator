<script lang="ts">
  import type { ComponentProps } from "svelte";
  import { base } from "$app/paths";
  import { HUBS, type HubId } from "$lib/nav";
  import TabNav from "$lib/components/layout/TabNav.svelte";
  import { useFleetEngines } from "$lib/engines/fleet-engines";

  let { hub, class: className = "mb-4" }: { hub: HubId; class?: string } = $props();

  // Engine-specific pages stay reachable while their engine is off fleet-wide;
  // the tab only says so (same rule as the rail and the mobile sheet).
  const fleet = useFleetEngines();

  const items = $derived.by<ComponentProps<typeof TabNav>["items"]>(() => {
    const found = HUBS.find((candidate) => candidate.id === hub);
    if (!found) return [];
    return found.items.map((item) => ({
      href: `${base}${item.route}`,
      label: item.label,
      icon: item.icon,
      group: item.subgroup,
      // `/logs/events` is the Logs entry point; `/logs/mcp` belongs to it too.
      activePath: item.match ? `${base}/${item.route.split("/")[1]}` : undefined,
      badge: item.engine && !$fleet.isEnabled(item.engine) ? "off" : undefined,
    }));
  });
</script>

{#if items.length > 1}
  <TabNav {items} class={className} aria-label={`${HUBS.find((candidate) => candidate.id === hub)?.label ?? "Section"} pages`} />
{/if}
