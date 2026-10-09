<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import TogglePolicy from "$lib/components/policies/TogglePolicy.svelte";
  import AuthorizationPolicy from "$lib/components/policies/AuthorizationPolicy.svelte";
  import CleanupPolicy from "$lib/components/policies/CleanupPolicy.svelte";
  import Server from "@lucide/svelte/icons/server";
  import Bot from "@lucide/svelte/icons/bot";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import Archive from "@lucide/svelte/icons/archive";
  const categories = [
    { id: "fleet-behavior", title: "Host behavior", description: "Updates and connection metadata", icon: Server },
    { id: "agent-behavior", title: "Agent behavior", description: "Instructions and remote jobs", icon: Bot },
    { id: "access-control", title: "Access control", description: "Roles and host approvals", icon: ShieldCheck },
    { id: "cleanup", title: "Cleanup", description: "Inactive hosts and log retention", icon: Archive },
  ];
  const anchors: Record<string, string> = {
    "auto-update": "fleet-behavior", "reverse-dns": "fleet-behavior",
    "api-keys-in-chat": "agent-behavior", "remote-exec": "agent-behavior",
    authorization: "access-control", "insecure-approval": "access-control",
    "host-lifecycle": "cleanup", "prune-policy": "cleanup", "log-retention": "cleanup",
  };
  const active = $derived(anchors[page.url.hash.slice(1)] ?? (categories.some((c) => c.id === page.url.hash.slice(1)) ? page.url.hash.slice(1) : "fleet-behavior"));
  function navigate(id: string) { void goto(`${page.url.pathname}${page.url.search}#${id}`, { noScroll: true, keepFocus: true }); }
  // All panels remain mounted: numeric drafts survive category changes.
  onMount(() => {
    const id = page.url.hash.slice(1);
    if (id) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
  });
</script>
<PageHeader title="Policies" subtitle="Control fleet behavior, access and cleanup. Choose a category to review its policies." />
<div class="grid items-start gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
  <nav aria-label="Policy categories" class="hidden space-y-1 lg:sticky lg:top-6 lg:block">
    {#each categories as category}
      <a href={`#${category.id}`} onclick={(event) => { event.preventDefault(); navigate(category.id); }} aria-current={active === category.id ? "page" : undefined}
        class="flex items-start gap-3 rounded-lg border p-3 transition-colors {active === category.id ? 'border-primary/20 bg-primary/10 text-foreground' : 'border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'}">
        <category.icon class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span><span class="block text-sm font-medium">{category.title}</span><span class="mt-1 block text-xs leading-relaxed text-muted-foreground">{category.description}</span></span>
      </a>
    {/each}
  </nav>
  <div class="sticky top-0 z-10 space-y-2 border-b bg-background py-3 lg:hidden">
    <label for="policy-category" class="text-sm font-medium">Policy category</label>
    <select id="policy-category" value={active} onchange={(event) => navigate(event.currentTarget.value)} class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
      {#each categories as category}<option value={category.id}>{category.title}</option>{/each}
    </select>
  </div>
  <div class="min-w-0 max-w-4xl">
    {#each categories as category}
      <section id={category.id} hidden={active !== category.id} aria-labelledby={`${category.id}-heading`} class="space-y-4">
        <div class="mb-5"><h2 id={`${category.id}-heading`} class="text-lg font-semibold">{category.title}</h2><p class="mt-1 text-sm text-muted-foreground">{category.description}</p></div>
        {#if category.id === "fleet-behavior"}<TogglePolicy id="auto-update" /><TogglePolicy id="reverse-dns" />
        {:else if category.id === "agent-behavior"}<TogglePolicy id="api-keys-in-chat" /><TogglePolicy id="remote-exec" />
        {:else if category.id === "access-control"}<AuthorizationPolicy /><TogglePolicy id="insecure-approval" />
        {:else}<div id="host-lifecycle" class="scroll-mt-24"><CleanupPolicy kind="prune-policy" /></div><CleanupPolicy kind="log-retention" />{/if}
      </section>
    {/each}
  </div>
</div>
