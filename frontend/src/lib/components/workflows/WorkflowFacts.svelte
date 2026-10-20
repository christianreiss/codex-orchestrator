<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { displayValue, safeWorkflowUrl } from "./helpers";
  let { values, label = "Result facts" }: { values: Record<string, unknown>; label?: string } = $props();
  let copied = $state(""), error = $state("");
  async function copy(key: string, value: unknown) { try { await navigator.clipboard.writeText(displayValue(value)); copied = key; error = ""; } catch { error = "Could not copy. Select and copy the value below."; } }
</script>
<dl class="divide-y" aria-label={label}>{#each Object.entries(values) as [key, value]}<div class="grid min-w-0 gap-1 py-3 sm:grid-cols-[minmax(8rem,1fr)_minmax(0,3fr)]"><dt class="break-words text-body font-medium">{key.replaceAll("_", " ")}</dt><dd class="min-w-0"><div class="flex min-w-0 items-start gap-2">{#if safeWorkflowUrl(value)}<a class="min-w-0 flex-1 break-all text-body underline" href={safeWorkflowUrl(value)!} rel="noopener noreferrer" target="_blank">{displayValue(value)}</a>{:else}<pre class="min-w-0 flex-1 whitespace-pre-wrap break-words font-sans text-body [overflow-wrap:anywhere]">{displayValue(value)}</pre>{/if}<Button size="sm" variant="ghost" aria-label={`Copy ${key}`} onclick={() => copy(key,value)}>Copy</Button></div></dd></div>{/each}</dl>
<p role="status" class="text-body-sm text-muted-foreground">{copied ? `${copied} copied.` : ""}</p>{#if error}<p role="alert" class="text-body-sm text-destructive">{error}</p>{/if}
