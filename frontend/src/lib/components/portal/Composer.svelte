<script lang="ts">
  import SendIcon from "@lucide/svelte/icons/arrow-up";
  import type { Agent, PresenceTimings } from "$lib/portal/types";
  import { presenceView } from "$lib/portal/presence";

  let {
    agent,
    now,
    sending,
    draft,
    ondraft,
    onsend,
    input = $bindable(null),
    disabledReason = "",
    timings,
  }: {
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
    if (!value || sending || !view.canSend || disabledReason) return;
    void onsend(value);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
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
      <p class="pb-1.5 text-center text-[11px] text-muted-foreground">{disabledReason}</p>
    {:else if !view.canSend}
      <p class="truncate pb-1.5 text-center text-[11px] text-muted-foreground" title={view.detail}>
        <strong class="font-semibold text-foreground">{view.label}.</strong> {view.detail}
      </p>
    {/if}
    <form
      class="relative mx-auto flex max-w-3xl items-end"
      onsubmit={(event) => { event.preventDefault(); submit(); }}
    >
      <label class="sr-only" for="portal-composer">Message this agent</label>
      <textarea
        bind:this={input}
        value={draft}
        oninput={(event) => ondraft(event.currentTarget.value)}
        id="portal-composer"
        rows="1"
        maxlength="32768"
        placeholder={view.canSend ? placeholder : "Not accepting instructions right now"}
        aria-keyshortcuts="Enter"
        aria-describedby="portal-composer-hint"
        onkeydown={onKeydown}
        class="max-h-40 [field-sizing:content] min-h-[2.25rem] flex-1 resize-none rounded-[1.25rem] border border-border
               bg-background py-1.5 pl-3.5 pr-11 text-body leading-6 outline-none transition
               placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/25"
      ></textarea>
      <button
        type="submit"
        class="absolute bottom-1 right-1 grid h-7 w-7 place-items-center rounded-full bg-primary text-primary-foreground
               transition hover:bg-primary-hover disabled:bg-muted-foreground/30 disabled:text-background
               focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        disabled={sending || !draft.trim() || !view.canSend || Boolean(disabledReason)}
        aria-label="Send"
      ><SendIcon class="h-4 w-4" strokeWidth={2.75} /></button>
    </form>
    <p id="portal-composer-hint" class="sr-only">
      Enter to send, Shift+Enter for a new line. Local sandbox and approvals still apply.
    </p>
  {/if}
</footer>
