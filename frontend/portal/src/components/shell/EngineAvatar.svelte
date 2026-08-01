<script lang="ts">
  import type { Engine, Presence } from "$lib/portal/types";

  let {
    engine,
    presence = "listening",
    size = "md",
  }: { engine: Engine; presence?: Presence; size?: "sm" | "md" } = $props();

  const dim = $derived(presence === "offline" || presence === "ended");
</script>

<span
  class="grid shrink-0 place-items-center rounded-lg font-semibold tracking-wide text-white transition-[filter]
         {size === 'sm' ? 'h-8 w-8 text-[10px]' : 'h-10 w-10 text-[11px]'}
         {engine === 'codex' ? 'bg-persona-codex' : 'bg-persona-claude'}
         {dim ? 'grayscale' : ''}"
  aria-hidden="true"
>{engine === "codex" ? "CX" : "CL"}</span>
