<script lang="ts">
  import "$lib/styles/tokens.css";
  import "$lib/styles/md-prose.css";
  import "../app.css";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { browser } from "$app/environment";
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { accessDenied } from "$lib/api/access-denied";
  import { toast } from "svelte-sonner";
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
  import { sessionMayHaveChanged, wireWsToQueryClient } from "$lib/ws/events";
  import { setWsStatus } from "$lib/stores/ws-status";
  import InsecureApprovalsAutoPopup from "$lib/components/hosts/InsecureApprovalsAutoPopup.svelte";
  import { setupStatusOptions } from "$lib/api/setup";

  let { children } = $props();

  const auth = $derived($authStore);
  const path = $derived(page.url.pathname.replace(base, "") || "/");

  // Routes that render outside the AppShell (login, password reset, device-code approval).
  const STANDALONE = ["/setup", "/login", "/password/reset"];
  const standalone = $derived(STANDALONE.some((p) => path === p || path.startsWith(p + "/")));

  // PageShell/AuthShell own titles, including resolved object names.

  function createQueryClient() {
    return new QueryClient({
      defaultOptions: {
        // A 403 will not change on retry; show "No access" at once.
        queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: (failures, error) => !accessDenied(error) && failures < 1 },
      },
    });
  }

  let queryClient = $state.raw(createQueryClient());
  let wsHandle: WsClientHandle | null = $state(null);
  let stopSessionStream: (() => void) | undefined;
  let setupError = $state<string | null>(null);

  // sessionStorage can throw (private mode, blocked storage); without it we
  // cannot remember the redirect, so fail closed and never redirect rather
  // than bouncing every navigation back to the wizard.
  const SETUP_REDIRECT_KEY = "codex:setup-redirected";
  function setupRedirected(actorId: string): boolean {
    try {
      return sessionStorage.getItem(SETUP_REDIRECT_KEY) === actorId;
    } catch {
      return true;
    }
  }
  function markSetupRedirected(actorId: string): void {
    try {
      sessionStorage.setItem(SETUP_REDIRECT_KEY, actorId);
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

    let previousScope: string | null = null;
    let previousActor: string | null = null;
    let checkingSetup = false;
    const unsubscribeAuth = authStore.subscribe((state) => {
      const currentPath = window.location.pathname.replace(base, "") || "/";
      const isStandalone = STANDALONE.some((p) => currentPath === p || currentPath.startsWith(p + "/"));
      if (state.loading || state.unreachable) return;
      const actorId = state.authenticated && state.user ? String(state.user.id) : null;
      const scope = actorId === null ? null : JSON.stringify([
        actorId, state.authorizationMode, [...state.capabilities].sort(), [...state.roles].sort(),
      ]);
      if (previousScope !== scope) {
        stopSessionStream?.();
        stopSessionStream = undefined;
        wsHandle = null;
        setWsStatus("disabled");
        if (previousScope !== null) {
          // Late promises and mutation callbacks keep only the retired client.
          queryClient.clear();
          queryClient = createQueryClient();
          commandPalette.close();
          searchModal.close();
          toast.dismiss();
        }
        if (actorId !== null) {
          const handle = createWsClient();
          wsHandle = handle;
          const unwire = wireWsToQueryClient(queryClient, handle.events);
          const unwatch = handle.status.subscribe(setWsStatus);
          const unauth = handle.events.subscribe(event => {
            if (event && sessionMayHaveChanged(event)) void authActions.recheck();
          });
          stopSessionStream = () => { unwire(); unwatch(); unauth(); handle.stop(); };
          if (actorId !== previousActor) void hydrateTheme();
        }
        previousActor = actorId;
        previousScope = scope;
        checkingSetup = false;
        setupError = null;
      }
      if (!state.enforced && currentPath !== "/setup") {
        void goto(`${base}/setup`, { replaceState: true });
      } else if (!state.loading && state.enforced && !state.authenticated && !isStandalone) {
        const connectorReturn = currentPath === "/connectors" && window.location.search ? `?next=${encodeURIComponent(currentPath + window.location.search)}` : "";
        void goto(`${base}/login${connectorReturn}`, { replaceState: true });
      } else if (!state.loading && state.authenticated && !isStandalone && actorId !== null && !checkingSetup && !setupRedirected(actorId)) {
        // Check first-run setup in the background: infrastructure probes must
        // not hold up authenticated pages. Remember successful checks once per
        // browser session, including established fleets with no wizard history.
        setupError = null;
        checkingSetup = true;
        const client = queryClient;
        void client.fetchQuery({ ...setupStatusOptions, retry: false })
          .then((status) => {
            if (client !== queryClient) return;
            const wizard = status.wizard;
            const open = status.next_actions.some((action) => !action.complete);
            const established = status.owner_created && status.hosts?.total > 0;
            markSetupRedirected(actorId);
            if (!wizard.completed_at && !wizard.dismissed_at && open && !established) {
              void goto(`${base}/setup`, { replaceState: true });
            }
          })
          .catch((err) => {
            if (client === queryClient) setupError = err instanceof Error ? err.message : "API unreachable";
          })
          .finally(() => { if (client === queryClient) checkingSetup = false; });
      }
    });

    let unbindPrivateShortcuts: (() => void) | undefined;
    const unwatchShortcuts = authStore.subscribe(state => {
      if (state.authenticated && !unbindPrivateShortcuts) {
        unbindPrivateShortcuts = bindGlobalShortcuts({
          "/": () => searchModal.open(),
          Escape: () => commandPalette.close(),
          "?": () => window.dispatchEvent(new CustomEvent("codex:open-shortcuts")),
          n: () => openNewHostSheet(),
        });
      } else if (!state.authenticated) {
        unbindPrivateShortcuts?.();
        unbindPrivateShortcuts = undefined;
      }
    });

    const cmdK = (event: KeyboardEvent) => {
      if (auth.authenticated && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        commandPalette.toggle();
      }
    };
    window.addEventListener("keydown", cmdK);

    const recheck = () => { if (auth.authenticated && !auth.loading) void authActions.recheck(); };
    const onVisible = () => { if (document.visibilityState === "visible") recheck(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("codex:session-recheck", recheck);

    return () => {
      window.removeEventListener("keydown", cmdK);
      window.removeEventListener("codex:session-recheck", recheck);
      document.removeEventListener("visibilitychange", onVisible);
      unwatchShortcuts();
      unbindPrivateShortcuts?.();
      stopSessionStream?.();
      unsubscribeAuth();
    };
  });
</script>

<ModeWatcher defaultMode="system" />

{#key queryClient}
  <QueryClientProvider client={queryClient}>
    {#if auth.unreachable}
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
        {#if setupError}<div role="alert" class="m-4 text-body-sm text-destructive">Setup status unavailable: {setupError}. Your current page and drafts are retained. <Button size="sm" variant="outline" onclick={() => void authActions.recheck()}>Retry setup check</Button></div>{/if}
        {@render children?.()}
      </AppShell>
      {#if auth.authenticated && wsHandle}
        <InsecureApprovalsAutoPopup events={wsHandle.events} />
      {/if}
    {/if}
    {#if auth.authenticated && !auth.unreachable}
      <SearchModal />
      <CommandPalette />
    {/if}
    <Toaster />
  </QueryClientProvider>
{/key}
