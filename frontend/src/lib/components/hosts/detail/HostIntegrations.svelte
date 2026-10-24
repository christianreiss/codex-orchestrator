<script lang="ts">
  /** Advanced: priority, usage limits, update behaviour and integrations. */
  import { useQueryClient } from "@tanstack/svelte-query";
  import { wrapperCanaryMutation } from "$lib/api/wrapper-rollout";
  import {
    createAutoUpdateToggleMutation,
    createBrowserOsMcpToggleMutation,
    createScalingExemptToggleMutation,
    createVipToggleMutation,
  } from "$lib/api/hosts";
  import type { HostDetail } from "$lib/api/types";
  import ToggleRow from "../ToggleRow.svelte";
  import { runQuiet } from "./actions";

  type Props = { host: HostDetail; id: string };
  let { host, id }: Props = $props();

  const qc = useQueryClient();
  const vip = createVipToggleMutation(qc);
  const autoUpdate = createAutoUpdateToggleMutation(qc);
  const scaling = createScalingExemptToggleMutation(qc);
  const canary = wrapperCanaryMutation();
  const browserOs = createBrowserOsMcpToggleMutation(qc);
</script>

<div>
  <h3 class="mb-1 text-h3">Fleet behaviour and integrations</h3>
  <ToggleRow label="Priority host" note="VIP: usage limits only warn on this host instead of blocking it." checked={host.vip} onchange={(v) => runQuiet($vip.mutateAsync({ id, value: v }))} />
  <ToggleRow label="Always allowed (ignores usage limits)" note="Scaling exempt: this host is not held back when quota is tight." checked={host.lane_preference === "exempt"} onchange={(v) => runQuiet($scaling.mutateAsync({ id, value: v }))} />
  <ToggleRow label="Update automatically" note="Auto-update: the host agent and engine CLIs follow the fleet target versions." checked={host.effective_auto_update_enabled} onchange={(v) => runQuiet($autoUpdate.mutateAsync({ id, value: v }))} />
  <ToggleRow label="Try new host-agent versions early" note="cxx rollout canary: receives each staged rollout before every wave." checked={host.wrapper_canary ?? false} onchange={(v) => runQuiet($canary.mutateAsync({ hostId: Number(id), enabled: v }))} />
  <ToggleRow label="BrowserOS MCP" note="Adds the BrowserOS MCP server to each engine assigned to this host: Codex, Claude or Grok." checked={host.browseros_mcp_enabled} onchange={(v) => runQuiet($browserOs.mutateAsync({ id, value: v }))} />
</div>
