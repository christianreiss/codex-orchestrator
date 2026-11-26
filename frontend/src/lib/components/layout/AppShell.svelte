<script lang="ts">
  import type { Snippet } from "svelte";
  import Chatty from "../chatty/Chatty.svelte";
  import Sidebar from "./Sidebar.svelte";
  import MobileNav from "./MobileNav.svelte";
  import TopBar from "./TopBar.svelte";
  import { createAppearanceControl } from "./appearance.svelte";

  let { children }: { children?: Snippet } = $props();
  // The account menu switches the theme; the top bar reports a failed save.
  const appearance = createAppearanceControl();
</script>

<a class="skip-link" href="#main-content">Skip to content</a>

<div class="flex h-full min-h-0 w-full bg-background">
  <Sidebar {appearance} />
  <div class="flex min-w-0 flex-1 flex-col">
    <TopBar {appearance} />
    <main
      id="main-content"
      tabindex="-1"
      class="app-main min-h-0 flex-1 overflow-y-auto px-4 pt-4 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:px-6 md:pt-5"><!-- slop-ok: skip-link target (tabindex=-1), not a control -->
      <div class="mx-auto w-full max-w-[1600px]">
        {@render children?.()}
      </div>
    </main>
  </div>
  <MobileNav />
</div>

<Chatty />
