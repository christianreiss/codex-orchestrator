<script lang="ts">
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { goto } from "$app/navigation";
  import { NAV_FOOTER, NAV_SECTIONS, isActive } from "$lib/nav";
  import { cn } from "$lib/utils/cn";
  import { authActions, authStore } from "$lib/stores/auth";
  import BrandMark from "$lib/components/brand/BrandMark.svelte";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Keyboard from "@lucide/svelte/icons/keyboard";
  import LogOut from "@lucide/svelte/icons/log-out";

  const path = $derived(page.url.pathname.replace(base, "") || "/");
  const auth = $derived($authStore);

  // Only the group containing the current route starts expanded; others stay
  // as headers. Groups the user opens manually stay open across navigation.
  let openGroups = $state<Record<string, boolean>>(
    Object.fromEntries(NAV_SECTIONS.map((s) => [s.id, s.items.some((i) => isActive(i, path))])),
  );

  $effect(() => {
    const activeSection = NAV_SECTIONS.find((s) => s.items.some((i) => isActive(i, path)));
    if (activeSection && !openGroups[activeSection.id]) openGroups[activeSection.id] = true;
  });

  function openShortcuts(): void {
    window.dispatchEvent(new CustomEvent("codex:open-shortcuts"));
  }

  async function signOut() {
    await authActions.logout();
    void goto(`${base}/login`);
  }
</script>

<aside aria-label="Fleet workspace" class="sidebar-surface hidden h-full w-60 shrink-0 flex-col border-r md:flex">
  <a href={`${base}/dashboard`} class="flex h-14 items-center gap-2.5 border-b px-4" aria-label="Codex Orchestrator overview">
    <BrandMark status class="h-7 w-7 rounded-md" />
    <span class="truncate text-sm font-semibold tracking-tight">Codex Orchestrator</span>
  </a>

  <nav class="flex-1 overflow-y-auto px-2 py-3" aria-label="Primary navigation">
    <div class="space-y-4">
      {#each NAV_SECTIONS as section (section.id)}
        <section aria-labelledby={`nav-${section.id}`}>
          <Collapsible.Root bind:open={openGroups[section.id]}>
            <h2 id={`nav-${section.id}`}>
              <Collapsible.Trigger class="w-full">
                {#snippet child({ props })}
                  <button
                    {...props}
                    type="button"
                    class="group flex h-7 w-full items-center justify-between rounded-md px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {section.label}
                    <ChevronDown class="h-3 w-3 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
                  </button>
                {/snippet}
              </Collapsible.Trigger>
            </h2>
            <Collapsible.Content>
              <ul class="space-y-0.5 pt-1">
                {#each section.items as item (item.id)}
                  {@const Icon = item.icon}
                  {@const active = isActive(item, path)}
                  <li>
                    <a
                      href={`${base}${item.route}`}
                      class={cn(
                        "flex h-9 items-center gap-2 rounded-md px-2 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                        active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                      aria-current={active ? "page" : undefined}
                    >
                      <Icon class="h-4 w-4 shrink-0" />
                      <span class="truncate">{item.label}</span>
                    </a>
                  </li>
                {/each}
              </ul>
            </Collapsible.Content>
          </Collapsible.Root>
        </section>
      {/each}
    </div>
  </nav>

  <div class="border-t p-2">
    {#each NAV_FOOTER as item (item.id)}
      {@const Icon = item.icon}
      {@const active = isActive(item, path)}
      <a
        href={`${base}${item.route}`}
        class={cn("mb-0.5 flex h-9 items-center gap-2 rounded-md px-2 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")}
        aria-current={active ? "page" : undefined}
      >
        <Icon class="h-4 w-4" /> {item.label}
      </a>
    {/each}
    <button type="button" onclick={openShortcuts} class="mb-1 flex h-9 w-full items-center gap-2 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Keyboard class="h-4 w-4" /> Shortcuts <kbd class="ml-auto text-[10px]">?</kbd>
    </button>
    {#if auth.authenticated && auth.user}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger class="flex h-10 w-full items-center gap-2 rounded-md border bg-card px-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span class="grid h-6 w-6 place-items-center rounded bg-muted text-xs font-semibold">{(auth.user.name ?? auth.user.username ?? "?").slice(0, 1).toUpperCase()}</span>
          <span class="min-w-0 flex-1 truncate">{auth.user.name ?? auth.user.username}</span>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="top" align="start" class="w-52">
          <DropdownMenu.Item onclick={() => goto(`${base}/account/password`)}>Password</DropdownMenu.Item>
          <DropdownMenu.Item onclick={() => goto(`${base}/account/passkeys`)}>Passkeys</DropdownMenu.Item>
          <DropdownMenu.Item onclick={() => goto(`${base}/account/theme`)}>Appearance</DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item onclick={signOut}><LogOut class="h-4 w-4" /> Sign out</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/if}
  </div>
</aside>
