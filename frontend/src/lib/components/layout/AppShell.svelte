<script lang="ts">
  import type { Snippet } from "svelte";
  import Sidebar from "./Sidebar.svelte";
  import MobileNav from "./MobileNav.svelte";
  import TopBar from "./TopBar.svelte";

  let { children }: { children?: Snippet } = $props();
</script>

<a class="skip-link" href="#main-content">Skip to content</a>

<div class="flex h-full min-h-0 w-full bg-background">
  <Sidebar />
  <div class="flex min-w-0 flex-1 flex-col">
    <TopBar />
    <main
      id="main-content"
      tabindex="-1"
      class="app-main min-h-0 flex-1 overflow-y-auto px-4 pt-6 focus:outline-none sm:px-6 md:px-8 md:pt-8"
    >
      <div class="mx-auto w-full max-w-[1600px]">
        {@render children?.()}
      </div>
    </main>
  </div>
  <MobileNav />
</div>
