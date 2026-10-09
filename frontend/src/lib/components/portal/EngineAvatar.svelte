<script lang="ts">
  import { ENGINE_META } from "$lib/constants/engines";
  import type { Engine, Presence } from "$lib/portal/types";
  import PresenceDot from "./PresenceDot.svelte";
  import codexLogo from "$lib/assets/engines/codex.svg?no-inline";
  import claudeLogo from "$lib/assets/engines/claude.svg?no-inline";
  import grokLogo from "$lib/assets/engines/grok.svg?no-inline";
  const logos = { codex: codexLogo, claude: claudeLogo, grok: grokLogo };

  let {
    engine,
    presence = "listening",
    size = "md",
    badge = false,
    logo = false,
  }: { engine: Engine; presence?: Presence; size?: "xs" | "sm" | "md"; badge?: boolean; logo?: boolean } = $props();

  const dim = $derived(presence === "offline" || presence === "ended");
</script>

<span class="relative inline-grid shrink-0" aria-hidden={logo ? undefined : true}>
  <span
    class="grid place-items-center rounded-full font-semibold tracking-wide text-white transition-[filter]
           {size === 'xs' ? 'h-7 w-7 text-[9px]' : size === 'sm' ? 'h-9 w-9 text-[10px]' : 'h-11 w-11 text-[11px]'}
           {ENGINE_META[engine].color}
           {dim ? 'grayscale' : ''}"
  >{#if logo}<img src={logos[engine]} alt={ENGINE_META[engine].label} class="h-[55%] w-[55%] brightness-0 invert" />{:else}{ENGINE_META[engine].avatar}{/if}</span>
  {#if badge}
    <!-- Presence rides on the avatar, Messages style, instead of taking its own column. -->
    <span class="absolute -bottom-0.5 -right-0.5 grid h-3.5 w-3.5 place-items-center rounded-full bg-card">
      <PresenceDot {presence} />
    </span>
  {/if}
</span>
