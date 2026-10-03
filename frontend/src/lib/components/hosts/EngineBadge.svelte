<script lang="ts">
  import { engineLabel } from "$lib/constants/engines";
  import { cn } from "$lib/utils/cn";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import Cpu from "@lucide/svelte/icons/cpu";
  import Zap from "@lucide/svelte/icons/zap";

  type Props = {
    engine: string;
    /** Show as muted (engine present but no auth digest). */
    dim?: boolean;
    /** The engine is switched off for the whole fleet. */
    fleetDisabled?: boolean;
    class?: string;
  };
  let { engine, dim = false, fleetDisabled = false, class: className }: Props = $props();

  const label = $derived(
    engineLabel(engine),
  );
</script>

<span
  title={label + (fleetDisabled ? " — disabled fleet-wide" : dim ? " — not authed" : "")}
  class={cn(
    "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
    fleetDisabled
      ? "border-dashed border-border bg-muted text-muted-foreground line-through decoration-muted-foreground/60"
      : dim
      ? "border-border bg-muted text-muted-foreground"
      : engine === "grok"
        ? "border-persona-grok/30 bg-persona-grok/10 text-foreground"
        : engine === "claude"
        ? "border-persona-claude/30 bg-persona-claude/10 text-foreground"
        : "border-persona-codex/30 bg-persona-codex/10 text-foreground",
    className,
  )}
>
  {#if engine === "claude"}
    <Sparkles class="h-3 w-3" />
  {:else if engine === "grok"}
    <Zap class="h-3 w-3" />
  {:else}
    <Cpu class="h-3 w-3" />
  {/if}
  {label}
  {#if fleetDisabled}<span class="sr-only">(disabled fleet-wide)</span>{/if}
</span>
