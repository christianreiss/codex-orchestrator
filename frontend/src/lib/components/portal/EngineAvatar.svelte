<script lang="ts">
  import { ENGINE_META } from "$lib/constants/engines";
  import type { ActivityState, Engine, Presence } from "$lib/portal/types";
  import ClientStatusIcon from "./ClientStatusIcon.svelte";
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
    activity = null,
    status = "",
  }: { engine: Engine; presence?: Presence; size?: "xs" | "sm" | "md"; badge?: boolean; logo?: boolean; activity?: ActivityState | null; status?: string } = $props();

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
    <span class="absolute -bottom-1 -right-1">
      <ClientStatusIcon {presence} {activity} label={status} />
    </span>
  {/if}
</span>
