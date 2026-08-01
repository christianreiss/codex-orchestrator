<script lang="ts">
  import type { Component, Snippet } from "svelte";

  let {
    icon: Icon,
    title,
    body,
    tone = "muted",
    children,
  }: {
    icon: Component<{ class?: string }>;
    title: string;
    body: string;
    tone?: "muted" | "destructive";
    children?: Snippet;
  } = $props();
</script>

<main class="grid h-full place-content-center px-8 text-center">
  <div
    class="mx-auto grid h-12 w-12 place-items-center rounded-xl border border-border
           {tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground'}"
  ><Icon class="h-6 w-6" /></div>
  <h1 class="mt-4 text-h3">{title}</h1>
  <p class="mx-auto mt-2 max-w-md text-body-sm leading-relaxed text-muted-foreground">{body}</p>
  {#if children}<div class="mt-4">{@render children()}</div>{/if}
</main>
