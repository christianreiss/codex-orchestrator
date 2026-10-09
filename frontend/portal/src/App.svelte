<script lang="ts">
 import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
 import RemoteSessions from "$lib/components/portal/RemoteSessions.svelte";
 const queryClient=new QueryClient();
 let remoteOpen=$state(false);
  import { onMount } from "svelte";
  import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
  import PowerOffIcon from "@lucide/svelte/icons/power-off";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import { titleFor } from "$lib/portal/unread";
  import { createPortal } from "./lib/portal-state.svelte";
  import { paintFavicon } from "$lib/portal/browser";
  import AppShell from "./components/shell/AppShell.svelte";
  import CenterState from "./components/state/CenterState.svelte";
  import LoadingScreen from "./components/state/LoadingScreen.svelte";

  const portal = createPortal();

  onMount(() => {
    void portal.bootstrap();
    return () => portal.teardown();
  });

  // Both badges track the same two numbers, so a backgrounded tab still shows
  // what is waiting.
  $effect(() => {
    document.title = titleFor(portal.needsYou, portal.unreadTotal);
  });
  $effect(() => {
    paintFavicon(portal.needsYou, portal.unreadTotal);
  });
</script>

{#if portal.phase === "loading"}
  <LoadingScreen />
{:else if portal.phase === "disabled"}
  <!-- Every terminal phase gets a way forward. These two used to have none. -->
  <CenterState
    icon={PowerOffIcon}
    title="Agent portal is off"
    body="The fleet administrator has disabled remote agent access. Local agents are unaffected."
  >
    <button
      type="button"
      class="rounded-md border border-border px-3 py-1.5 text-caption font-semibold transition
             hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onclick={portal.retry}
    >Check again</button>
  </CenterState>
{:else if portal.phase === "login"}
  <CenterState
    icon={ExternalLinkIcon}
    title="Open your permanent link"
    body="This browser has no active portal login — the link may have expired. Open your bookmarked permanent link, or ask a fleet admin to read it back from the Agent Portal settings."
  >
    <button
      type="button"
      class="rounded-md border border-border px-3 py-1.5 text-caption font-semibold transition
             hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onclick={portal.retry}
    >Try again</button>
  </CenterState>
{:else if portal.phase === "error"}
  <CenterState icon={TriangleAlertIcon} title="Portal unavailable" body={portal.error} tone="destructive">
    <button
      type="button"
      class="rounded-md bg-primary px-3 py-1.5 text-caption font-semibold text-primary-foreground
             transition hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onclick={portal.retry}
    >Retry</button>
  </CenterState>
{:else}
  <QueryClientProvider client={queryClient}>
  <div class="grid h-full grid-rows-[auto_minmax(0,1fr)]">
   <div class="border-b border-border bg-background p-2"><button class="rounded border px-3 py-1 text-sm" onclick={()=>remoteOpen=!remoteOpen}>Remote-Sessions</button>
    {#if remoteOpen}<div class="max-h-[70vh] overflow-auto p-3"><RemoteSessions portal/></div>{/if}
   </div>
   <div class="min-h-0"><AppShell {portal} /></div>
  </div>
  </QueryClientProvider>
{/if}
