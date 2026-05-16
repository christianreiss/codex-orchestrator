<script lang="ts">
  import { cn } from "$lib/utils/cn";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import Cpu from "@lucide/svelte/icons/cpu";

  type Props = {
    engine: string;
    /** Show as muted (engine present but no auth digest). */
    dim?: boolean;
    class?: string;
  };
  let { engine, dim = false, class: className }: Props = $props();

  const label = $derived(
    engine === "codex" ? "Codex" : engine === "claude" ? "Claude" : engine,
  );
</script>

<span
  title={label + (dim ? " — not authed" : "")}
  class={cn(
    "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
    dim
      ? "border-border bg-muted text-muted-foreground"
      : engine === "claude"
        ? "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300"
        : "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    className,
  )}
>
  {#if engine === "claude"}
    <Sparkles class="h-3 w-3" />
  {:else}
    <Cpu class="h-3 w-3" />
  {/if}
  {label}
</span>
