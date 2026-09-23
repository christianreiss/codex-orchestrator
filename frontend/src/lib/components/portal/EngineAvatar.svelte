<script lang="ts">
  import type { Engine, Presence } from "$lib/portal/types";
  import PresenceDot from "./PresenceDot.svelte";

  let {
    engine,
    presence = "listening",
    size = "md",
    badge = false,
  }: { engine: Engine; presence?: Presence; size?: "xs" | "sm" | "md"; badge?: boolean } = $props();

  const dim = $derived(presence === "offline" || presence === "ended");
</script>

<span class="relative inline-grid shrink-0" aria-hidden="true">
  <span
    class="grid place-items-center rounded-full font-semibold tracking-wide text-white transition-[filter]
           {size === 'xs' ? 'h-7 w-7 text-[9px]' : size === 'sm' ? 'h-9 w-9 text-[10px]' : 'h-11 w-11 text-[11px]'}
           {engine === 'codex' ? 'bg-persona-codex' : 'bg-persona-claude'}
           {dim ? 'grayscale' : ''}"
  >{engine === "codex" ? "CX" : "CL"}</span>
  {#if badge}
    <!-- Presence rides on the avatar, Messages style, instead of taking its own column. -->
    <span class="absolute -bottom-0.5 -right-0.5 grid h-3.5 w-3.5 place-items-center rounded-full bg-card">
      <PresenceDot {presence} />
    </span>
  {/if}
</span>
