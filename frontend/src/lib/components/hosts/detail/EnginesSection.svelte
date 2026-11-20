<script lang="ts">
  /** Engines on this host: on/off and the version each one runs. */
  import { useQueryClient } from "@tanstack/svelte-query";
  import { Section } from "$lib/components/page";
  import { ENGINE_META } from "$lib/constants/engines";
  import { useFleetEngines } from "$lib/engines/fleet-engines";
  import { createHostEnginesMutation, hostEngines } from "$lib/api/hosts";
  import type { HostDetail, HostEngine } from "$lib/api/types";
  import ToggleRow from "../ToggleRow.svelte";
  import { runQuiet } from "./actions";

  type Props = { host: HostDetail; id: string };
  let { host, id }: Props = $props();

  const fleet = useFleetEngines();
  const mutation = createHostEnginesMutation(useQueryClient());
  const assigned = $derived(hostEngines(host) as HostEngine[]);

  function installed(engine: HostEngine): string | null {
    if (engine === "claude") return host.claude_client_version;
    if (engine === "grok") return host.grok_client_version ?? null;
    if (engine === "kimi") return host.kimi_client_version ?? null;
    return host.client_version;
  }
  function pinned(engine: HostEngine): string | null {
    if (engine === "claude") return host.claude_client_version_override;
    if (engine === "grok") return host.grok_client_version_override ?? null;
    if (engine === "kimi") return host.kimi_client_version_override ?? null;
    return host.client_version_override;
  }
  function note(engine: HostEngine): string {
    const version = installed(engine);
    const pin = pinned(engine);
    return [
      version ? `Version ${version}` : assigned.includes(engine) ? "Version not reported yet" : "Not installed",
      pin ? `pinned to ${pin}` : null,
    ].filter(Boolean).join(" · ");
  }
  // Only engines switched on fleet-wide get a toggle. A switched-off engine the
  // host carries stays in `assigned`, so changing another engine keeps it.
  // The last engine cannot be removed.
  const locked = (engine: HostEngine) => $mutation.isPending || (assigned.includes(engine) && assigned.length <= 1);

  async function set(engine: HostEngine, enabled: boolean): Promise<void> {
    const current: HostEngine[] = assigned.length ? [...assigned] : ["codex"];
    const next = enabled ? Array.from(new Set([...current, engine])) : current.filter((item) => item !== engine);
    if (next.length === 0) return;
    await runQuiet($mutation.mutateAsync({ id, engines: next }));
  }
</script>

<Section title="Engines" description="Changes apply on the host's next cdx / clx / cgx run or its next scheduled maintenance tick.">
  <div>
    {#each $fleet.enabled as engine (engine)}
      <ToggleRow
        label={ENGINE_META[engine].label}
        ariaLabel={`${ENGINE_META[engine].label} engine`}
        note={note(engine)}
        checked={assigned.includes(engine)}
        disabled={locked(engine)}
        onchange={(v) => set(engine, v)}
      />
    {/each}
  </div>
</Section>
