<script lang="ts">
  import { cn } from "$lib/utils/cn";

  type Props = {
    value: unknown;
    class?: string;
  };
  let { value, class: className }: Props = $props();

  const pretty = $derived.by(() => {
    if (value === null || value === undefined) return "null";
    if (typeof value === "string") {
      // Try to parse string as JSON first; fall back to raw.
      try {
        return JSON.stringify(JSON.parse(value), null, 2);
      } catch {
        return value;
      }
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  });
</script>

<pre
  class={cn(
    "max-h-80 overflow-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground",
    className,
  )}>{pretty}</pre>
