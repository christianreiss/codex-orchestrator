<script lang="ts">
  import ArrowDownIcon from "@lucide/svelte/icons/arrow-down";
  import MessageSquareDashedIcon from "@lucide/svelte/icons/message-square-dashed";
  import { buildTimeline } from "$lib/portal/grouping";
  import { deliveryIndex } from "$lib/portal/delivery";
  import type { Agent } from "$lib/portal/types";
  import type { Portal } from "../../lib/portal-state.svelte";
  import { prefersReducedMotion } from "../../lib/browser";
  import AttentionCard from "./AttentionCard.svelte";
  import DaySeparator from "./DaySeparator.svelte";
  import LifecycleRule from "./LifecycleRule.svelte";
  import MessageBubble from "./MessageBubble.svelte";
  import PromptCard from "./PromptCard.svelte";
  import StatusLine from "./StatusLine.svelte";
  import StatusRun from "./StatusRun.svelte";
  import CloseNotice from "./CloseNotice.svelte";

  let { portal, agent, onreply }: {
    portal: Portal;
    agent: Agent;
    /** An option answers directly; no option means focus the composer. */
    onreply: (option?: string) => void;
  } = $props();

  let scroller = $state<HTMLElement | null>(null);
  const items = $derived(buildTimeline(portal.timeline));
  const delivery = $derived(deliveryIndex(portal.timeline));
  const lastOutgoing = $derived(portal.timeline.filter((row) => row.type === "user_message").at(-1)?.cursor);

  const ATTENTION_BOTTOM_GAP = 80;

  function scrollToBottom(smooth: boolean) {
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto" });
  }

  $effect(() => {
    portal.setScroller(scrollToBottom);
  });

  function onScroll() {
    if (!scroller) return;
    portal.setAtBottom(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < ATTENTION_BOTTOM_GAP);
  }
</script>

<div class="relative min-h-0 flex-1">
  <div
    bind:this={scroller}
    onscroll={onScroll}
    class="h-full overflow-y-auto px-3 py-4 sm:px-6"
    tabindex="-1"
  >
    {#if items.length === 0}
      <div class="grid h-full place-content-center text-center text-muted-foreground">
        <MessageSquareDashedIcon class="mx-auto h-8 w-8 opacity-60" />
        <p class="mt-2 text-body-sm">No visible messages yet.</p>
      </div>
    {/if}

    {#each items as item (item.id)}
      {#if item.kind === "day"}
        <DaySeparator label={item.label} />
      {:else if item.kind === "run"}
        <StatusRun events={item.events} />
      {:else if item.role === "attention"}
        <AttentionCard
          event={item.event}
          outstanding={agent.attention?.since === item.event.created_at}
          now={portal.now}
          {onreply}
        />
      {:else if item.role === "prompt"}
        <PromptCard event={item.event} active={Boolean(agent.pending_prompt)} onanswer={onreply} />
      {:else if item.role === "close"}
        <CloseNotice event={item.event} />
      {:else if item.role === "lifecycle"}
        <LifecycleRule event={item.event} />
      {:else if item.role === "you" || item.role === "agent"}
        <MessageBubble
          event={item.event}
          role={item.role}
          startsGroup={item.startsGroup}
          endsGroup={item.endsGroup}
          deliveryIndex={delivery}
          showDelivery={item.event.cursor === lastOutgoing || item.event.cursor < 0}
        />
      {:else}
        <StatusLine event={item.event} />
      {/if}
    {/each}
  </div>

  {#if !portal.atBottom}
    <button
      type="button"
      class="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-border bg-card px-3 py-1.5
             text-caption font-medium shadow-pop transition hover:bg-muted focus:outline-none
             focus-visible:ring-2 focus-visible:ring-ring"
      onclick={() => scrollToBottom(true)}
    >
      {portal.missed > 0 ? `${portal.missed} new` : "Latest"}
      <ArrowDownIcon class="ml-1 inline h-3.5 w-3.5" />
    </button>
  {/if}
</div>
