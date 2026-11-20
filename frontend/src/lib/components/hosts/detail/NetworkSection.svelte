<script lang="ts">
  /**
   * Network, IP binding and TLS: the first things to check when a host fails to
   * connect, so they sit right after the engines and access, not under
   * "Advanced". Collapsed while the host is healthy; open when it is offline or
   * skips TLS verification, so the likely cause is already in view.
   */
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import { hostStatusKind } from "$lib/api/hosts";
  import type { HostDetail } from "$lib/api/types";
  import NetworkSettings from "./NetworkSettings.svelte";

  type Props = { host: HostDetail; id: string };
  let { host, id }: Props = $props();

  const problem = $derived(hostStatusKind(host) === "offline" || host.curl_insecure === true);
  // Open once per host when a problem points here; after that the operator's toggle wins.
  let open = $state(false);
  let seeded: string | null = null;
  $effect(() => {
    if (seeded !== id) {
      seeded = id;
      open = problem;
    }
  });
</script>

<details bind:open class="group border-t pt-3" data-testid="host-network">
  <summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 text-h2 [&::-webkit-details-marker]:hidden">
    <ChevronRight class="h-4 w-4 transition-transform group-open:rotate-90" aria-hidden="true" />
    Network and access overrides
    <span class="text-body-sm font-normal text-muted-foreground">IP address and binding, TLS, reverse DNS</span>
  </summary>
  <div class="mt-4">
    <NetworkSettings {host} {id} />
  </div>
</details>
