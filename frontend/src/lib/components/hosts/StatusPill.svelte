<script lang="ts">
  import { cn } from "$lib/utils/cn";
  import type { Snippet } from "svelte";

  type Tone = "online" | "offline" | "warning" | "info" | "muted" | "secure" | "insecure";
  type Props = {
    tone?: Tone;
    label?: string;
    children?: Snippet;
    class?: string;
  };

  let { tone = "info", label, children, class: className }: Props = $props();

  const palette: Record<Tone, string> = {
    online: "border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300",
    offline: "border-red-600/30 bg-red-600/10 text-red-700 dark:text-red-300",
    warning: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    info: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
    muted: "border-border bg-muted text-muted-foreground",
    secure: "border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300",
    insecure: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  };

  const dot: Record<Tone, string> = {
    online: "bg-emerald-500",
    offline: "bg-red-500",
    warning: "bg-amber-500",
    info: "bg-blue-500",
    muted: "bg-muted-foreground/50",
    secure: "bg-emerald-500",
    insecure: "bg-amber-500",
  };
</script>

<span
  class={cn(
    "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
    palette[tone],
    className,
  )}
>
  <span class={cn("h-1.5 w-1.5 rounded-full", dot[tone])} aria-hidden="true"></span>
  {#if children}{@render children()}{:else}{label ?? ""}{/if}
</span>
