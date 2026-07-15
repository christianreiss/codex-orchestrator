<script lang="ts">
  import type { Snippet } from "svelte";
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { cn } from "$lib/utils/cn";
  import Settings from "@lucide/svelte/icons/settings";
  import Users from "@lucide/svelte/icons/users";

  let { children }: { children?: Snippet } = $props();
  const path = $derived(page.url.pathname.replace(base, "") || "/");
  const usersActive = $derived(path.startsWith("/settings/users"));
</script>

<PageHeader
  title={usersActive ? "Users & access" : "Settings"}
  subtitle={usersActive
    ? "Manage admin accounts, roles, and access lifecycle."
    : "Configure fleet-wide behavior, engine defaults, retention, and security policy."}
  class="mb-4"
/>

<nav class="mb-5" aria-label="Settings sections">
  <div class="inline-flex min-h-11 items-center rounded-xl border border-border/60 bg-muted/70 p-1">
    <a
      href={`${base}/settings`}
      class={cn(
        "inline-flex min-h-9 items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-all",
        !usersActive ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
      aria-current={!usersActive ? "page" : undefined}
    >
      <Settings class="h-4 w-4" /> Fleet configuration
    </a>
    <a
      href={`${base}/settings/users`}
      class={cn(
        "inline-flex min-h-9 items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-all",
        usersActive ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
      aria-current={usersActive ? "page" : undefined}
    >
      <Users class="h-4 w-4" /> Users
    </a>
  </div>
</nav>

{@render children?.()}
