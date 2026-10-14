<script lang="ts">
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import Pause from "@lucide/svelte/icons/pause";
  import MessageCircleQuestion from "@lucide/svelte/icons/message-circle-question";
  import CircleHelp from "@lucide/svelte/icons/circle-help";
  import Wifi from "@lucide/svelte/icons/wifi";
  import WifiOff from "@lucide/svelte/icons/wifi-off";
  import Square from "@lucide/svelte/icons/square";
  import type { ActivityState, Presence } from "$lib/portal/types";
  import { ACTIVITY_LABEL } from "$lib/portal/activity";

  let { presence, activity = null, label = "" }: {
    presence: Presence;
    activity?: ActivityState | null;
    label?: string;
  } = $props();

  // Connection loss wins over cached activity; expired observations stay unknown.
  const state = $derived(presence === "offline" || presence === "ended" ? presence : activity ?? presence);
  const icons = { working: LoaderCircle, idle: Pause, waiting: MessageCircleQuestion, unknown: CircleHelp, listening: Wifi, offline: WifiOff, ended: Square };
  const Icon = $derived(icons[state]);
  const description = $derived(label || (state in ACTIVITY_LABEL ? ACTIVITY_LABEL[state as ActivityState] : state === "listening" ? "Online" : state === "offline" ? "Offline" : "Ended"));
</script>

<span role="img" aria-label={description} title={description} data-client-status={state}
  class="grid h-5 w-5 place-items-center rounded-full border bg-card {state === 'waiting' ? 'text-warning' : state === 'working' || state === 'listening' ? 'text-success' : 'text-muted-foreground'}">
  <Icon class="h-3 w-3 {state === 'working' ? 'motion-safe:animate-spin' : ''}" aria-hidden="true" />
</span>
