<script lang="ts">
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { MOBILE_NAV_PRIMARY, MOBILE_NAV_OVERFLOW, isActive } from "$lib/nav";
  import { cn } from "$lib/utils/cn";
  import * as Sheet from "$lib/components/ui/sheet";
  import MoreHorizontal from "@lucide/svelte/icons/more-horizontal";

  const path = $derived(page.url.pathname.replace(base, "") || "/");
  let overflowOpen = $state(false);
</script>

<nav
  class="fixed bottom-0 left-0 right-0 z-40 h-16 border-t border-gray-800 bg-gray-900 text-gray-400 md:hidden"
  aria-label="Mobile primary"
>
  <ul class="grid h-full grid-cols-6">
    {#each MOBILE_NAV_PRIMARY as item (item.href)}
      {@const Icon = item.icon}
      {@const active = isActive(item, path)}
      <li class="col-span-1">
        <a
          href={`${base}${item.href}`}
          class={cn(
            "flex h-full flex-col items-center justify-center gap-1 text-[11px]",
            active ? "text-white" : "text-gray-400 hover:text-white",
          )}
          aria-current={active ? "page" : undefined}
        >
          <Icon class="h-5 w-5" />
          <span>{item.label}</span>
        </a>
      </li>
    {/each}
    <li class="col-span-1">
      <button
        type="button"
        class="flex h-full w-full flex-col items-center justify-center gap-1 text-[11px] text-gray-400 hover:text-white"
        onclick={() => (overflowOpen = true)}
        aria-label="More"
      >
        <MoreHorizontal class="h-5 w-5" />
        <span>More</span>
      </button>
    </li>
  </ul>
</nav>

<Sheet.Root bind:open={overflowOpen}>
  <Sheet.Content side="right" class="bg-gray-900 text-white">
    <Sheet.Header>
      <Sheet.Title class="text-white">More</Sheet.Title>
    </Sheet.Header>
    <ul class="mt-4 space-y-1">
      {#each MOBILE_NAV_OVERFLOW as item (item.href)}
        {@const Icon = item.icon}
        {@const active = isActive(item, path)}
        <li>
          <a
            href={`${base}${item.href}`}
            class={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-[hsl(var(--sidebar-active))] text-white"
                : "text-gray-400 hover:bg-gray-800 hover:text-white",
            )}
            onclick={() => (overflowOpen = false)}
          >
            <Icon class="h-4 w-4" />
            <span>{item.label}</span>
          </a>
        </li>
      {/each}
    </ul>
  </Sheet.Content>
</Sheet.Root>
