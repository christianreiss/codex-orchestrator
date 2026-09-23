<script lang="ts">
  import type { EventRow } from "$lib/portal/types";
  import { eventText } from "$lib/portal/grouping";
  import { deliveryFor, DELIVERY_LABEL, type Delivery } from "$lib/portal/delivery";
  import { clockTime } from "$lib/portal/browser";
  import MarkdownBody from "./MarkdownBody.svelte";

  let {
    event,
    role,
    startsGroup,
    endsGroup,
    deliveryIndex,
    showDelivery,
  }: {
    event: EventRow;
    role: "you" | "agent";
    startsGroup: boolean;
    endsGroup: boolean;
    deliveryIndex: Map<string, Delivery>;
    showDelivery: boolean;
  } = $props();

  const delivery = $derived(showDelivery ? deliveryFor(event, deliveryIndex) : null);
  const time = $derived(clockTime(event.created_at));
</script>

<div class="group flex flex-col {role === 'you' ? 'items-end' : 'items-start'} {startsGroup ? 'mt-2' : 'mt-0.5'}">
  <div
    class="bubble max-w-[min(85%,40rem)] sm:max-w-[min(75%,40rem)]
           {role === 'you' ? 'bubble-you' : 'bubble-agent'} {endsGroup ? 'bubble-tail' : ''}"
    title={time}
  >
    {#if role === "agent"}
      <MarkdownBody text={eventText(event)} />
    {:else}
      <!-- Operator text is never markdown: people type * and _ literally. -->
      <p class="whitespace-pre-wrap break-words text-body">{eventText(event)}</p>
    {/if}
    <time class="sr-only" datetime={event.created_at}>{time}</time>
  </div>

  {#if delivery}
    <p class="mt-0.5 px-1 text-[10px] font-medium {delivery === 'failed' ? 'text-destructive' : 'text-muted-foreground'}">
      {DELIVERY_LABEL[delivery]}
    </p>
  {:else}
    <!-- Messages hides per-bubble times; hover or focus reveals this one. -->
    <p
      class="h-0 overflow-hidden px-1 text-[10px] text-muted-foreground opacity-0 transition-opacity
             group-hover:h-auto group-hover:opacity-100 group-focus-within:h-auto group-focus-within:opacity-100"
      aria-hidden="true"
    >{time}</p>
  {/if}
</div>

<style>
  /*
   * Lives here rather than in either app's stylesheet so /admin and /go render
   * the same bubble; it used to exist only in the portal CSS, which left admin
   * bubbles unstyled. A component <style> ships in the CSS bundle, so the
   * portal CSP (`style-src 'self'`) permits it.
   *
   * The tail is a two-shape hook: a wedge in the bubble colour, then a
   * page-coloured shape that bites the outer edge off it.
   */
  .bubble { position: relative; border-radius: 1.1rem; padding: .4rem .8rem; }

  .bubble-you { background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); }
  .bubble-you.bubble-tail::before,
  .bubble-you.bubble-tail::after,
  .bubble-agent.bubble-tail::before,
  .bubble-agent.bubble-tail::after { content: ""; position: absolute; bottom: 0; height: 1rem; }

  .bubble-you.bubble-tail::before { right: -7px; width: 1.25rem; background: hsl(var(--primary)); border-bottom-left-radius: 16px 14px; }
  .bubble-you.bubble-tail::after { right: -10px; width: 10px; background: var(--bubble-page, hsl(var(--background))); border-bottom-left-radius: 10px; }

  /* Agent side is the grey Messages bubble; muted is the one grey token both apps share. */
  .bubble-agent { background: hsl(var(--muted)); color: hsl(var(--foreground)); }
  .bubble-agent.bubble-tail::before { left: -7px; width: 1.25rem; background: hsl(var(--muted)); border-bottom-right-radius: 16px 14px; }
  .bubble-agent.bubble-tail::after { left: -10px; width: 10px; background: var(--bubble-page, hsl(var(--background))); border-bottom-right-radius: 10px; }
</style>
