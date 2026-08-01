<script lang="ts">
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { goto } from "$app/navigation";
  import { MOBILE_NAV_OVERFLOW, MOBILE_NAV_PRIMARY, NAV_FOOTER, NAV_SECTIONS, isActive } from "$lib/nav";
  import { cn } from "$lib/utils/cn";
  import { authActions, authStore } from "$lib/stores/auth";
  import * as Sheet from "$lib/components/ui/sheet";
  import Menu from "@lucide/svelte/icons/menu";
  import LogOut from "@lucide/svelte/icons/log-out";

  const path = $derived(page.url.pathname.replace(base, "") || "/");
  const auth = $derived($authStore);
  let menuOpen = $state(false);
  const menuSections = $derived([
    ...NAV_SECTIONS.map((section) => ({ ...section, items: section.items.filter((item) => MOBILE_NAV_OVERFLOW.includes(item)) })).filter((section) => section.items.length),
    { id: "utilities", label: "Utilities" as const, items: NAV_FOOTER },
  ]);

  async function signOut() {
    menuOpen = false;
    await authActions.logout();
    void goto(`${base}/login`);
  }
</script>

<nav class="fixed inset-x-0 bottom-0 z-40 border-t bg-background md:hidden" aria-label="Mobile primary navigation">
  <ul class="grid h-16 grid-cols-5 px-1">
    {#each MOBILE_NAV_PRIMARY as item (item.id)}
      {@const Icon = item.icon}
      {@const active = isActive(item, path)}
      <li>
        <a href={`${base}${item.route}`} class={cn("flex h-full min-w-0 flex-col items-center justify-center gap-1 rounded-md text-[10px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active ? "text-primary" : "text-muted-foreground")} aria-current={active ? "page" : undefined}>
          <Icon class="h-5 w-5" /> <span class="max-w-full truncate px-1">{item.label}</span>
        </a>
      </li>
    {/each}
    <li>
      <button type="button" class="flex h-full w-full flex-col items-center justify-center gap-1 rounded-md text-[10px] font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onclick={() => (menuOpen = true)} aria-label="Open navigation menu" aria-expanded={menuOpen}>
        <Menu class="h-5 w-5" /> <span>Menu</span>
      </button>
    </li>
  </ul>
</nav>

<Sheet.Root bind:open={menuOpen}>
  <Sheet.Content side="bottom" class="max-h-[86vh] overflow-y-auto rounded-t-lg border-x border-t bg-background px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4">
    <Sheet.Header class="text-left"><Sheet.Title>Navigation</Sheet.Title><Sheet.Description>Every fleet task is one destination away.</Sheet.Description></Sheet.Header>
    <div class="mt-4 space-y-4">
      {#each menuSections as section (section.id)}
        <section>
          <h2 class="mb-1 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{section.label}</h2>
          <ul class="grid gap-1 sm:grid-cols-2">
            {#each section.items as item (item.id)}
              {@const Icon = item.icon}
              {@const active = isActive(item, path)}
              <li><a href={`${base}${item.route}`} class={cn("flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active ? "border-primary/30 bg-primary/10 text-primary" : "bg-card hover:bg-muted")} onclick={() => (menuOpen = false)} aria-current={active ? "page" : undefined}><Icon class="h-4 w-4" /><span class="min-w-0"><span class="block font-medium">{item.label}</span><span class="block truncate text-xs text-muted-foreground">{item.description}</span></span></a></li>
            {/each}
          </ul>
        </section>
      {/each}
      {#if auth.authenticated && auth.user}
        <section class="border-t pt-3">
          <p class="mb-1 px-1 text-xs text-muted-foreground">{auth.user.name ?? auth.user.username}</p>
          <div class="grid grid-cols-3 gap-1"><a href={`${base}/account/passkeys`} class="rounded-md border px-2 py-2 text-center text-xs" onclick={() => (menuOpen = false)}>Passkeys</a><a href={`${base}/account/theme`} class="rounded-md border px-2 py-2 text-center text-xs" onclick={() => (menuOpen = false)}>Appearance</a><button type="button" class="rounded-md border px-2 py-2 text-xs text-destructive" onclick={signOut}><LogOut class="mr-1 inline h-3.5 w-3.5" />Sign out</button></div>
        </section>
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>
