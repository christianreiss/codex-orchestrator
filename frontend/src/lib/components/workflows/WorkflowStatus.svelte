<script lang="ts">
  import { statusLabel } from "./helpers";
  let { value }: { value: string | null | undefined } = $props();
  const tone = $derived(value === "succeeded" || value === "met" ? "border-success/40 bg-success-muted text-success-muted-foreground" : ["failed", "not_met"].includes(value ?? "") ? "border-destructive/40 bg-destructive-muted text-destructive-muted-foreground" : ["partial", "uncertain", "unknown", "blocked", "evaluating", "unverified"].includes(value ?? "") ? "border-warning/40 bg-warning-muted text-warning-muted-foreground" : "border-border bg-muted text-muted-foreground");
</script>
<span class={`inline-flex max-w-full items-center rounded-sm border px-2 py-0.5 text-caption font-medium ${tone}`}>{statusLabel(value)}</span>
