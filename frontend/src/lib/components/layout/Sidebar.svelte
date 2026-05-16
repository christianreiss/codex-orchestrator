<script lang="ts">
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { NAV, isActive } from "$lib/nav";
  import { cn } from "$lib/utils/cn";
  import { authStore, authActions } from "$lib/stores/auth";
  import { goto } from "$app/navigation";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import { Button } from "$lib/components/ui/button";
  import BookOpen from "@lucide/svelte/icons/book-open";
  import LogOut from "@lucide/svelte/icons/log-out";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import Fingerprint from "@lucide/svelte/icons/fingerprint";

  const auth = $derived($authStore);
  const path = $derived(page.url.pathname.replace(base, "") || "/");

  async function signOut() {
    await authActions.logout();
    void goto(`${base}/login`);
  }
</script>

<aside
  class="hidden h-full w-60 shrink-0 flex-col border-r border-gray-800 bg-[hsl(var(--sidebar-bg))] text-[hsl(var(--sidebar-fg))] md:flex"
>
  <div class="flex h-16 items-center gap-3 border-b border-gray-800 px-5">
    <div
      class="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500 font-bold text-white"
      aria-hidden="true"
    >
      C
    </div>
    <span class="font-semibold tracking-tight text-white">Orchestrator</span>
  </div>

  <nav class="flex-1 overflow-y-auto p-3" aria-label="Primary">
    <ul class="space-y-1">
      {#each NAV as item (item.href)}
        {@const Icon = item.icon}
        {@const active = isActive(item, path)}
        <li>
          <a
            href={`${base}${item.href}`}
            class={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-[hsl(var(--sidebar-active))] text-white shadow-sm"
                : "text-gray-400 hover:bg-gray-800 hover:text-white",
            )}
            aria-current={active ? "page" : undefined}
          >
            <Icon class="h-4 w-4" />
            <span>{item.label}</span>
          </a>
        </li>
      {/each}
    </ul>
  </nav>

  <div class="border-t border-gray-800 p-3">
    <a
      href={`${base}/manual`}
      class="mb-2 flex items-center gap-3 rounded-md px-3 py-2 text-sm text-gray-400 transition-colors hover:bg-gray-800 hover:text-white"
    >
      <BookOpen class="h-4 w-4" />
      <span>Help &amp; Manual</span>
    </a>
    {#if auth.authenticated && auth.user}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          class="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-gray-800"
        >
          <div
            class="flex h-8 w-8 items-center justify-center rounded-full bg-gray-700 text-xs font-semibold text-white"
          >
            {(auth.user.name ?? auth.user.username ?? "?").slice(0, 1).toUpperCase()}
          </div>
          <div class="flex min-w-0 flex-col">
            <span class="truncate text-sm text-white">
              {auth.user.name ?? auth.user.username}
            </span>
            {#if auth.roles?.length}
              <span class="truncate text-xs text-gray-500">{auth.roles[0]}</span>
            {/if}
          </div>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="top" align="start" class="w-56">
          <DropdownMenu.Item onclick={() => goto(`${base}/account/password`)}>
            <KeyRound class="h-4 w-4" />
            Change password
          </DropdownMenu.Item>
          <DropdownMenu.Item onclick={() => goto(`${base}/account/passkeys`)}>
            <Fingerprint class="h-4 w-4" />
            Passkeys
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item onclick={signOut}>
            <LogOut class="h-4 w-4" />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {:else if auth.enforced}
      <Button variant="outline" href={`${base}/login`} class="w-full">Sign in</Button>
    {/if}
  </div>
</aside>
