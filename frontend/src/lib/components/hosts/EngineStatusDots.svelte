<script lang="ts">
  import { ENGINES, ENGINE_META } from "$lib/constants/engines";
  import { useFleetEngines } from "$lib/engines/fleet-engines";
  import type { HostListItem, HostEngineReadinessReason } from "$lib/api/types";
  import { hostEngines } from "$lib/api/hosts";
  let { host }: { host: HostListItem } = $props();
  const fleet = useFleetEngines();
  const engines = $derived(hostEngines(host));
  const reasons: Record<HostEngineReadinessReason, string> = {
    not_assigned: "not assigned", fleet_disabled: "disabled fleet-wide", auth_missing: "auth missing",
    cli_unknown: "CLI version or target unknown", cli_outdated: "CLI not at target version",
    wrapper_unknown: "wrapper version or target unknown", wrapper_outdated: "wrapper not at target version",
  };
</script>
<span class="inline-flex items-center gap-3">
  {#each ENGINES as engine}
    {@const readiness = host.engine_readiness?.[engine]}
    {@const assigned = engines.includes(engine)}
    {@const suspended = !$fleet.isEnabled(engine)}
    {@const state = !assigned || suspended ? "inactive" : readiness?.state ?? "attention"}
    {@const description = !assigned ? "not assigned" : suspended ? "disabled fleet-wide" : !readiness ? "status unknown" : readiness.state === "ready" ? "ready" : readiness.reasons.map((reason) => reasons[reason] ?? reason).join(", ")}
    {@const versions = readiness ? ` · CLI ${readiness.cli_version ?? "unknown"} / target ${readiness.cli_target ?? "unknown"} · cxx ${readiness.wrapper_version ?? "unknown"} / target ${readiness.wrapper_target ?? "unknown"}` : ""}
    {@const label = `${ENGINE_META[engine].label}: ${description}${versions}`}
    <span class="inline-flex h-4 w-4 items-center justify-center" role="img" aria-label={label} title={label} data-engine={engine} data-state={state}>
      <span class={`h-2 w-2 rounded-full ${state === "ready" ? "bg-green-500" : state === "attention" ? "bg-yellow-500" : "bg-slate-400"}`} aria-hidden="true"></span>
    </span>
  {/each}
</span>
