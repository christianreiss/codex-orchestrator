<script lang="ts">
  import "../app.css";
  import { onMount, onDestroy } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { browser } from "$app/environment";
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { ModeWatcher } from "mode-watcher";
  import AppShell from "$lib/components/layout/AppShell.svelte";
  import CommandPalette from "$lib/components/command-palette/CommandPalette.svelte";
  import Toaster from "$lib/components/feedback/Toaster.svelte";
  import { commandPalette } from "$lib/stores/command-palette";
  import { bindGlobalShortcuts } from "$lib/utils/shortcuts";
  import { authStore } from "$lib/stores/auth";
  import { hydratePalette } from "$lib/stores/theme";
  import { createWsClient, type WsClientHandle } from "$lib/ws/client";
  import { wireWsToQueryClient } from "$lib/ws/events";

  let { children } = $props();

  const auth = $derived($authStore);
  const path = $derived(page.url.pathname.replace(base, "") || "/");

  // Routes that render outside the AppShell (login, device-code approval).
  const STANDALONE = ["/login", "/cli-auth/verify"];
  const standalone = $derived(STANDALONE.some((p) => path === p || path.startsWith(p + "/")));

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
    },
  });

  let wsHandle: WsClientHandle | null = null;
  let unsubscribeShortcuts: (() => void) | null = null;
  let unsubscribeWs: (() => void) | null = null;

  onMount(() => {
    if (!browser) return;

    const unsubscribeAuth = authStore.subscribe((state) => {
      const currentPath = window.location.pathname.replace(base, "") || "/";
      const isStandalone = STANDALONE.some((p) => currentPath === p || currentPath.startsWith(p + "/"));
      if (!state.loading && state.enforced && !state.authenticated && !isStandalone) {
        void goto(`${base}/login`, { replaceState: true });
      }
    });

    unsubscribeShortcuts = bindGlobalShortcuts({
      "/": () => commandPalette.open(),
      Escape: () => commandPalette.close(),
      "?": () => window.dispatchEvent(new CustomEvent("codex:open-shortcuts")),
    });

    const cmdK = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        commandPalette.toggle();
      }
    };
    window.addEventListener("keydown", cmdK);

    const unsubscribeWsAuth = authStore.subscribe((state) => {
      if (state.authenticated && !wsHandle) {
        wsHandle = createWsClient();
        unsubscribeWs = wireWsToQueryClient(queryClient, wsHandle.events);
      } else if (!state.authenticated && wsHandle) {
        unsubscribeWs?.();
        unsubscribeWs = null;
        wsHandle.stop();
        wsHandle = null;
      }
    });

    let paletteHydrated = false;
    const unsubscribePalette = authStore.subscribe((state) => {
      if (paletteHydrated || state.loading || !state.authenticated) return;
      paletteHydrated = true;
      void hydratePalette();
    });

    return () => {
      window.removeEventListener("keydown", cmdK);
      unsubscribeAuth();
      unsubscribeWsAuth();
      unsubscribePalette();
    };
  });

  onDestroy(() => {
    unsubscribeShortcuts?.();
    unsubscribeWs?.();
    wsHandle?.stop();
  });
</script>

<ModeWatcher defaultMode="system" />

<QueryClientProvider client={queryClient}>
  {#if standalone}
    {@render children?.()}
  {:else if auth.loading}
    <div class="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
      Loading…
    </div>
  {:else if auth.enforced && !auth.authenticated}
    <div class="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
      Redirecting…
    </div>
  {:else}
    <AppShell>
      {@render children?.()}
    </AppShell>
  {/if}
  <CommandPalette />
  <Toaster />
</QueryClientProvider>
