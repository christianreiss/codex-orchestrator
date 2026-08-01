<script lang="ts">
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { goto } from "$app/navigation";
  import { NAV_SECTIONS, isActive } from "$lib/nav";
  import { cn } from "$lib/utils/cn";
  import { authStore, authActions } from "$lib/stores/auth";
  import BrandMark from "$lib/components/brand/BrandMark.svelte";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import { Button } from "$lib/components/ui/button";
  import BookOpen from "@lucide/svelte/icons/book-open";
  import ChevronUp from "@lucide/svelte/icons/chevron-up";
  import Fingerprint from "@lucide/svelte/icons/fingerprint";
  import Keyboard from "@lucide/svelte/icons/keyboard";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import LogOut from "@lucide/svelte/icons/log-out";
  import Palette from "@lucide/svelte/icons/palette";

  function openShortcuts(): void {
    window.dispatchEvent(new CustomEvent("codex:open-shortcuts"));
  }

  const auth = $derived($authStore);
  const path = $derived(page.url.pathname.replace(base, "") || "/");

  async function signOut() {
    await authActions.logout();
    void goto(`${base}/login`);
  }
</script>

<aside
  aria-label="Fleet workspace"
  class="sidebar-surface hidden h-full w-64 shrink-0 flex-col border-r border-white/[0.07] text-[hsl(var(--sidebar-fg))] md:flex"
>
  <a
    href={`${base}/dashboard`}
    class="group flex h-[4.25rem] items-center gap-3 border-b border-white/[0.07] px-5"
    aria-label="Codex Orchestrator overview"
  >
    <BrandMark
      status
      class="shadow-pop transition-transform duration-200 group-hover:scale-[1.04]"
    />
    <div class="min-w-0">
      <div class="truncate text-sm font-semibold tracking-tight text-white">Codex Orchestrator</div>
      <div class="mt-0.5 text-[11px] font-medium uppercase tracking-[0.16em] text-white/35">
        Fleet control
      </div>
    </div>
  </a>

  <nav class="flex-1 overflow-y-auto px-3 py-4" aria-label="Primary navigation">
    <div class="space-y-5">
      {#each NAV_SECTIONS as section (section.label)}
        <section aria-labelledby={`nav-${section.label.toLowerCase()}`}>
          <h2
            id={`nav-${section.label.toLowerCase()}`}
            class="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/30"
          >
            {section.label}
          </h2>
          <ul class="space-y-1">
            {#each section.items as item (item.href)}
              {@const Icon = item.icon}
              {@const active = isActive(item, path)}
              <li>
                <a
                  href={`${base}${item.href}`}
                  class={cn(
                    "group relative flex min-h-11 items-center gap-3 overflow-hidden rounded-xl px-3 py-2 text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
                    active
                      ? "bg-white/[0.09] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_24px_rgba(0,0,0,0.12)]"
                      : "text-white/52 hover:bg-white/[0.055] hover:text-white/90",
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  {#if active}
                    <span
                      class="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-[hsl(var(--sidebar-active))] shadow-[0_0_12px_hsl(var(--sidebar-active))]"
                    ></span>
                  {/if}
                  <span
                    class={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
                      active
                        ? "bg-[hsl(var(--sidebar-active))]/15 text-[hsl(var(--sidebar-active))]"
                        : "text-white/42 group-hover:text-white/80",
                    )}
                  >
                    <Icon class="h-[17px] w-[17px]" />
                  </span>
                  <span>{item.label}</span>
                </a>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  </nav>

  <div class="border-t border-white/[0.07] p-3">
    <button
      type="button"
      onclick={openShortcuts}
      class="mb-1 flex min-h-10 w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-white/48 transition-colors hover:bg-white/[0.055] hover:text-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
    >
      <Keyboard class="h-4 w-4" />
      <span>Shortcuts</span>
      <kbd class="ml-auto rounded-md border border-white/10 bg-black/15 px-1.5 py-0.5 text-[10px] font-mono text-white/35">?</kbd>
    </button>
    <a
      href={`${base}/manual`}
      class="mb-2 flex min-h-10 items-center gap-3 rounded-xl px-3 py-2 text-sm text-white/48 transition-colors hover:bg-white/[0.055] hover:text-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
    >
      <BookOpen class="h-4 w-4" />
      <span>Help &amp; manual</span>
    </a>

    {#if auth.authenticated && auth.user}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          class="flex min-h-12 w-full items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.035] px-2.5 py-2 text-left transition-colors hover:bg-white/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <div
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-xs font-semibold text-white ring-1 ring-white/10"
          >
            {(auth.user.name ?? auth.user.username ?? "?").slice(0, 1).toUpperCase()}
          </div>
          <div class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-sm font-medium text-white">
              {auth.user.name ?? auth.user.username}
            </span>
            {#if auth.roles?.length}
              <span class="truncate text-[11px] text-white/35">{auth.roles[0].replace(/_/g, " ")}</span>
            {/if}
          </div>
          <ChevronUp class="h-4 w-4 text-white/30" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="top" align="start" class="w-60">
          <DropdownMenu.Label>Account</DropdownMenu.Label>
          <DropdownMenu.Item onclick={() => goto(`${base}/account/password`)}>
            <KeyRound class="h-4 w-4" />
            Password
          </DropdownMenu.Item>
          <DropdownMenu.Item onclick={() => goto(`${base}/account/passkeys`)}>
            <Fingerprint class="h-4 w-4" />
            Passkeys
          </DropdownMenu.Item>
          <DropdownMenu.Item onclick={() => goto(`${base}/account/theme`)}>
            <Palette class="h-4 w-4" />
            Appearance
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item onclick={signOut}>
            <LogOut class="h-4 w-4" />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {:else if auth.enforced}
      <Button variant="outline" href={`${base}/login`} class="w-full border-white/15 bg-white/5 text-white hover:bg-white/10">
        Sign in
      </Button>
    {/if}
  </div>
</aside>
