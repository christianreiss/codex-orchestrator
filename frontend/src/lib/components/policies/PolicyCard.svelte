<script lang="ts">
  import type { Snippet } from "svelte";
  let { id, title, description, scope, details, children }: {
    id: string; title: string; description: string; scope: string; details?: string; children: Snippet;
  } = $props();
</script>
<section {id} aria-labelledby={`${id}-heading`} class="scroll-mt-24 rounded-xl border bg-card p-5 sm:p-6">
  <p class="mb-2 text-xs font-medium text-muted-foreground">{scope}</p>
  <h3 id={`${id}-heading`} class="text-base font-semibold">{title}</h3>
  <p class="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
  <div class="mt-5 space-y-4">{@render children()}</div>
  {#if details}
    <details class="mt-4 border-t pt-3 text-sm">
      <summary class="w-fit cursor-pointer rounded-sm text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">Details</summary>
      <p class="mt-2 max-w-2xl leading-relaxed text-muted-foreground">{details}</p>
    </details>
  {/if}
</section>
