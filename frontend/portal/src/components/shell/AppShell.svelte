<script lang="ts">
  import RadioTowerIcon from "@lucide/svelte/icons/radio-tower";
  import type { Portal } from "../../lib/portal-state.svelte";
  import CenterState from "../state/CenterState.svelte";
  import Composer from "../composer/Composer.svelte";
  import CloseChannelDialog from "../modal/CloseChannelDialog.svelte";
  import ClosingBar from "../thread/ClosingBar.svelte";
  import ThreadHeader from "../thread/ThreadHeader.svelte";
  import Timeline from "../thread/Timeline.svelte";
  import Sidebar from "./Sidebar.svelte";

  let { portal }: { portal: Portal } = $props();

  // One pane at a time on phones, both side by side from `md` up. `paneOpen`
  // only drives the mobile case; on desktop both panes are always rendered.
  let paneOpen = $state(false);
  let closeOpen = $state(false);
  let closeMode = $state<"cooperative" | "force">("cooperative");
  let composerInput = $state<HTMLTextAreaElement | null>(null);
  let threadHeading = $state<HTMLHeadingElement | null>(null);

  const agent = $derived(portal.selected);

  function openThread(id: string) {
    void portal.select(id);
    if (!paneOpen && matchMedia("(max-width: 767px)").matches) {
      paneOpen = true;
      // So the hardware back button returns to the list instead of leaving
      // the portal altogether.
      history.pushState({ pane: "thread" }, "");
    }
    queueMicrotask(() => threadHeading?.focus());
  }

  function closeThread() {
    if (paneOpen) history.back();
  }

  $effect(() => {
    const onPop = () => (paneOpen = false);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  });

  function confirmClose(mode: "cooperative" | "force", note: string) {
    closeOpen = false;
    if (mode === "force") void portal.forceEnd(note);
    else void portal.requestClose(note);
  }
</script>

<a class="skip-link" href="#portal-composer">Skip to the message box</a>

<div class="grid h-full grid-cols-1 md:grid-cols-[minmax(17rem,22rem)_1fr]">
  <div class="{paneOpen ? 'hidden' : 'block'} min-h-0 md:block">
    <Sidebar {portal} onselect={openThread} />
  </div>

  <div class="{paneOpen ? 'flex' : 'hidden'} min-h-0 flex-col md:flex">
    {#if agent}
      <ThreadHeader
        {agent}
        now={portal.now}
        onback={closeThread}
        onclose={() => { closeMode = "cooperative"; closeOpen = true; }}
        bind:heading={threadHeading}
      />

      {#if agent.close}
        <ClosingBar
          {agent}
          now={portal.now}
          busy={portal.closing}
          onforce={() => { closeMode = "force"; closeOpen = true; }}
        />
      {/if}

      {#if portal.error}
        <p
          class="flex items-center gap-2 border-b border-destructive/25 bg-destructive-muted px-4 py-2
                 text-caption text-destructive-muted-foreground"
        >
          <span class="min-w-0 flex-1">{portal.error}</span>
          <button
            type="button"
            class="shrink-0 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onclick={portal.clearError}
          >Dismiss</button>
        </p>
      {/if}

      <Timeline {portal} {agent} onreply={() => composerInput?.focus()} />

      <Composer
        {agent}
        now={portal.now}
        sending={portal.sending}
        onsend={(text) => void portal.send(text)}
        bind:input={composerInput}
      />

      <CloseChannelDialog
        {agent}
        bind:open={closeOpen}
        bind:mode={closeMode}
        busy={portal.closing}
        onconfirm={confirmClose}
      />
    {:else}
      <CenterState
        icon={RadioTowerIcon}
        title="No agents are checked in"
        body="Codex and Claude sessions started on your hosts appear here automatically. Run #afk inside one to open its relay so you can reply from here."
      />
    {/if}
  </div>
</div>
