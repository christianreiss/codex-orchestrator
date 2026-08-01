<script lang="ts">
  import LoaderIcon from "@lucide/svelte/icons/loader-circle";
  import type { Agent } from "$lib/portal/types";
  import { clockTime, shortAge } from "../../lib/browser";

  let { agent, now, busy, onforce }: { agent: Agent; now: number; busy: boolean; onforce: () => void } = $props();

  const state = $derived(agent.close?.state ?? "pending");
  const since = $derived(agent.close?.requested_at ?? agent.close_requested_at ?? "");
  // Escalation is offered rather than pushed: the button only turns loud once
  // the cooperative path has plainly had long enough.
  const stalled = $derived(state === "pending" && since ? Date.parse(since) < now - 30_000 : false);
</script>

<div
  class="flex items-center gap-2 border-b px-3 py-2 text-caption sm:px-4
         {state === 'undeliverable'
           ? 'border-destructive/25 bg-destructive-muted text-destructive-muted-foreground'
           : 'border-warning/25 bg-warning-muted text-warning-muted-foreground'}"
>
  {#if state === "pending"}
    <LoaderIcon class="h-3.5 w-3.5 animate-spin" />
    <span class="min-w-0 flex-1">Closing — asked {shortAge(since, now)} ago, waiting for the agent to pick it up</span>
  {:else if state === "acknowledged"}
    <span class="min-w-0 flex-1">Closed by you at {clockTime(since)} · the terminal is still open</span>
  {:else}
    <span class="min-w-0 flex-1">The close could not be delivered to this agent</span>
  {/if}

  <button
    type="button"
    class="shrink-0 rounded-md px-2.5 py-1 text-caption font-semibold transition disabled:opacity-50
           focus:outline-none focus-visible:ring-2 focus-visible:ring-ring
           {state === 'undeliverable' || stalled
             ? 'bg-destructive text-destructive-foreground hover:opacity-90'
             : 'text-current underline underline-offset-2 hover:opacity-80'}"
    onclick={onforce}
    disabled={busy}
  >Force end</button>
</div>
