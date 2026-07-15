<script lang="ts">
  import type { Snippet } from "svelte";
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import Sidebar from "./Sidebar.svelte";
  import MobileNav from "./MobileNav.svelte";
  import TopBar from "./TopBar.svelte";

  let { children }: { children?: Snippet } = $props();
  const path = $derived(page.url.pathname.replace(base, "") || "/");
</script>

<a class="skip-link" href="#main-content">Skip to content</a>

<div class="flex h-full min-h-0 w-full bg-background">
  <Sidebar />
  <div class="flex min-w-0 flex-1 flex-col">
    <TopBar />
    <main
      id="main-content"
      tabindex="-1"
      class="app-main min-h-0 flex-1 overflow-y-auto px-4 pb-28 pt-6 focus:outline-none sm:px-6 md:px-8 md:pb-12 md:pt-8"
    >
      <div class="mx-auto w-full max-w-[1440px]">
        {#key path}
          <div class="page-enter">
            {@render children?.()}
          </div>
        {/key}
      </div>
    </main>
  </div>
  <MobileNav />
</div>
