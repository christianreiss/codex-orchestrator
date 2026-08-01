<script lang="ts">
  import type { Snippet } from "svelte";
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import TabNav, { type TabNavItem } from "$lib/components/layout/TabNav.svelte";
  import Settings from "@lucide/svelte/icons/settings";
  import Users from "@lucide/svelte/icons/users";
  import Link from "@lucide/svelte/icons/link";

  let { children }: { children?: Snippet } = $props();
  const path = $derived(page.url.pathname.replace(base, "") || "/");
  const usersActive = $derived(path.startsWith("/settings/users"));
  const agentPortalActive = $derived(path.startsWith("/settings/agent-portal"));

  const OUTER_TABS: TabNavItem[] = [
    { href: `${base}/settings`, label: "Fleet configuration", icon: Settings },
    { href: `${base}/settings/users`, label: "Users", icon: Users },
    { href: `${base}/settings/agent-portal`, label: "Agent portal", icon: Link },
  ];

  const title = $derived(
    usersActive ? "Users & access" : agentPortalActive ? "Agent portal" : "Settings",
  );
  const subtitle = $derived(
    usersActive
      ? "Manage admin accounts, roles, and access lifecycle."
      : agentPortalActive
        ? "One permanent login link per user for the fleet-wide Codex and Claude chat portal. Bookmark it on mobile or desktop; nothing is pushed anywhere."
        : "Configure fleet-wide behavior, engine defaults, retention, and security policy.",
  );
</script>

<PageHeader {title} {subtitle} class="mb-4" />

<TabNav items={OUTER_TABS} class="mb-5" />

{@render children?.()}
