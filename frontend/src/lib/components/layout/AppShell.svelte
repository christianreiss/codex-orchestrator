<script lang="ts">
  import type { Snippet } from "svelte";
  import Sidebar from "./Sidebar.svelte";
  import MobileNav from "./MobileNav.svelte";
  import TopBar from "./TopBar.svelte";

  let { children, activeWindows = 0 }: { children?: Snippet; activeWindows?: number } = $props();
</script>

<div class="flex h-full w-full">
  <Sidebar />
  <div class="flex min-w-0 flex-1 flex-col">
    <TopBar {activeWindows} />
    <main class="flex-1 overflow-y-auto px-4 pb-20 pt-6 md:px-8 md:pb-10">
      <div class="mx-auto w-full max-w-7xl">
        {@render children?.()}
      </div>
    </main>
  </div>
  <MobileNav />
</div>
