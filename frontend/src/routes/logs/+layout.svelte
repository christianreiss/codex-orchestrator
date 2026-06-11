<script lang="ts">
  import type { Snippet } from "svelte";
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { goto } from "$app/navigation";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Tabs, TabsList, TabsTrigger } from "$lib/components/ui/tabs";

  let { children }: { children?: Snippet } = $props();

  const TABS = [
    { value: "mcp", label: "MCP", path: "/logs/mcp" },
    { value: "events", label: "Events", path: "/logs/events" },
  ] as const;

  const path = $derived(page.url.pathname.replace(base, "") || "/");
  const active = $derived.by(() => {
    for (const tab of TABS) {
      if (path === tab.path || path.startsWith(tab.path + "/")) return tab.value;
    }
    return "mcp";
  });

  function onValueChange(value: unknown) {
    if (typeof value !== "string") return;
    const tab = TABS.find((t) => t.value === value);
    if (!tab) return;
    if (path !== tab.path) {
      void goto(`${base}${tab.path}`, { replaceState: false, keepFocus: true, noScroll: true });
    }
  }
</script>

<PageHeader title="Logs" subtitle="API traffic, MCP invocations, and admin audit trail." />

<Tabs value={active} {onValueChange} class="w-full">
  <TabsList class="mb-4">
    {#each TABS as tab (tab.value)}
      <TabsTrigger value={tab.value}>{tab.label}</TabsTrigger>
    {/each}
  </TabsList>
  <div class="min-w-0">
    {@render children?.()}
  </div>
</Tabs>
