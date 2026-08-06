<script lang="ts">
  import SendIcon from "@lucide/svelte/icons/arrow-up";
  import type { Agent } from "$lib/portal/types";
  import { presenceView } from "$lib/portal/presence";

  let {
    agent,
    now,
    sending,
    draft,
    ondraft,
    onsend,
    input = $bindable(null),
  }: {
    agent: Agent;
    now: number;
    sending: boolean;
    /** Owned by the portal store so it survives this component unmounting. */
    draft: string;
    ondraft: (text: string) => void;
    onsend: (text: string) => Promise<boolean>;
    input?: HTMLTextAreaElement | null;
  } = $props();

  const view = $derived(presenceView(agent, now));
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
    if (!value || sending || !view.canSend) return;
    void onsend(value);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }
</script>

<footer class="border-t border-border bg-card px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 sm:px-4">
  {#if agent.read_only}
    <p class="py-2 text-center text-body-sm text-muted-foreground">
      {view.detail}
    </p>
  {:else}
    <!--
      The form stays mounted when the agent stops accepting instructions. It
      used to be replaced outright by this sentence, so a presence flip while
      someone was typing destroyed what they had written.
    -->
    {#if !view.canSend}
      <p class="pb-2 text-center text-body-sm text-muted-foreground">
        <strong class="font-semibold text-foreground">{view.label}.</strong> {view.detail}
      </p>
    {/if}
    <form
      class="mx-auto flex max-w-3xl items-end gap-2"
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
        onkeydown={onKeydown}
        class="max-h-40 min-h-[2.75rem] flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2.5
               text-body outline-none transition placeholder:text-muted-foreground focus:border-ring
               focus:ring-2 focus:ring-ring/30"
      ></textarea>
      <button
        type="submit"
        class="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground
               transition hover:bg-primary-hover disabled:opacity-40 focus:outline-none
               focus-visible:ring-2 focus-visible:ring-ring"
        disabled={sending || !draft.trim() || !view.canSend}
        aria-label="Send"
      ><SendIcon class="h-5 w-5" /></button>
    </form>
    <p class="mt-1.5 text-center text-[10px] text-muted-foreground">
      Enter to send · Shift+Enter for a new line · local sandbox and approvals still apply
    </p>
  {/if}
</footer>
