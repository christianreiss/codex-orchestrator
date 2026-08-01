<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import { Label } from "$lib/components/ui/label";
  import { CopyButton } from "$lib/components/ui/copy-button";
  import { cn } from "$lib/utils/cn";

  type Props = Omit<HTMLAttributes<HTMLDivElement>, "id"> & {
    value: string;
    label?: string;
    id?: string;
    rows?: number;
    wrap?: boolean;
    copyable?: boolean;
    expiresAt?: string;
    class?: string;
  };

  let {
    value,
    label,
    id,
    rows = 4,
    wrap = false,
    copyable = true,
    expiresAt,
    class: className,
    ...rest
  }: Props = $props();

  // $props.id() must be its own top-level binding (it can't be a destructuring
  // default), so the fallback is composed via a derived value instead.
  const autoId = $props.id();
  const blockId = $derived(id ?? autoId);
</script>

<div class={cn("space-y-1.5", className)} {...rest}>
  {#if label || copyable}
    <div class="flex items-center justify-between gap-2">
      {#if label}<Label for={blockId}>{label}</Label>{/if}
      {#if copyable}
        <CopyButton {value} label="Copy" size="sm" variant="outline" class={cn(!label && "ml-auto")} />
      {/if}
    </div>
  {/if}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <pre
    id={blockId}
    role={wrap ? undefined : "region"}
    aria-label={wrap ? undefined : (label ?? "Code block")}
    tabindex={wrap ? undefined : 0}
    class={cn(
      "rounded-md border border-input bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground",
      wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto whitespace-pre",
    )}
    style={`min-height: calc(${rows} * 1.25rem + 1.5rem)`}
  >{value}</pre>
  {#if expiresAt}
    <p class="text-[11px] text-muted-foreground">Expires {expiresAt}.</p>
  {/if}
</div>
