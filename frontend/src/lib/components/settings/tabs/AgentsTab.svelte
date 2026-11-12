<script lang="ts">
  import { Section } from "$lib/components/page";
  import { authStore } from "$lib/stores/auth";
  import SessionControls from "$lib/components/portal/SessionControls.svelte";
  import TogglePolicy from "$lib/components/policies/TogglePolicy.svelte";
  import AuthorizationPolicy from "$lib/components/policies/AuthorizationPolicy.svelte";
  import AgentCoordinationSettings from "../AgentCoordinationSettings.svelte";
  import AgentSupervisorSettings from "../AgentSupervisorSettings.svelte";
  import ChattySettings from "$lib/components/chatty/ChattySettings.svelte";
</script>

<Section id="agents" title="Agents" description="What agents are told and who may change access rules.">
  <div class="divide-y border-y">
    {#if $authStore.can("agent_portal.manage")}<SessionControls />{/if}
    <TogglePolicy id="api-keys-in-chat" />
    <TogglePolicy id="model-tier-check" />
    <TogglePolicy id="subagent-model-selection" />
    <AuthorizationPolicy />
  </div>
  {#if !$authStore.can("agent_portal.manage")}
    <p class="mt-2 text-body-sm text-muted-foreground">Agent session controls are hidden: they require <code class="font-mono">agent_portal.manage</code>.</p>
  {/if}
</Section>

<AgentCoordinationSettings />
<AgentSupervisorSettings />
<ChattySettings />
