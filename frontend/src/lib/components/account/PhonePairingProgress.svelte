<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import Circle from "@lucide/svelte/icons/circle";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  import { cn } from "$lib/utils/cn";

  let { generatedAt, pairedDevice, expired, busy, failed }: {
    generatedAt: string | null;
    pairedDevice: { name: string; created_at: string } | null;
    expired: boolean;
    busy: boolean;
    failed: boolean;
  } = $props();
  const stages = $derived([
    { id: "code", label: "Pairing code ready", at: generatedAt, hint: failed ? "Could not create a code. Try again below." : "Creating your one-time pairing code…" },
    { id: "paired", label: "Phone paired", at: pairedDevice?.created_at ?? null, hint: expired ? "The code expired. Generate a new one below." : "Waiting for your phone. Open Orchestrator Companion and scan the code." },
  ]);
  const waitingIndex = $derived(stages.findIndex((stage) => !stage.at));
</script>

<ol class="space-y-0 rounded-md border p-3" aria-label="Phone pairing progress" aria-live="polite">
  {#each stages as stage, i (stage.id)}
    {@const done = Boolean(stage.at)}
    {@const waiting = i === waitingIndex}
    {@const running = waiting && !failed && (!expired || busy)}
    <li class="flex items-start gap-3 py-1.5" aria-current={waiting ? "step" : undefined}>
      <span class={cn(
        "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
        done ? "border-success/40 bg-success-muted text-success-muted-foreground" : running ? "border-primary/40 text-primary" : "border-muted-foreground/30 text-muted-foreground",
      )} aria-hidden="true">
        {#if done}<Check class="h-3 w-3" />
        {:else if running}<LoaderCircle class="h-3 w-3 animate-spin motion-reduce:animate-none" />
        {:else}<Circle class="h-2 w-2" />{/if}
      </span>
      <span class="min-w-0 flex-1">
        <span class={cn("block text-body", done && "font-medium", !done && !waiting && "text-muted-foreground")}>
          {stage.label}<span class="sr-only">{done ? " (done)" : failed ? " (not completed)" : expired ? " (expired)" : waiting ? " (in progress)" : " (pending)"}</span>
        </span>
        <span class="block text-body-sm text-muted-foreground">
          {#if done && stage.at}<Timestamp value={stage.at} />{:else if waiting}{stage.hint}{/if}
        </span>
      </span>
    </li>
  {/each}
</ol>
