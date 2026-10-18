<script lang="ts">
  import "$lib/styles/tokens.css";
  import "$lib/styles/md-prose.css";
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
  import SearchModal from "$lib/components/search-modal/SearchModal.svelte";
  import { AuthShell } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import Toaster from "$lib/components/feedback/Toaster.svelte";
  import { commandPalette } from "$lib/stores/command-palette";
  import { searchModal } from "$lib/stores/search-modal";
  import { bindGlobalShortcuts } from "$lib/utils/shortcuts";
  import { authActions, authStore } from "$lib/stores/auth";
  import { hydrateTheme } from "$lib/stores/theme";
  import { createWsClient, type WsClientHandle } from "$lib/ws/client";
  import { wireWsToQueryClient } from "$lib/ws/events";
  import { setWsStatus } from "$lib/stores/ws-status";
  import InsecureApprovalsAutoPopup from "$lib/components/hosts/InsecureApprovalsAutoPopup.svelte";
  import { getSetupStatus } from "$lib/api/setup";

  let { children } = $props();

  const auth = $derived($authStore);
  const path = $derived(page.url.pathname.replace(base, "") || "/");

  // Routes that render outside the AppShell (login, password reset, device-code approval).
  const STANDALONE = ["/setup", "/login", "/password/reset", "/cli-auth/verify"];
  const standalone = $derived(STANDALONE.some((p) => path === p || path.startsWith(p + "/")));

  // PageShell/AuthShell own titles, including resolved object names.

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
    },
  });

  let wsHandle: WsClientHandle | null = $state(null);
  let unsubscribeShortcuts: (() => void) | null = null;
  let unsubscribeWs: (() => void) | null = null;
  let unsubscribeWsStatus: (() => void) | null = null;
  let setupError = $state<string | null>(null);

  // sessionStorage can throw (private mode, blocked storage); without it we
  // cannot remember the redirect, so fail closed and never redirect rather
  // than bouncing every navigation back to the wizard.
  const SETUP_REDIRECT_KEY = "codex:setup-redirected";
  function setupRedirected(): boolean {
    try {
      return sessionStorage.getItem(SETUP_REDIRECT_KEY) === "1";
    } catch {
      return true;
    }
  }
  function markSetupRedirected(): void {
    try {
      sessionStorage.setItem(SETUP_REDIRECT_KEY, "1");
    } catch {
      // ignored — see above
    }
  }

  function openNewHostSheet(): void {
    void goto(`${base}/hosts?dialog=new-host`);
    window.dispatchEvent(new CustomEvent("codex:open-new-host"));
  }

  onMount(() => {
    if (!browser) return;

    const unsubscribeAuth = authStore.subscribe((state) => {
      const currentPath = window.location.pathname.replace(base, "") || "/";
      const isStandalone = STANDALONE.some((p) => currentPath === p || currentPath.startsWith(p + "/"));
      if (state.loading || state.unreachable) return;
      if (!state.enforced && currentPath !== "/setup") {
        void goto(`${base}/setup`, { replaceState: true });
      } else if (!state.loading && state.enforced && !state.authenticated && !isStandalone) {
        void goto(`${base}/login`, { replaceState: true });
      } else if (!state.loading && state.authenticated && !isStandalone && !setupRedirected()) {
        // Check first-run setup in the background: infrastructure probes must
        // not hold up authenticated pages. Remember successful checks once per
        // browser session, including established fleets with no wizard history.
        setupError = null;
        void getSetupStatus()
          .then((status) => {
            const wizard = status.wizard;
            const open = status.next_actions.some((action) => !action.complete);
            const established = status.owner_created && status.hosts?.total > 0;
            markSetupRedirected();
            if (!wizard.completed_at && !wizard.dismissed_at && open && !established) {
              void goto(`${base}/setup`, { replaceState: true });
            }
          })
          .catch((err) => { setupError = err instanceof Error ? err.message : "API unreachable"; });
      }
    });

    unsubscribeShortcuts = bindGlobalShortcuts({
      "/": () => searchModal.open(),
      Escape: () => commandPalette.close(),
      "?": () => window.dispatchEvent(new CustomEvent("codex:open-shortcuts")),
      n: () => openNewHostSheet(),
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
        unsubscribeWsStatus = wsHandle.status.subscribe((status) => setWsStatus(status));
      } else if (!state.authenticated && wsHandle) {
        unsubscribeWs?.();
        unsubscribeWs = null;
        unsubscribeWsStatus?.();
        unsubscribeWsStatus = null;
        wsHandle.stop();
        wsHandle = null;
        setWsStatus("disabled");
      }
    });

    let paletteHydrated = false;
    const unsubscribePalette = authStore.subscribe((state) => {
      if (paletteHydrated || state.loading || !state.authenticated) return;
      paletteHydrated = true;
      void hydrateTheme();
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
    unsubscribeWsStatus?.();
    wsHandle?.stop();
  });
</script>

<ModeWatcher defaultMode="system" />

<QueryClientProvider client={queryClient}>
  {#if auth.unreachable || setupError}
    <AuthShell title="API unreachable" description={auth.unreachable ?? setupError ?? undefined}>
      <Button onclick={() => { setupError = null; void authActions.refresh(); }}>Retry</Button>
    </AuthShell>
  {:else if standalone}
    {@render children?.()}
  {:else if auth.loading || !auth.enforced || !auth.authenticated}
    <!-- Settling the session, or the gate above is already sending us to /setup or /login. -->
    <div class="flex h-full w-full items-center justify-center text-body-sm text-muted-foreground" role="status">
      {auth.loading ? "Loading…" : "Redirecting…"}
    </div>
  {:else}
    <AppShell>
      {@render children?.()}
    </AppShell>
    {#if auth.authenticated && wsHandle}
      <InsecureApprovalsAutoPopup events={wsHandle.events} />
    {/if}
  {/if}
  <SearchModal />
  <CommandPalette />
  <Toaster />
</QueryClientProvider>
