<script lang="ts">
  /**
   * Chrome for one engine's block inside "Engines & versions": header badge
   * + override rows (passed in as children, since they carry mutation
   * wiring the panel itself doesn't need to know about) + a binary-digest
   * footer line.
   */
  import EngineBadge from "./EngineBadge.svelte";
  import type { Snippet } from "svelte";
  import type { HostEngine } from "$lib/api/types";

  type Props = {
    engine: HostEngine;
    digest: string;
    children: Snippet;
  };
  let { engine, digest, children }: Props = $props();
</script>

<section class="flex min-w-0 flex-col gap-2 rounded-lg border bg-muted/20 p-4">
  <EngineBadge {engine} />
  {@render children()}
  <dl class="text-sm">
    <div class="flex flex-col">
      <dt class="text-[11px] uppercase tracking-wide text-muted-foreground">Binary digest</dt>
      <dd class="font-mono text-xs">{digest}</dd>
    </div>
  </dl>
</section>
