<script lang="ts">
  import type { Agent } from "$lib/portal/types";
  import { shortPath } from "../../lib/browser";
  import Modal from "./Modal.svelte";

  let {
    agent,
    open = $bindable(false),
    mode = $bindable<"cooperative" | "force">("cooperative"),
    busy,
    onconfirm,
  }: {
    agent: Agent;
    open?: boolean;
    mode?: "cooperative" | "force";
    busy: boolean;
    onconfirm: (mode: "cooperative" | "force", note: string) => void;
  } = $props();

  const DEFAULT_NOTE = "Wrapping up — please save your work and stop at a good point.";
  let note = $state(DEFAULT_NOTE);

  $effect(() => {
    if (open) note = DEFAULT_NOTE;
  });
</script>

<Modal bind:open labelledBy="close-dialog-title">
  <div class="p-5">
    <h2 id="close-dialog-title" class="text-h3">
      {mode === "force" ? "Force end this session?" : "Close this channel?"}
    </h2>
    <p class="mt-1 text-body-sm text-muted-foreground">
      {agent.engine === "codex" ? "Codex" : "Claude"} · {agent.username}@{agent.host} · {shortPath(agent.cwd)}
    </p>

    {#if mode === "force"}
      <p class="mt-4 text-body-sm">
        The session ends immediately and becomes read-only. The agent gets no chance to wrap up, and its
        terminal is left exactly as it is.
      </p>
    {:else}
      <label class="mt-4 block">
        <span class="text-caption font-medium">Note delivered to the agent</span>
        <textarea
          bind:value={note}
          rows="3"
          maxlength="1000"
          class="mt-1 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-body-sm
                 outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/30"
        ></textarea>
      </label>
      <p class="mt-1 text-caption text-muted-foreground">
        The agent is asked to finish and leave the relay. Its terminal stays open.
      </p>
    {/if}

    <div class="mt-5 flex justify-end gap-2">
      <button
        type="button"
        class="rounded-md px-3 py-1.5 text-caption font-medium text-muted-foreground transition
               hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onclick={() => (open = false)}
      >Cancel</button>
      <button
        type="button"
        class="rounded-md bg-destructive px-3 py-1.5 text-caption font-semibold text-destructive-foreground
               transition hover:opacity-90 disabled:opacity-50 focus:outline-none focus-visible:ring-2
               focus-visible:ring-ring"
        disabled={busy}
        onclick={() => onconfirm(mode, note)}
      >{mode === "force" ? "Force end" : "Close channel"}</button>
    </div>
  </div>
</Modal>
