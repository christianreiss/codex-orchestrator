<script lang="ts">
  import RadioTowerIcon from "@lucide/svelte/icons/radio-tower";
  import { presenceView } from "$lib/portal/presence";
  import type { Portal } from "../../lib/portal-state.svelte";
  import CenterState from "../state/CenterState.svelte";
  import Composer from "../composer/Composer.svelte";
  import CloseChannelDialog from "../modal/CloseChannelDialog.svelte";
  import ClosingBar from "../thread/ClosingBar.svelte";
  import ThreadHeader from "../thread/ThreadHeader.svelte";
  import Timeline from "$lib/components/portal/Timeline.svelte";
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

  /**
   * A prompt option is an answer, not a hint. Clicking one used to focus an
   * empty textarea without even prefilling the text, so the buttons looked
   * actionable and did nothing. With no option -- the "Reply" affordance on an
   * attention card -- focusing the composer is still the right response.
   */
  function reply(option?: string) {
    if (option) {
      void portal.send(option);
      return;
    }
    composerInput?.focus();
  }

  /**
   * Which close the header offers. A cooperative close asks the agent to wrap
   * up, which only means anything while something is listening -- against an
   * unreachable agent the server refuses it, and the operator used to be left
   * with an error and no second option, because "Force end" lived exclusively
   * inside the closing bar that a refused close never creates.
   */
  function openClose() {
    closeMode = agent && presenceView(agent, portal.now).canSend ? "cooperative" : "force";
    closeOpen = true;
  }

  async function confirmClose(mode: "cooperative" | "force", note: string) {
    closeOpen = false;
    if (mode === "force") {
      await portal.forceEnd(note);
      return;
    }
    // The cooperative path degrades into escalation rather than a dead end: if
    // the agent turns out to be unreachable, reopen straight into force with
    // the reason shown, instead of reporting a failure with nothing to do next.
    const outcome = await portal.requestClose(note);
    if (outcome === "unreachable") {
      closeMode = "force";
      closeOpen = true;
    }
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
        onclose={openClose}
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
    {/if}

    <!--
      Outside the `agent` branch on purpose. It used to live inside it, so a
      failing agent list on an empty fleet rendered "No agents are checked in"
      and swallowed the reason entirely.
    -->
    {#if portal.error}
      <p
        role="alert"
        aria-live="assertive"
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

    {#if agent}
      <Timeline {portal} {agent} onreply={reply} />

      <Composer
        {agent}
        now={portal.now}
        sending={portal.sending}
        draft={portal.draft}
        ondraft={(text) => (portal.draft = text)}
        onsend={(text) => portal.send(text)}
        bind:input={composerInput}
      />

      <CloseChannelDialog
        {agent}
        bind:open={closeOpen}
        bind:mode={closeMode}
        busy={portal.closing}
        reason={portal.closeReason}
        onconfirm={confirmClose}
      />
    {:else}
      <CenterState
        icon={RadioTowerIcon}
        title="No agents are checked in"
        body="Codex and Claude sessions started on your hosts appear here automatically. Run #afk inside one to open its relay so you can reply from here."
      />
    {/if}

    <!--
      Screen readers get nothing from a timeline that grows in place. This is
      the only element that announces, so it carries new inbound content and
      delivery outcomes rather than every render.
    -->
    <p class="sr-only" aria-live="polite">{portal.announcement}</p>
  </div>
</div>
