<script lang="ts">
  import SendIcon from "@lucide/svelte/icons/arrow-up";
  import type { Agent } from "$lib/portal/types";
  import { presenceView } from "$lib/portal/presence";

  let {
    agent,
    now,
    sending,
    onsend,
    input = $bindable(null),
  }: {
    agent: Agent;
    now: number;
    sending: boolean;
    onsend: (text: string) => void;
    input?: HTMLTextAreaElement | null;
  } = $props();

  let text = $state("");
  const view = $derived(presenceView(agent, now));
  const closing = $derived(agent.close?.state === "pending");

  const placeholder = $derived(
    closing ? "Closing — say something if you need to stop it"
    : agent.pending_prompt ? "Answer the agent…"
    : "Instruct the running agent…",
  );

  function submit() {
    const value = text.trim();
    if (!value || sending) return;
    onsend(value);
    text = "";
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
      This session is finished and stays readable for 24 hours.
    </p>
  {:else if !view.canSend}
    <p class="py-2 text-center text-body-sm text-muted-foreground">
      <strong class="font-semibold text-foreground">{view.label}.</strong> {view.detail}
    </p>
  {:else}
    <form
      class="mx-auto flex max-w-3xl items-end gap-2"
      onsubmit={(event) => { event.preventDefault(); submit(); }}
    >
      <label class="sr-only" for="portal-composer">Message this agent</label>
      <textarea
        bind:this={input}
        bind:value={text}
        id="portal-composer"
        rows="1"
        maxlength="32768"
        {placeholder}
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
        disabled={sending || !text.trim()}
        aria-label="Send"
      ><SendIcon class="h-5 w-5" /></button>
    </form>
    <p class="mt-1.5 text-center text-[10px] text-muted-foreground">
      Enter to send · Shift+Enter for a new line · local sandbox and approvals still apply
    </p>
  {/if}
</footer>
