<script lang="ts">
  /** Advanced: network and IP binding. */
  import { useQueryClient } from "@tanstack/svelte-query";
  import { Button } from "$lib/components/ui/button";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import {
    createCurlInsecureToggleMutation,
    createReleaseIpBindingMutation,
    createReverseDnsMutation,
    createRoamingToggleMutation,
  } from "$lib/api/hosts";
  import type { HostDetail } from "$lib/api/types";
  import ToggleRow from "../ToggleRow.svelte";
  import { run, runQuiet } from "./actions";

  type Props = { host: HostDetail; id: string };
  let { host, id }: Props = $props();

  const qc = useQueryClient();
  const roaming = createRoamingToggleMutation(qc);
  const curlInsecure = createCurlInsecureToggleMutation(qc);
  const reverseDns = createReverseDnsMutation(qc);
  const release = createReleaseIpBindingMutation(qc);
  let releaseOpen = $state(false);

  type Mode = "global" | "enabled" | "disabled";
  const MODES: Array<{ id: Mode; label: string }> = [
    { id: "global", label: "Fleet default" },
    { id: "enabled", label: "Always" },
    { id: "disabled", label: "Never" },
  ];
  const mode = $derived.by<Mode>(() => {
    const raw = (host.reverse_dns_mode ?? "").toString().toLowerCase();
    if (raw === "enabled" || raw === "1" || raw === "true") return "enabled";
    if (raw === "disabled" || raw === "0" || raw === "false") return "disabled";
    return "global";
  });

  async function setMode(next: Mode): Promise<void> {
    if (next !== mode) await runQuiet($reverseDns.mutateAsync({ id, mode: next }));
  }
  async function doRelease(): Promise<void> {
    await run("IP binding released", $release.mutateAsync({ id }), { rethrow: true });
    releaseOpen = false;
  }
</script>

<div>
  <h3 class="mb-1 text-h3">Network and IP</h3>
  <dl class="mb-2 flex flex-wrap gap-x-6 gap-y-1 text-body-sm text-muted-foreground">
    <div><dt class="mr-1.5 inline">IPv4</dt><dd class="inline font-mono">{host.ip4 ?? "none"}</dd></div>
    <div><dt class="mr-1.5 inline">IPv6</dt><dd class="inline font-mono">{host.ip6 ?? "none"}</dd></div>
  </dl>
  <ToggleRow
    label="Allow IP changes"
    note="Roaming: the host may connect from a new IP address without its binding being released first."
    checked={host.allow_roaming_ips}
    onchange={(v) => runQuiet($roaming.mutateAsync({ id, value: v }))}
  />
  <ToggleRow
    label="Skip TLS check"
    note="Curl insecure: the host config skips TLS verification when syncing, and the install command uses curl -k."
    checked={host.curl_insecure}
    onchange={(v) => runQuiet($curlInsecure.mutateAsync({ id, value: v }))}
  />
  <div class="flex flex-wrap items-center justify-between gap-2 border-b py-2.5">
    <span>
      <span class="block text-body">Reverse DNS lookup</span>
      <span class="block text-body-sm text-muted-foreground">Require the connecting IP to match the host's DNS records (forward and PTR).</span>
    </span>
    <div class="inline-flex overflow-hidden rounded-md border border-input" role="group" aria-label="Reverse DNS lookup">
      {#each MODES as option (option.id)}
        <button
          type="button"
          class="px-2.5 py-1.5 text-body-sm transition-colors hover:bg-accent {mode === option.id ? 'bg-foreground text-background hover:bg-foreground' : 'bg-background'}"
          disabled={$reverseDns.isPending}
          aria-pressed={mode === option.id}
          onclick={() => void setMode(option.id)}
        >{option.label}</button>
      {/each}
    </div>
  </div>
  {#if host.ip4 || host.ip6}
    <div class="flex flex-wrap items-center justify-between gap-2 py-2.5">
      <span>
        <span class="block text-body">Release IP binding</span>
        <span class="block text-body-sm text-muted-foreground">Forget the stored addresses; the next valid request binds the new ones.</span>
      </span>
      <Button variant="outline" size="sm" onclick={() => (releaseOpen = true)}>Release IP binding</Button>
    </div>
  {/if}
</div>

<ConfirmDialog
  bind:open={releaseOpen}
  title="Release IP binding?"
  description="Clear the stored IPv4 and IPv6 bindings for this host. Its next valid authenticated request will establish the new binding; security and roaming settings stay unchanged."
  confirmLabel="Release binding"
  destructive
  busy={$release.isPending}
  onConfirm={doRelease}
/>
