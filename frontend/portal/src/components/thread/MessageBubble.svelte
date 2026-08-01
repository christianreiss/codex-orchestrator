<script lang="ts">
  import type { EventRow } from "$lib/portal/types";
  import { eventText } from "$lib/portal/grouping";
  import { deliveryFor, DELIVERY_LABEL, type Delivery } from "$lib/portal/delivery";
  import { clockTime } from "../../lib/browser";
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
</script>

<div class="flex flex-col {role === 'you' ? 'items-end' : 'items-start'} {startsGroup ? 'mt-3' : 'mt-0.5'}">
  <div
    class="group bubble max-w-[min(88%,40rem)] sm:max-w-[min(78%,40rem)]
           {role === 'you' ? 'bubble-you' : 'bubble-agent'} {endsGroup ? 'bubble-tail' : ''}"
  >
    {#if role === "agent"}
      <MarkdownBody text={eventText(event)} />
    {:else}
      <!-- Operator text is never markdown: people type * and _ literally. -->
      <p class="whitespace-pre-wrap break-words text-body">{eventText(event)}</p>
    {/if}

    <time
      class="mt-1 block text-[10px] leading-none transition-opacity
             {role === 'you' ? 'text-primary-foreground/70' : 'text-muted-foreground'}
             {endsGroup ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}"
      datetime={event.created_at}
    >{clockTime(event.created_at)}</time>
  </div>

  {#if delivery}
    <p class="mt-0.5 pr-1 text-[10px] {delivery === 'failed' ? 'text-destructive' : 'text-muted-foreground'}">
      {DELIVERY_LABEL[delivery]}
    </p>
  {/if}
</div>
