<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import { cn } from "$lib/utils/cn";

  type Props = {
    ok: boolean;
    code?: string | null;
    message?: string | null;
    class?: string;
  };
  let { ok, code, message, class: className }: Props = $props();

  const variant = $derived(ok ? "success" : "destructive");
  const label = $derived(ok ? "ok" : "fail");
  const tooltip = $derived(
    ok
      ? null
      : [code, message].filter((x) => x !== null && x !== undefined && String(x).trim() !== "").join(" — "),
  );
</script>

<span class={cn("inline-flex items-center gap-1.5", className)} title={tooltip ?? undefined}>
  <Badge variant={variant as "success" | "destructive"} class="uppercase tracking-wide">{label}</Badge>
  {#if !ok && code}
    <code class="font-mono text-[11px] text-muted-foreground">{code}</code>
  {/if}
</span>
