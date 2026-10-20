<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { displayValue, factLabel } from "./helpers";
  import WorkflowValue from "./WorkflowValue.svelte";
  let { values, label = "Result facts", groupTitle }: { values: Record<string, unknown>; label?: string; groupTitle?: string } = $props();
  let copied = $state(""), error = $state(""), showRaw = $state(false);
  async function copy(key: string, value: unknown) { try { await navigator.clipboard.writeText(displayValue(value)); copied = key; error = ""; } catch { error = "Could not copy. Select and copy the value below."; } }
</script>
<dl class="divide-y" aria-label={label}>{#each Object.entries(values) as [key, value]}<div class={`min-w-0 py-3 ${value !== null && typeof value === "object" && !Array.isArray(value) ? "" : "grid gap-1 sm:grid-cols-[minmax(8rem,1fr)_minmax(0,3fr)]"}`}>
  {#if value !== null && typeof value === "object" && !Array.isArray(value)}
    <dt class={key === groupTitle ? "sr-only" : "mb-3 break-words text-body font-semibold"}>{factLabel(key)}</dt><dd class="min-w-0"><WorkflowValue {value} /><Button class="mt-2" size="sm" variant="ghost" aria-label={`Copy ${key}`} onclick={() => copy(key,value)}>Copy {factLabel(key)}</Button></dd>
  {:else}
    <dt class="break-words text-body font-medium">{factLabel(key)}</dt><dd class="min-w-0"><div class="flex min-w-0 items-start gap-2"><div class="min-w-0 flex-1"><WorkflowValue {value} /></div><Button size="sm" variant="ghost" aria-label={`Copy ${key}`} onclick={() => copy(key,value)}>Copy</Button></div></dd>
  {/if}
</div>{/each}</dl>
<details class="mt-3 min-w-0 text-body-sm" ontoggle={e => showRaw = e.currentTarget.open}><summary class="cursor-pointer py-2">Raw JSON · {label}</summary>{#if showRaw}<pre class="mt-2 whitespace-pre-wrap break-words rounded-md border bg-muted p-3 font-mono text-body-sm [overflow-wrap:anywhere]">{displayValue(values)}</pre><Button class="mt-2" size="sm" variant="outline" onclick={() => copy("Raw JSON",values)}>Copy JSON</Button>{/if}</details>
<p role="status" class="text-body-sm text-muted-foreground">{copied ? `${copied} copied.` : ""}</p>{#if error}<p role="alert" class="text-body-sm text-destructive">{error}</p>{/if}
