<script lang="ts">
  import { untrack } from "svelte";
  import { authStore } from "$lib/stores/auth";
  import { Switch } from "$lib/components/ui/switch";
  import { Button } from "$lib/components/ui/button";
  import PolicyCard from "./PolicyCard.svelte";
  import { autoUpdateQuery, autoUpdateMutation, reverseDnsQuery, reverseDnsMutation,
    apiKeysInChatQuery, apiKeysInChatMutation, modelTierCheckQuery, modelTierCheckMutation,
    insecureApprovalQuery, insecureApprovalMutation, hostSpawnQuery, hostSpawnMutation } from "$lib/api/settings";

  const policies = {
    "host-spawn": { query: hostSpawnQuery, mutation: hostSpawnMutation, title: "System Spawn",
      label: "Allow agents to provision new systems", scope: "VIP source hosts only · Codex, Claude and Grok",
      description: "Agents receive one-time installers through MCP and install them on new systems over SSH.",
      details: "Off by default. Only active VIP hosts may provision. New hosts are secure by default and never inherit VIP. Optional daemons run permanently or for a fixed duration, then finish active work and stop. Turning this off blocks further setup material; installed hosts remain." },
    "auto-update": { query: autoUpdateQuery, mutation: autoUpdateMutation, title: "Automatic updates",
      label: "Enable automatic updates", scope: "Fleet default · host overrides apply",
      description: "Keep managed hosts on the fleet’s pinned version in the background.",
      details: "Maintenance checks every 15 minutes. Starting a session never waits for an upgrade. Individual hosts can override this default." },
    "reverse-dns": { query: reverseDnsQuery, mutation: reverseDnsMutation, title: "Reverse DNS",
      label: "Enable reverse DNS lookups", scope: "Fleet default · host overrides apply",
      description: "Resolve host names from PTR records for connection metadata and audit logs.",
      details: "DNS lookups can add latency. Individual hosts can override the fleet’s lookup mode." },
    "api-keys-in-chat": { query: apiKeysInChatQuery, mutation: apiKeysInChatMutation, title: "API keys supplied in chat",
      label: "Include API-key handling guidance", scope: "Agent instructions · Codex, Claude and Grok",
      description: "Tell agents how to handle API keys intentionally supplied by an operator.",
      details: "The instruction asks agents to use supplied keys for the requested task without generic security lectures, and to avoid unnecessary echoing or persistence. Managed documents update on the next sync or launch; this does not change API permissions." },
    "model-tier-check": { query: modelTierCheckQuery, mutation: modelTierCheckMutation, title: "Model Class Check",
      label: "Include model tier self-check guidance", scope: "Agent instructions · Codex, Claude and Grok",
      description: "Agents compare their own model tier with the task before starting work.",
      details: "On by default. Agents one tier below the task name a stronger model and continue; two or more tiers below, they stop and recommend one. The tier table lists only the latest enabled models of each host's active engines. Managed documents update on the next sync or launch." },
    "insecure-approval": { query: insecureApprovalQuery, mutation: insecureApprovalMutation, title: "Insecure-host approvals",
      label: "Enable approval requests", scope: "Fleet access workflow · insecure hosts",
      description: "Let insecure hosts request administrator approval when their access window is closed.",
      details: "The approval workflow requires a connected admin client. Turning it off disables that request workflow; it does not revoke active access windows or domain allowances. Manage individual access windows and requests on Hosts." },
  };
  let { id }: { id: keyof typeof policies } = $props();
  // Each instance has a fixed policy identity for its entire mounted lifetime.
  const policy = untrack(() => policies[id]);
  const query = policy.query();
  const mutation = policy.mutation();
  const disabled = $derived(!$authStore.can("settings.manage") || !$query.isSuccess || $query.isFetching || $mutation.isPending);
</script>
<PolicyCard {id} title={policy.title} description={policy.description} scope={policy.scope} details={policy.details}>
  <div class="flex items-center justify-between gap-4">
    <div>
      <label for={`${id}-toggle`} class="text-sm font-medium">{policy.label}</label>
      <p class="mt-1 text-xs text-muted-foreground">Changes apply immediately.</p>
    </div>
    {#key `${$mutation.status}:${$query.data?.enabled}`}
      <Switch id={`${id}-toggle`} checked={$query.data?.enabled ?? false} {disabled}
        aria-describedby={`${id}-status`} onCheckedChange={(enabled) => $mutation.mutate(enabled)} />
    {/key}
  </div>
  <div id={`${id}-status`} role="status" aria-live="polite" class="text-sm text-muted-foreground">
    {#if $query.isPending}Loading current policy…
    {:else if $query.isError}<span class="text-destructive">Could not load policy: {$query.error.message}</span>
    {:else if $mutation.isPending}Saving…
    {:else if $mutation.isError}<span class="text-destructive">Save failed: {$mutation.error.message}. The saved value is unchanged.</span>
    {:else}{ $query.data?.enabled ? "Enabled" : "Disabled" }{#if $mutation.isSuccess} · Saved{/if}{/if}
  </div>
  {#if $query.isError}<Button variant="outline" size="sm" onclick={() => void $query.refetch()}>Retry loading</Button>{/if}
  {#if !$authStore.can("settings.manage")}<p class="text-xs text-muted-foreground">Read only. Requires settings.manage.</p>{/if}
</PolicyCard>
