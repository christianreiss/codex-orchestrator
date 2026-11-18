<script lang="ts">
  import type { EventRow } from "$lib/portal/types";
  import { eventText } from "$lib/portal/grouping";
  import { deliveryFor, DELIVERY_LABEL, type Delivery, type DeliveryActivity } from "$lib/portal/delivery";
  import AttachmentList from "./AttachmentList.svelte";
  import MessageFrame from "./MessageFrame.svelte";
  import MessageContent from "./MessageContent.svelte";
  import MessageActions from "./MessageActions.svelte";
  import ReplyQuote from "./ReplyQuote.svelte";

  let {
    event,
    role,
    deliveryIndex,
    showDelivery,
    activity,
    now,
    session,
    onreply,
    agentName, replyName, replyText, onjump,
  }: {
    event: EventRow;
    role: "you" | "agent";
    deliveryIndex: Map<string, Delivery>;
    showDelivery: boolean;
    activity?: DeliveryActivity;
    now?: number;
    session?: string;
    onreply?: (cursor:number)=>void;
    agentName: string; replyName?: string; replyText?: string; onjump?: () => void;
  } = $props();

  const delivery = $derived(showDelivery ? deliveryFor(event, deliveryIndex, activity, now) : null);
</script>

<MessageFrame important={event.payload.important === true || !!event.payload.severity} id={`session-event-${event.cursor}`} name={role === "you" ? "You" : agentName} createdAt={event.created_at} operator={role === "you"}>
  {#if event.payload.reply_to}<ReplyQuote name={replyName} text={replyText} onjump={onjump} />{/if}
  <MessageContent text={eventText(event)} messageKey={`${session}:${event.cursor}`} markdown={role === "agent"} />
  {#if session && Array.isArray(event.payload.attachments)}<AttachmentList {session} ids={event.payload.attachments as string[]} />{/if}
  {#snippet actions()}
    {#if onreply}<button type="button" class="min-h-8 underline-offset-4 hover:underline pointer-coarse:min-h-11" onclick={() => onreply?.(event.cursor)}>Reply</button>{/if}
    <MessageActions text={eventText(event)} />
    {#if delivery}<p role="status" class="font-medium {delivery === 'failed' ? 'text-destructive' : 'text-muted-foreground'}">{DELIVERY_LABEL[delivery]}</p>{/if}
  {/snippet}
</MessageFrame>
