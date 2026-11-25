<script lang="ts">
  import type { Snippet } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import type { Agent, PresenceTimings } from "$lib/portal/types";
  import { presenceView } from "$lib/portal/presence";

  let {
    attachments,
    agent,
    now,
    sending,
    draft,
    ondraft,
    onsend,
    input = $bindable(null),
    disabledReason = "",
    timings,
    hasAttachments = false,
  }: {
    attachments: Snippet;
    agent: Agent;
    now: number;
    sending: boolean;
    /** Owned by the portal store so it survives this component unmounting. */
    draft: string;
    ondraft: (text: string) => void;
    onsend: (text: string) => Promise<boolean>;
    input?: HTMLTextAreaElement | null;
    /** A stale admin snapshot must not authorize replies using old relay state. */
    disabledReason?: string;
    timings?: PresenceTimings;
    hasAttachments?: boolean;
  } = $props();

  const view = $derived(presenceView(agent, now, timings));
  const closing = $derived(agent.close?.state === "pending");

  const placeholder = $derived(
    closing ? "Closing — say something if you need to stop it"
    : agent.pending_prompt ? "Answer the agent…"
    : "Instruct the running agent…",
  );

  /**
   * The text is cleared by the store on success and handed back on failure.
   * Clearing it here at submit time meant a rejected send destroyed the draft
   * along with its optimistic bubble, leaving nothing to retry.
   */
  function submit() {
    const value = draft.trim();
    if ((!value && !hasAttachments) || sending || !view.canSend || disabledReason) return;
    void onsend(value);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  }
</script>

<footer class="border-t border-border bg-card px-3 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2 sm:px-4">
  {#if agent.read_only}
    <p class="py-1.5 text-center text-caption text-muted-foreground">
      {view.detail}
    </p>
  {:else}
    <!--
      The form stays mounted when the agent stops accepting instructions. It
      used to be replaced outright by this sentence, so a presence flip while
      someone was typing destroyed what they had written.
    -->
    {#if disabledReason}
      <p class="pb-1.5 text-center text-caption text-muted-foreground">{disabledReason}</p>
    {:else if !view.canSend}
      <p class="pb-1.5 text-center text-caption text-muted-foreground">
        {view.detail}
      </p>
    {/if}
    <form
      class="mx-auto grid max-w-[75ch] grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-2"
      onsubmit={(event) => { event.preventDefault(); submit(); }}
    >
      {@render attachments()}
      <label class="sr-only" for="portal-composer">Message this agent</label>
      <textarea
        bind:this={input}
        value={draft}
        oninput={(event) => ondraft(event.currentTarget.value)}
        id="portal-composer"
        rows="1"
        maxlength="32768"
        placeholder={view.canSend ? placeholder : "Not accepting instructions right now"}
        aria-keyshortcuts="Control+Enter Meta+Enter"
        aria-describedby="portal-composer-hint"
        onkeydown={onKeydown}
        class="max-h-40 [field-sizing:content] min-h-9 w-full resize-none rounded border border-input
               bg-background py-1.5 px-3 text-body-sm leading-6 transition
               ring-offset-background placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-2
               focus-visible:ring-ring focus-visible:ring-offset-2"
      ></textarea>
      <Button type="submit" size="sm" disabled={sending || (!draft.trim() && !hasAttachments) || !view.canSend || Boolean(disabledReason)}>{sending ? "Sending…" : "Send"}</Button>
    </form>
    <p id="portal-composer-hint" class="sr-only">
      Ctrl/⌘+Enter to send, Enter for a new line. Local sandbox and approvals still apply.
    </p>
  {/if}
</footer>
