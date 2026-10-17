<script lang="ts">
  /**
   * The engines a host runs, as readable chips. Each chip keeps the readiness
   * contract (role=img, `data-state`, label + versions in `title`) so the state
   * is reachable by keyboard users and tests, not only by colour.
   */
  import { ENGINE_META } from "$lib/constants/engines";
  import { useFleetEngines } from "$lib/engines/fleet-engines";
  import { cn } from "$lib/utils/cn";
  import type { HostListItem, HostEngineReadinessReason } from "$lib/api/types";
  import { hostEngines } from "$lib/api/hosts";

  let { host }: { host: HostListItem } = $props();
  const fleet = useFleetEngines();
  const assigned = $derived(hostEngines(host).filter((engine): engine is keyof typeof ENGINE_META => engine in ENGINE_META));

  const reasons: Record<HostEngineReadinessReason, string> = {
    not_assigned: "not assigned", fleet_disabled: "disabled fleet-wide", auth_missing: "auth missing",
    cli_unknown: "CLI version or target unknown", cli_outdated: "CLI not at target version",
    wrapper_unknown: "wrapper version or target unknown", wrapper_outdated: "wrapper not at target version",
  };
  const dot = { ready: "bg-success", attention: "bg-warning", inactive: "bg-muted-foreground/50" } as const;

  function describe(engine: keyof typeof ENGINE_META) {
    const readiness = host.engine_readiness?.[engine];
    const suspended = !$fleet.isEnabled(engine);
    const state = suspended ? "inactive" : (readiness?.state ?? "attention");
    const description = suspended
      ? "disabled fleet-wide"
      : !readiness ? "status unknown"
      : readiness.state === "ready" ? "ready"
      : readiness.reasons.map((reason) => reasons[reason] ?? reason).join(", ");
    const versions = readiness
      ? ` · CLI ${readiness.cli_version ?? "unknown"} / target ${readiness.cli_target ?? "unknown"} · cxx ${readiness.wrapper_version ?? "unknown"} / target ${readiness.wrapper_target ?? "unknown"}`
      : "";
    return { state, label: `${ENGINE_META[engine].label}: ${description}${versions}` };
  }
</script>

<span class="inline-flex flex-wrap items-center gap-1">
  {#each assigned as engine (engine)}
    {@const info = describe(engine)}
    <span
      role="img"
      aria-label={info.label}
      title={info.label}
      data-engine={engine}
      data-state={info.state}
      class={cn(
        "inline-flex items-center gap-1.5 rounded-md border bg-card px-1.5 py-0.5 text-caption",
        info.state === "inactive" && "border-dashed text-muted-foreground line-through",
      )}
    >
      <span class={cn("h-1.5 w-1.5 rounded-full", dot[info.state])} aria-hidden="true"></span>
      {ENGINE_META[engine].label}
    </span>
  {:else}
    <span class="text-body-sm text-muted-foreground">None</span>
  {/each}
</span>
