<script lang="ts">
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { goto } from "$app/navigation";
  import { MOBILE_NAV_PRIMARY, MOBILE_NAV_OVERFLOW, isActive } from "$lib/nav";
  import { cn } from "$lib/utils/cn";
  import { authStore, authActions } from "$lib/stores/auth";
  import * as Sheet from "$lib/components/ui/sheet";
  import BookOpen from "@lucide/svelte/icons/book-open";
  import Fingerprint from "@lucide/svelte/icons/fingerprint";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import LogOut from "@lucide/svelte/icons/log-out";
  import Menu from "@lucide/svelte/icons/menu";
  import Palette from "@lucide/svelte/icons/palette";

  const path = $derived(page.url.pathname.replace(base, "") || "/");
  const auth = $derived($authStore);
  let menuOpen = $state(false);

  async function signOut() {
    menuOpen = false;
    await authActions.logout();
    void goto(`${base}/login`);
  }
</script>

<nav
  class="fixed inset-x-0 bottom-0 z-40 border-t border-border/80 bg-background/90 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_32px_rgba(15,23,42,0.06)] backdrop-blur-xl md:hidden"
  aria-label="Mobile primary navigation"
>
  <ul class="grid h-[4.5rem] grid-cols-5 px-1">
    {#each MOBILE_NAV_PRIMARY as item (item.href)}
      {@const Icon = item.icon}
      {@const active = isActive(item, path)}
      <li>
        <a
          href={`${base}${item.href}`}
          class={cn(
            "relative flex h-full min-w-0 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            active ? "text-primary" : "text-muted-foreground hover:text-foreground",
          )}
          aria-current={active ? "page" : undefined}
        >
          {#if active}
            <span class="absolute top-1.5 h-1 w-1 rounded-full bg-primary"></span>
          {/if}
          <Icon class="h-5 w-5" strokeWidth={active ? 2.25 : 1.8} />
          <span class="max-w-full truncate px-1">{item.label}</span>
        </a>
      </li>
    {/each}
    <li>
      <button
        type="button"
        class="flex h-full w-full flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onclick={() => (menuOpen = true)}
        aria-label="Open navigation menu"
        aria-expanded={menuOpen}
      >
        <Menu class="h-5 w-5" />
        <span>Menu</span>
      </button>
    </li>
  </ul>
</nav>

<Sheet.Root bind:open={menuOpen}>
  <Sheet.Content
    side="bottom"
    class="max-h-[86vh] overflow-y-auto rounded-t-3xl border-x border-t bg-background px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-5"
  >
    <Sheet.Header class="text-left">
      <Sheet.Title>Navigation</Sheet.Title>
      <Sheet.Description>Operations, administration, and account controls.</Sheet.Description>
    </Sheet.Header>

    <div class="mt-5 space-y-5">
      <section>
        <h2 class="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Workspace
        </h2>
        <ul class="grid gap-2 sm:grid-cols-2">
          {#each MOBILE_NAV_OVERFLOW as item (item.href)}
            {@const Icon = item.icon}
            {@const active = isActive(item, path)}
            <li>
              <a
                href={`${base}${item.href}`}
                class={cn(
                  "flex min-h-14 items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors",
                  active
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-border/70 bg-card text-foreground hover:bg-accent",
                )}
                onclick={() => (menuOpen = false)}
                aria-current={active ? "page" : undefined}
              >
                <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
                  <Icon class="h-4 w-4" />
                </span>
                <span class="min-w-0">
                  <span class="block text-sm font-medium">{item.label}</span>
                  <span class="block truncate text-[11px] text-muted-foreground">{item.description}</span>
                </span>
              </a>
            </li>
          {/each}
          <li>
            <a
              href={`${base}/manual`}
              class="flex min-h-14 items-center gap-3 rounded-xl border border-border/70 bg-card px-3 py-2.5 transition-colors hover:bg-accent"
              onclick={() => (menuOpen = false)}
            >
              <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
                <BookOpen class="h-4 w-4" />
              </span>
              <span class="min-w-0">
                <span class="block text-sm font-medium">Help &amp; manual</span>
                <span class="block truncate text-[11px] text-muted-foreground">Operator documentation</span>
              </span>
            </a>
          </li>
        </ul>
      </section>

      {#if auth.authenticated && auth.user}
        <section>
          <h2 class="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {auth.user.name ?? auth.user.username ?? "Account"}
          </h2>
          <div class="overflow-hidden rounded-xl border border-border/70 bg-card">
            <a href={`${base}/account/password`} class="flex min-h-12 items-center gap-3 border-b px-4 text-sm hover:bg-accent" onclick={() => (menuOpen = false)}>
              <KeyRound class="h-4 w-4 text-muted-foreground" /> Password
            </a>
            <a href={`${base}/account/passkeys`} class="flex min-h-12 items-center gap-3 border-b px-4 text-sm hover:bg-accent" onclick={() => (menuOpen = false)}>
              <Fingerprint class="h-4 w-4 text-muted-foreground" /> Passkeys
            </a>
            <a href={`${base}/account/theme`} class="flex min-h-12 items-center gap-3 border-b px-4 text-sm hover:bg-accent" onclick={() => (menuOpen = false)}>
              <Palette class="h-4 w-4 text-muted-foreground" /> Appearance
            </a>
            <button type="button" class="flex min-h-12 w-full items-center gap-3 px-4 text-left text-sm text-destructive hover:bg-destructive/10" onclick={signOut}>
              <LogOut class="h-4 w-4" /> Sign out
            </button>
          </div>
        </section>
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>
