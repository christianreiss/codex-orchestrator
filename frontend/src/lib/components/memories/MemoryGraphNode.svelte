<script lang="ts">
  import { Handle, Position, type NodeProps } from "@xyflow/svelte";
  import Brain from "@lucide/svelte/icons/brain";
  import Cpu from "@lucide/svelte/icons/cpu";
  import FolderKanban from "@lucide/svelte/icons/folder-kanban";
  import Globe2 from "@lucide/svelte/icons/globe-2";
  import Server from "@lucide/svelte/icons/server";
  import Tag from "@lucide/svelte/icons/tag";
  import { relativeTime } from "$lib/utils/format";
  import { cn } from "$lib/utils/cn";
  import { formatCharacters, type AtlasFlowNode } from "./atlas-types";

  let { data, selected }: NodeProps<AtlasFlowNode> = $props();

  const node = $derived(data.memory);
  const isMemory = $derived(node.kind === "memory");
  const subtitle = $derived.by(() => {
    if (node.kind === "memory") return node.summary || node.preview || "No summary yet";
    if (node.kind === "scope") return "Lifecycle scope";
    if (node.kind === "host") return "Host owner";
    if (node.kind === "project") return "Project workspace";
    if (node.kind === "tag") return "Explicit tag";
    return "Source engine";
  });

  const accentClass = $derived.by(() => {
    if (node.kind === "memory") {
      if (node.scope === "shared") return "border-violet-400/55 bg-violet-500/[0.09]";
      if (node.scope === "project") return "border-cyan-400/55 bg-cyan-500/[0.09]";
      return "border-amber-400/55 bg-amber-500/[0.09]";
    }
    if (node.kind === "tag") return "border-emerald-400/45 bg-emerald-500/[0.08]";
    if (node.kind === "engine") return "border-fuchsia-400/45 bg-fuchsia-500/[0.08]";
    return "border-border/80 bg-card/95";
  });

  const iconClass = $derived.by(() => {
    if (node.scope === "shared" || node.kind === "scope") return "text-violet-500 dark:text-violet-300";
    if (node.scope === "project" || node.kind === "project") return "text-cyan-600 dark:text-cyan-300";
    if (node.scope === "host" || node.kind === "host") return "text-amber-600 dark:text-amber-300";
    if (node.kind === "tag") return "text-emerald-600 dark:text-emerald-300";
    return "text-fuchsia-600 dark:text-fuchsia-300";
  });
</script>

<Handle type="target" position={Position.Left} class="!h-1.5 !w-1.5 !border-0 !bg-muted-foreground/40" />

<div
  class={cn(
    "relative h-full w-full overflow-hidden rounded-2xl border shadow-[0_12px_32px_rgba(15,23,42,0.10)] backdrop-blur-sm transition-[border-color,box-shadow,transform] duration-200",
    isMemory ? "px-3.5 py-3" : "flex items-center gap-3 px-3.5 py-2.5",
    accentClass,
    selected && "border-primary ring-2 ring-primary/30 shadow-[0_16px_42px_rgba(79,70,229,0.22)]",
  )}
>
  {#if isMemory}
    <button
      type="button"
      class="absolute inset-0 z-10 cursor-pointer rounded-2xl bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      aria-label={`Open ${node.scope ?? ""} memory ${data.displayKey}`.trim()}
      onclick={(event) => {
        event.stopPropagation();
        data.onSelect(node);
      }}
    ></button>
  {/if}

  <div
    class={cn(
      "grid shrink-0 place-items-center rounded-xl border border-current/15 bg-background/70",
      isMemory ? "h-8 w-8" : "h-9 w-9",
      iconClass,
    )}
  >
    {#if node.kind === "memory"}<Brain class="h-4 w-4" />
    {:else if node.kind === "scope"}<Globe2 class="h-4 w-4" />
    {:else if node.kind === "host"}<Server class="h-4 w-4" />
    {:else if node.kind === "project"}<FolderKanban class="h-4 w-4" />
    {:else if node.kind === "tag"}<Tag class="h-4 w-4" />
    {:else}<Cpu class="h-4 w-4" />{/if}
  </div>

  {#if isMemory}
    <div class="absolute left-12 right-3 top-3 flex min-w-0 items-center justify-between gap-2">
      <p class="truncate font-mono text-[11px] font-semibold text-foreground" title={data.displayKey}>
        {data.displayKey}
      </p>
      <span class="shrink-0 rounded-full border border-current/15 bg-background/70 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
        {node.scope}
      </span>
    </div>
    <p class="mt-2 line-clamp-2 text-[11px] leading-4 text-muted-foreground" title={subtitle}>
      {subtitle}
    </p>
    <div class="absolute inset-x-3 bottom-2.5 flex items-center justify-between gap-2 text-[9px] text-muted-foreground/85">
      <span>{formatCharacters(node.content_length ?? 0)}</span>
      <span>{node.updated_at ? relativeTime(node.updated_at) : "No timestamp"}</span>
    </div>
  {:else}
    <div class="min-w-0">
      <p class="truncate text-xs font-semibold text-foreground" title={node.label}>{node.label}</p>
      <p class="truncate text-[10px] text-muted-foreground">{subtitle}</p>
    </div>
  {/if}
</div>

<Handle type="source" position={Position.Right} class="!h-1.5 !w-1.5 !border-0 !bg-muted-foreground/40" />
