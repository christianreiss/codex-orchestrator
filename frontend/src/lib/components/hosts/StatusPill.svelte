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
    online: "border-success/25 bg-success-muted text-success-muted-foreground",
    offline: "border-destructive/25 bg-destructive-muted text-destructive-muted-foreground",
    warning: "border-warning/25 bg-warning-muted text-warning-muted-foreground",
    info: "border-info/25 bg-info-muted text-info-muted-foreground",
    muted: "border-border bg-muted text-muted-foreground",
    secure: "border-success/25 bg-success-muted text-success-muted-foreground",
    insecure: "border-warning/25 bg-warning-muted text-warning-muted-foreground",
  };

  const dot: Record<Tone, string> = {
    online: "bg-success",
    offline: "bg-destructive",
    warning: "bg-warning",
    info: "bg-info",
    muted: "bg-muted-foreground/50",
    secure: "bg-success",
    insecure: "bg-warning",
  };
</script>

<span
  class={cn(
    "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium",
    palette[tone],
    className,
  )}
>
  <span class={cn("h-1.5 w-1.5 rounded-full", dot[tone])} aria-hidden="true"></span>
  {#if children}{@render children()}{:else}{label ?? ""}{/if}
</span>
