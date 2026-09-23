<script lang="ts">
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { goto } from "$app/navigation";
  import { MOBILE_NAV_OVERFLOW, MOBILE_NAV_PRIMARY, NAV_FOOTER, NAV_SECTIONS, isActive } from "$lib/nav";
  import { cn } from "$lib/utils/cn";
  import { authActions, authStore } from "$lib/stores/auth";
  import * as Sheet from "$lib/components/ui/sheet";
  import InsecureApprovalsNavAlert from "./InsecureApprovalsNavAlert.svelte";
  import { insecureApprovalsPendingQuery } from "$lib/api/overview";
  import Menu from "@lucide/svelte/icons/menu";
  import LogOut from "@lucide/svelte/icons/log-out";
  import Keyboard from "@lucide/svelte/icons/keyboard";

  const path = $derived(page.url.pathname.replace(base, "") || "/");
  const auth = $derived($authStore);
  let menuOpen = $state(false);
  const pendingApprovals = insecureApprovalsPendingQuery();
  const approvalsAlert = $derived(($pendingApprovals.data?.requests?.length ?? 0) > 0 || $pendingApprovals.isError);
  const menuActive = $derived(MOBILE_NAV_OVERFLOW.some((item) => isActive(item, path)));
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

<nav class="fixed inset-x-0 bottom-0 z-40 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="Mobile primary navigation">
  <ul class="grid h-16 grid-cols-5 gap-1 px-2 py-1">
    {#each MOBILE_NAV_PRIMARY as item (item.id)}
      {@const Icon = item.icon}
      {@const active = isActive(item, path)}
      <li>
        <a href={`${base}${item.route}`} class={cn("flex h-full min-w-0 flex-col items-center justify-center gap-1 rounded-md text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")} aria-current={active ? "page" : undefined}>
          <Icon class="h-5 w-5" /> <span class="max-w-full truncate px-1">{item.label}</span>
        </a>
      </li>
    {/each}
    <li>
      <button type="button" class={cn("flex h-full w-full flex-col items-center justify-center gap-1 rounded-md text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", menuActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")} onclick={() => (menuOpen = true)} aria-label={approvalsAlert ? "Open navigation menu (insecure approvals need attention)" : "Open navigation menu"} aria-expanded={menuOpen} aria-current={menuActive ? "true" : undefined}>
        <span class="relative"><Menu class="h-5 w-5" />{#if approvalsAlert}<span class="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-warning ring-2 ring-card" aria-hidden="true"></span>{/if}</span> <span>Menu</span>
      </button>
    </li>
  </ul>
</nav>

<Sheet.Root bind:open={menuOpen}>
  <Sheet.Content side="bottom" class="max-h-[86dvh] overflow-y-auto overscroll-contain rounded-t-lg border-x border-t bg-background px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-5">
    <Sheet.Header class="text-left"><Sheet.Title>Navigation</Sheet.Title><Sheet.Description>Control, coordinate, and sync Codex &amp; Claude.</Sheet.Description></Sheet.Header>
    <div class="mt-4 space-y-4">
      <InsecureApprovalsNavAlert variant="sheet" onnavigate={() => (menuOpen = false)} />
      {#each menuSections as section (section.id)}
        <section>
          <h2 class="mb-1 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{section.label}</h2>
          <ul class="grid gap-1 sm:grid-cols-2">
            {#each section.items as item (item.id)}
              {@const Icon = item.icon}
              {@const active = isActive(item, path)}
              <li><a href={`${base}${item.route}`} class={cn("flex min-h-14 items-center gap-3 rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active ? "border-primary/30 bg-primary/10 text-primary" : "bg-card hover:bg-muted")} onclick={() => (menuOpen = false)} aria-current={active ? "page" : undefined}><Icon class="h-4 w-4 shrink-0" /><span class="min-w-0"><span class="block font-medium">{item.label}</span><span class="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{item.description}</span></span></a></li>
            {/each}
          </ul>
        </section>
      {/each}
      <button type="button" class="flex min-h-11 w-full items-center gap-3 rounded-md border bg-card px-3 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onclick={() => { menuOpen = false; window.dispatchEvent(new CustomEvent("codex:open-shortcuts")); }}>
        <Keyboard class="h-4 w-4" /> Keyboard shortcuts <kbd class="keyboard-key ml-auto">?</kbd>
      </button>
      {#if auth.authenticated && auth.user}
        <section class="border-t pt-3">
          <p class="mb-1 px-1 text-xs text-muted-foreground">{auth.user.name ?? auth.user.username}</p>
          <div class="grid grid-cols-2 gap-2">
            <a href={`${base}/account/password`} class="flex min-h-11 items-center justify-center rounded-md border bg-card px-2 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onclick={() => (menuOpen = false)}>Password</a>
            <a href={`${base}/account/passkeys`} class="flex min-h-11 items-center justify-center rounded-md border bg-card px-2 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onclick={() => (menuOpen = false)}>Passkeys</a>
            <a href={`${base}/account/theme`} class="flex min-h-11 items-center justify-center rounded-md border bg-card px-2 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onclick={() => (menuOpen = false)}>Appearance</a>
            <button type="button" class="flex min-h-11 items-center justify-center gap-2 rounded-md border bg-card px-2 text-xs text-destructive outline-none hover:bg-destructive-muted focus-visible:ring-2 focus-visible:ring-ring" onclick={signOut}><LogOut class="h-3.5 w-3.5" />Sign out</button>
          </div>
        </section>
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>
