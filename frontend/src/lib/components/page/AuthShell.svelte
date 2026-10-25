<script lang="ts">
  import MutationNotice from "$lib/components/feedback/MutationNotice.svelte";
  import BrandMark from "$lib/components/brand/BrandMark.svelte";
  /** The frame for every signed-out or first-run screen: login, reset, CLI approval, setup. */
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";

  type Props = {
    title: string;
    description?: string;
    width?: "sm" | "lg";
    children?: Snippet;
    footer?: Snippet;
  };
  let { title, description, width = "sm", children, footer }: Props = $props();
</script>

<svelte:head><title>{title} · Codex Orchestrator</title></svelte:head>

<main class="auth-scroll flex h-dvh flex-col overflow-y-auto bg-background px-4 py-8 md:px-6">
  <div class={cn("mx-auto my-auto w-full shrink-0 space-y-6", width === "sm" ? "max-w-sm" : "max-w-4xl")}>
    <div class="flex items-center justify-center gap-2 text-body-sm font-medium text-muted-foreground" aria-label="Codex Orchestrator">
      <BrandMark class="h-5 w-5 shrink-0" /> Codex Orchestrator
    </div>
    <section aria-labelledby="auth-heading" class="space-y-6 rounded-md border bg-card p-4 sm:p-6">
      <header class="space-y-2">
        <h1 id="auth-heading" class="break-words text-xl font-semibold tracking-tight">{title}</h1>
        {#if description}<p class="text-body-sm text-muted-foreground">{description}</p>{/if}
      </header>
      <MutationNotice />
      <div class="min-w-0">{@render children?.()}</div>
    </section>
    {#if footer}<footer class="space-y-2 text-center text-body-sm text-muted-foreground">{@render footer()}</footer>{/if}
  </div>
</main>
