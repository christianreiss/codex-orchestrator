<script lang="ts">
  import { PageShell, Section } from "$lib/components/page";
  import { authStore } from "$lib/stores/auth";
  import SessionControls from "$lib/components/portal/SessionControls.svelte";
  import TogglePolicy from "$lib/components/policies/TogglePolicy.svelte";
  import AuthorizationPolicy from "$lib/components/policies/AuthorizationPolicy.svelte";
  import CleanupPolicy from "$lib/components/policies/CleanupPolicy.svelte";
  import SessionHousekeeping from "$lib/components/policies/SessionHousekeeping.svelte";

  const canManage = $derived($authStore.can("settings.manage"));
</script>

<PageShell title="Settings" description="Fleet-wide behaviour. Switches save immediately. Retention and cleanup forms use Save changes. Individual hosts can override most settings." width="narrow">
  {#if !canManage}
    <p class="text-body-sm text-muted-foreground">Read only. Changing these settings requires <code class="font-mono">settings.manage</code>.</p>
  {/if}

  <div class="space-y-8">
    <Section id="hosts" title="Hosts" description="How managed hosts update, identify themselves and get access.">
      <div class="divide-y border-y">
        <TogglePolicy id="auto-update" />
        <TogglePolicy id="reverse-dns" />
        <TogglePolicy id="insecure-approval" />
        <TogglePolicy id="host-spawn" />
        <div id="host-lifecycle" class="scroll-mt-24"><CleanupPolicy kind="prune-policy" /></div>
      </div>
    </Section>

    <Section id="agents" title="Agents" description="What agents are told and who may change access rules.">
      <div class="divide-y border-y">
        {#if $authStore.can("agent_portal.manage")}<SessionControls />{/if}
        <TogglePolicy id="api-keys-in-chat" />
        <TogglePolicy id="model-tier-check" />
        <AuthorizationPolicy />
      </div>
    </Section>

    <Section id="retention" title="Data retention" description="How long logs and agent sessions are kept before automatic cleanup.">
      <div class="divide-y border-y">
        <CleanupPolicy kind="log-retention" />
        <SessionHousekeeping />
      </div>
    </Section>
  </div>
</PageShell>
