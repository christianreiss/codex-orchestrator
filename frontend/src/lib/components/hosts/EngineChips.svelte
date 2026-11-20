<script lang="ts">
  /**
   * The engines a host runs. A ready engine is a plain label; a chip appears
   * only for an engine that is not ready, so a row of healthy engines stays
   * quiet. Version drift (CLI or wrapper not at the target) repairs itself on
   * the host's next run, so it renders neutral, not as a warning. Each entry
   * keeps the readiness contract (role=img, `data-state`, label + versions in
   * `title`) so the state is reachable by keyboard users and tests, not only
   * by colour.
   */
  import { ENGINE_META } from "$lib/constants/engines";
  import { useFleetEngines } from "$lib/engines/fleet-engines";
  import { cn } from "$lib/utils/cn";
  import type { HostListItem, HostEngineReadinessReason } from "$lib/api/types";
  import { hostEngines } from "$lib/api/hosts";

  let { host }: { host: HostListItem } = $props();
  const fleet = useFleetEngines();
  // A switched-off engine is not part of the fleet: its chip is left out even
  // though the host keeps the assignment for a later re-enable.
  const assigned = $derived(hostEngines(host).filter((engine): engine is keyof typeof ENGINE_META => engine in ENGINE_META && $fleet.isEnabled(engine)));

  const reasons: Record<HostEngineReadinessReason, string> = {
    not_assigned: "not assigned", fleet_disabled: "disabled fleet-wide", auth_missing: "auth missing",
    cli_unknown: "CLI version or target unknown", cli_outdated: "CLI not at target version",
    wrapper_unknown: "wrapper version or target unknown", wrapper_outdated: "wrapper not at target version",
  };
  const dot = { ready: "bg-success", attention: "bg-warning", drift: "bg-muted-foreground", inactive: "bg-muted-foreground/50" } as const;
  const DRIFT = new Set<HostEngineReadinessReason>(["cli_unknown", "cli_outdated", "wrapper_unknown", "wrapper_outdated"]);

  function describe(engine: keyof typeof ENGINE_META) {
    const readiness = host.engine_readiness?.[engine];
    const raw = readiness?.state ?? "attention";
    const state: keyof typeof dot = raw === "attention" && readiness && readiness.reasons.length > 0 && readiness.reasons.every((reason) => DRIFT.has(reason)) ? "drift" : (raw as keyof typeof dot);
    const description = !readiness ? "status unknown"
      : readiness.state === "ready" ? "ready"
      : readiness.reasons.map((reason) => reasons[reason] ?? reason).join(", ");
    const versions = readiness
      ? ` · CLI ${readiness.cli_version ?? "unknown"} / target ${readiness.cli_target ?? "unknown"} · cxx ${readiness.wrapper_version ?? "unknown"} / target ${readiness.wrapper_target ?? "unknown"}`
      : "";
    return { state, raw, description, label: `${ENGINE_META[engine].label}: ${description}${versions}` };
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
      data-state={info.raw}
      class={cn(
        "inline-flex items-center gap-1.5 text-body-sm",
        info.state !== "ready" && "rounded-md border bg-card px-1.5 py-0.5 text-caption",
        info.state === "inactive" && "border-dashed text-muted-foreground line-through",
      )}
    >
      <span class={cn("h-1.5 w-1.5 rounded-full", dot[info.state])} aria-hidden="true"></span>
      {#if info.state === "ready"}{ENGINE_META[engine].label}{:else}{ENGINE_META[engine].label}: {info.description}{/if}
    </span>
  {:else}
    <span class="text-body-sm text-muted-foreground">None</span>
  {/each}
</span>
