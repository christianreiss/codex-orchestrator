<script lang="ts">
  /**
   * One engine's block inside "Per-host exceptions": a badge, the override rows
   * (children, since they carry mutation wiring) and the binary digest.
   */
  import { engineLabel } from "$lib/constants/engines";
  import EngineBadge from "./EngineBadge.svelte";
  import type { Snippet } from "svelte";
  import type { HostEngine } from "$lib/api/types";

  type Props = { engine: HostEngine; digest: string; children: Snippet };
  let { engine, digest, children }: Props = $props();
</script>

<section aria-label={`${engineLabel(engine)} engine overrides`} class="min-w-0">
  <div class="mb-1 flex items-center justify-between gap-2">
    <EngineBadge {engine} />
    <span class="font-mono text-caption text-muted-foreground" title="Binary digest">{digest}</span>
  </div>
  {@render children()}
</section>
