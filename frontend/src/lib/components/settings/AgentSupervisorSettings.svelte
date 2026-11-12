<script lang="ts">
  import { supervisorQuery, supervisorKey, writeSupervisor } from "$lib/api/supervisor";
  import ConfirmedSwitchSetting from "./ConfirmedSwitchSetting.svelte";
</script>

<!-- The switch only. Per-agent incidents live on the topology graph (SupervisorStatus), not here. -->
<ConfirmedSwitchSetting
  id="agent-supervisor"
  title="Agent supervisor"
  description="External recovery for stalled work and missing handoffs across Codex, Claude and Grok."
  toggleLabel="Enable fleet supervision"
  help="Reminds after ten minutes without progress. Recovers the same native session up to five times within two hours per incident. Active tools and user questions are protected."
  subject="the supervisor"
  readPermission="agent_messaging.read"
  managePermission="agent_messaging.manage"
  queryKey={supervisorKey}
  useQuery={supervisorQuery}
  write={writeSupervisor}
  footnote="Turning this off stops supervisor recovery; accepted work continues. Automatic restart requires an upgraded wrapper and a persistent host."
>
  {#snippet extra(view)}
    {#if view.enabled && !view.effective}<p class="text-body-sm">Configured on; paused while agent messaging or the API is disabled.</p>{/if}
  {/snippet}
</ConfirmedSwitchSetting>
