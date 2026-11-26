<script lang="ts">
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { goto } from "$app/navigation";
  import { tick } from "svelte";
  import { NAV_FOOTER, NAV_SECTIONS, isActive } from "$lib/nav";
  import { ACCOUNT_LINKS } from "./account-links";
  import { cn } from "$lib/utils/cn";
  import { authStore } from "$lib/stores/auth";
  import { signOut } from "$lib/auth/sign-out";
  import { themeStore } from "$lib/stores/theme";
  import BrandMark from "$lib/components/brand/BrandMark.svelte";
  import InsecureApprovalsNavAlert from "./InsecureApprovalsNavAlert.svelte";
  import { fleetDisabledTitle, useFleetEngines } from "$lib/engines/fleet-engines";
  import { engineLabel } from "$lib/constants/engines";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
  import Keyboard from "@lucide/svelte/icons/keyboard";
  import LogOut from "@lucide/svelte/icons/log-out";
  import Monitor from "@lucide/svelte/icons/monitor";
  import Moon from "@lucide/svelte/icons/moon";
  import Sun from "@lucide/svelte/icons/sun";
  import type { AppearanceControl } from "./appearance.svelte";

  let { appearance }: { appearance: AppearanceControl } = $props();

  const path = $derived(page.url.pathname.replace(base, "") || "/");
  const auth = $derived($authStore);
  // Engine-specific pages stay listed while their engine is off; the entry says so.
  const fleet = useFleetEngines();

  // The registry's utility pages live in the account menu rather than as a
  // row of unlabeled icons; Appearance is the menu's own radio group.
  const accountPage = NAV_FOOTER.find((item) => item.id === "account");
  const manualPage = NAV_FOOTER.find((item) => item.id === "manual");
  const accountSections = ACCOUNT_LINKS.filter((link) => link.hash !== "#appearance");

  const displayName = $derived(auth.user ? (auth.user.name ?? auth.user.username ?? "?") : "");
  const initials = $derived(
    displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0]!)
      .join("")
      .toUpperCase() || "?",
  );

  // A hub's pages can push the current one below the fold of a short rail;
  // keep it in view (only the nav scrolls, never the page).
  let nav = $state<HTMLElement>();
  $effect(() => {
    void path;
    void tick().then(() => nav?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" }));
  });

  function openShortcuts(): void {
    // After the menu has closed and returned focus, so the dialog keeps it.
    setTimeout(() => window.dispatchEvent(new CustomEvent("codex:open-shortcuts")), 0);
  }

  // One row geometry for hubs and pages: at least 32 px, 16 px glyph, 8 px gaps.
  const row = "flex min-h-8 items-center gap-2 rounded px-2 py-1.5 text-body-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring md:max-lg:justify-center md:max-lg:px-0";
</script>

<Tooltip.Provider>
<aside aria-label="Fleet workspace" class="sidebar-surface hidden h-full shrink-0 flex-col border-r md:flex md:w-14 lg:w-64">
  <!-- 48 px like the top bar, so both rules meet in one line. -->
  <a href={`${base}/dashboard`} class="flex min-h-12 shrink-0 items-center gap-3 border-b px-3 outline-none md:max-lg:justify-center md:max-lg:px-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" aria-label="Codex Orchestrator overview">
    <BrandMark class="h-8 w-8 shrink-0 rounded-md" />
    <span class="min-w-0 md:max-lg:hidden">
      <span class="block break-words text-body font-semibold leading-tight tracking-tight text-foreground">Codex Orchestrator</span>
      <span class="block break-words text-caption leading-tight text-muted-foreground">Multi-engine fleet console</span>
    </span>
  </a>

  <nav bind:this={nav} class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 md:max-lg:px-2" aria-label="Primary navigation">
    <div class="space-y-4">
      <InsecureApprovalsNavAlert />
      {#each NAV_SECTIONS as section (section.id)}
        <section aria-labelledby={`nav-${section.id}`} class="md:max-lg:[&:not(:first-of-type)]:border-t md:max-lg:[&:not(:first-of-type)]:pt-4">
          <h2 id={`nav-${section.id}`} class="mb-1 px-2 text-caption font-medium text-muted-foreground md:max-lg:sr-only">
            {section.label}
          </h2>
          <ul class="space-y-0.5">
            {#each section.hubs as hub (hub.id)}
              {@const Icon = hub.icon}
              {@const active = isActive(hub, path)}
              {@const pages = active && hub.items.length > 1 ? hub.items : []}
              <li>
                <Tooltip.Root>
                <Tooltip.Trigger>
                {#snippet child({ props })}<a
                  {...props}
                  href={`${base}${hub.route}`}
                  class={cn(
                    row,
                    "font-medium",
                    // The current page is the one filled row. A hub that lists
                    // its pages is the section they sit in: signal blue, unfilled.
                    active && !pages.length && "bg-primary/15 text-primary",
                    active && pages.length > 0 && "text-primary hover:bg-muted",
                    !active && "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                  aria-current={active ? (pages.length ? "true" : "page") : undefined}
                  title={`${hub.label}: ${hub.description}`}
                >
                  <Icon class="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span class="min-w-0 break-words md:max-lg:sr-only">{hub.label}</span>
                </a>{/snippet}
                </Tooltip.Trigger>
                <Tooltip.Content side="right" class="max-w-64 lg:hidden">{hub.label} · {hub.description}</Tooltip.Content>
                </Tooltip.Root>
                {#if pages.length}
                  <!-- The active hub's peers: the one place a page's siblings are listed (NAV-4).
                       Labels align with the hub label; the guide line runs through the hub icon. -->
                  <ul class="relative mt-0.5 space-y-0.5 pl-6 before:absolute before:inset-y-1 before:left-4 before:w-px before:bg-border md:max-lg:mt-1 md:max-lg:rounded md:max-lg:bg-muted md:max-lg:py-1 md:max-lg:pl-0 md:max-lg:before:hidden" aria-label={`${hub.label} pages`}>
                    {#each pages as item (item.id)}
                      {@const PageIcon = item.icon}
                      {@const current = isActive(item, path)}
                      {@const off = item.engine && !$fleet.isEnabled(item.engine)}
                      <li>
                        <Tooltip.Root>
                        <Tooltip.Trigger>
                        {#snippet child({ props })}<a
                          {...props}
                          href={`${base}${item.route}`}
                          class={cn(row, current ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")}
                          aria-current={current ? "page" : undefined}
                          title={item.description}
                        >
                          <PageIcon class="h-4 w-4 shrink-0 lg:hidden" aria-hidden="true" />
                          <span class="min-w-0 break-words md:max-lg:sr-only">{item.label}</span>
                          {#if off}<span class="ml-auto shrink-0 text-caption md:max-lg:sr-only" title={fleetDisabledTitle(engineLabel(item.engine!))}>Off</span>{/if}
                        </a>{/snippet}
                        </Tooltip.Trigger>
                        <Tooltip.Content side="right" class="max-w-64 lg:hidden">{item.label} · {item.description}</Tooltip.Content>
                        </Tooltip.Root>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  </nav>

  {#if auth.authenticated && auth.user}
    <!-- One row: who is signed in, and one menu for everything about them. -->
    <div class="shrink-0 border-t px-3 py-2 md:max-lg:px-2">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger class="flex min-h-9 w-full items-center gap-2 rounded px-1 py-1 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted md:max-lg:justify-center md:max-lg:px-0" aria-label={`Account menu for ${displayName}`}>
          <span class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-muted text-caption font-semibold text-foreground ring-1 ring-inset ring-border" aria-hidden="true">{initials}</span>
          <span class="min-w-0 flex-1 break-words text-body-sm font-medium text-foreground md:max-lg:hidden">{displayName}</span>
          <ChevronsUpDown class="h-4 w-4 shrink-0 text-muted-foreground md:max-lg:hidden" aria-hidden="true" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="top" align="start" class="w-60">
          <div class="flex items-center gap-2 px-2 py-1.5">
            <span class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-muted text-caption font-semibold" aria-hidden="true">{initials}</span>
            <span class="min-w-0">
              <span class="block break-words text-body-sm font-medium">{displayName}</span>
              {#if auth.user.username && auth.user.username !== displayName}<span class="block break-words text-caption text-muted-foreground">{auth.user.username}</span>{/if}
            </span>
          </div>
          <DropdownMenu.Separator />
          {#if accountPage}
            {@const AccountIcon = accountPage.icon}
            <DropdownMenu.Item onSelect={() => goto(`${base}${accountPage.route}`)}><AccountIcon class="h-4 w-4 text-muted-foreground" aria-hidden="true" />{accountPage.label}</DropdownMenu.Item>
          {/if}
          {#each accountSections as link (link.hash)}
            {@const LinkIcon = link.icon}
            <DropdownMenu.Item onSelect={() => goto(`${base}/account${link.hash}`)}><LinkIcon class="h-4 w-4 text-muted-foreground" aria-hidden="true" />{link.label}</DropdownMenu.Item>
          {/each}
          <DropdownMenu.Separator />
          <DropdownMenu.Group>
            <DropdownMenu.Label class="text-caption font-medium text-muted-foreground">Appearance</DropdownMenu.Label>
            <DropdownMenu.RadioGroup value={$themeStore} onValueChange={(value) => appearance.choose(value)} aria-label="Appearance">
              <DropdownMenu.RadioItem value="light" disabled={appearance.pending}><Sun class="h-4 w-4 text-muted-foreground" aria-hidden="true" />Light</DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem value="dark" disabled={appearance.pending}><Moon class="h-4 w-4 text-muted-foreground" aria-hidden="true" />Dark</DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem value="system" disabled={appearance.pending}><Monitor class="h-4 w-4 text-muted-foreground" aria-hidden="true" />System</DropdownMenu.RadioItem>
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Group>
          <DropdownMenu.Separator />
          {#if manualPage}
            {@const ManualIcon = manualPage.icon}
            <DropdownMenu.Item onSelect={() => goto(`${base}${manualPage.route}`)}><ManualIcon class="h-4 w-4 text-muted-foreground" aria-hidden="true" />{manualPage.label}</DropdownMenu.Item>
          {/if}
          <DropdownMenu.Item onSelect={openShortcuts} aria-keyshortcuts="?"><Keyboard class="h-4 w-4 text-muted-foreground" aria-hidden="true" />Keyboard shortcuts<kbd class="keyboard-key ml-auto" aria-hidden="true">?</kbd></DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={signOut}><LogOut class="h-4 w-4 text-muted-foreground" aria-hidden="true" />Sign out</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  {/if}
</aside>
</Tooltip.Provider>
