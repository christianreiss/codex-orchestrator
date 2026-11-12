<script lang="ts">
  import { useQueryClient } from "@tanstack/svelte-query";
  import { coordinationStateKey, coordinationStateQuery, writeCoordinationState } from "$lib/api/coordination";
  import ConfirmedSwitchSetting from "./ConfirmedSwitchSetting.svelte";

  const client = useQueryClient();
  function refreshDependents() {
    void client.invalidateQueries({ queryKey: ["agent-scopes"] });
    void client.invalidateQueries({ queryKey: ["topology"] });
  }
</script>

<ConfirmedSwitchSetting
  id="agent-coordination"
  title="Agent coordination"
  description="Fleet-wide project and host rooms, with resource claims before agents change shared files, branches or services."
  toggleLabel="Enable agent coordination"
  help="Applies to Codex, Claude, Grok and Kimi Code across all managed hosts. Enables automatic room membership and coordination of resource claims."
  subject="agent coordination"
  readPermission="agent_messaging.read"
  managePermission="agent_messaging.manage"
  queryKey={coordinationStateKey}
  useQuery={coordinationStateQuery}
  write={writeCoordinationState}
  footnote="Turning this off stops automatic rooms and new resource claims; it does not stop running agents. Resource claims coordinate agents; shell commands are not sandboxed."
  onConfirmed={refreshDependents}
/>
