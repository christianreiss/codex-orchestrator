/**
 * Page state for Messages that lives in the URL, so a filtered view can be
 * shared and survives a reload. Must be called during component initialisation.
 */
import { page } from "$app/state";
import { goto } from "$app/navigation";

export const CONVERSATION_STATUSES = [
  { value: "all", label: "All conversations" },
  { value: "open", label: "Open" },
  { value: "canceled", label: "Canceled" },
] as const;
export const MESSAGE_STATUSES = [
  "all", "queued", "leased", "accepted", "completed", "dead", "ambiguous",
  "expired", "canceled", "batched", "digested", "superseded",
] as const;
export const LIMITS = [50, 100, 250, 500] as const;
export const VIEWS = ["conversations", "addresses", "groups", "deliveries"] as const;

export type ConversationStatusFilter = (typeof CONVERSATION_STATUSES)[number]["value"];
export type MessageStatusFilter = (typeof MESSAGE_STATUSES)[number];
export type MessagingView = (typeof VIEWS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function param(key: string): string | null {
  return page.url.searchParams.get(key);
}

export function createMessagingFilters() {
  const initialView = param("view");
  const initialConversation = param("conversation_status");
  const initialMessage = param("message_status");
  const initialLimit = Number(param("limit"));

  let view = $state<MessagingView>(VIEWS.includes(initialView as MessagingView) ? (initialView as MessagingView) : "conversations");
  let conversationStatus = $state<ConversationStatusFilter>(
    CONVERSATION_STATUSES.some((option) => option.value === initialConversation) ? (initialConversation as ConversationStatusFilter) : "all",
  );
  let messageStatus = $state<MessageStatusFilter>(MESSAGE_STATUSES.includes(initialMessage as MessageStatusFilter) ? (initialMessage as MessageStatusFilter) : "all");
  let conversationId = $state(param("conversation_id") ?? "");
  let limit = $state<number>((LIMITS as readonly number[]).includes(initialLimit) ? initialLimit : 100);
  let lastObservedUrl = page.url.href;

  const validConversationId = $derived(UUID.test(conversationId.trim()) ? conversationId.trim() : undefined);
  const conversationIdValid = $derived(conversationId.trim() === "" || validConversationId !== undefined);

  // Back/forward and in-page links change `view` from outside this component.
  $effect(() => {
    const currentUrl = page.url.href;
    if (currentUrl === lastObservedUrl) return;
    lastObservedUrl = currentUrl;
    const requested = param("view");
    if (VIEWS.includes(requested as MessagingView) && requested !== view) view = requested as MessagingView;
    if (requested === null && view !== "conversations") view = "conversations";
  });

  $effect(() => {
    const url = new URL(page.url);
    const setOrDelete = (key: string, value: string, fallback = "") => {
      if (value === fallback) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    };
    setOrDelete("view", view, "conversations");
    setOrDelete("conversation_status", conversationStatus, "all");
    setOrDelete("message_status", messageStatus, "all");
    setOrDelete("conversation_id", conversationId.trim());
    setOrDelete("limit", String(limit), "100");
    if (url.search !== page.url.search) void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  });

  return {
    get view() { return view; },
    set view(next: MessagingView) { view = next; },
    get conversationStatus() { return conversationStatus; },
    set conversationStatus(next: ConversationStatusFilter) { conversationStatus = next; },
    get messageStatus() { return messageStatus; },
    set messageStatus(next: MessageStatusFilter) { messageStatus = next; },
    get conversationId() { return conversationId; },
    set conversationId(next: string) { conversationId = next; },
    get limit() { return limit; },
    set limit(next: number) { limit = next; },
    get validConversationId() { return validConversationId; },
    get conversationIdValid() { return conversationIdValid; },
    /** Jump to the delivery log narrowed to one conversation. */
    openDeliveries(id?: string) {
      if (id) conversationId = id;
      view = "deliveries";
    },
  };
}

export type MessagingFilters = ReturnType<typeof createMessagingFilters>;
