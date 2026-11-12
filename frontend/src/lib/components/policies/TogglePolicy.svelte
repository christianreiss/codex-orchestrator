<script lang="ts">
  import { untrack } from "svelte";
  import { authStore } from "$lib/stores/auth";
  import { Switch } from "$lib/components/ui/switch";
  import { Button } from "$lib/components/ui/button";
  import PolicyRow from "./PolicyRow.svelte";
  import { autoUpdateQuery, autoUpdateMutation, reverseDnsQuery, reverseDnsMutation,
    apiKeysInChatQuery, apiKeysInChatMutation, modelTierCheckQuery, modelTierCheckMutation,
    subagentModelSelectionQuery, subagentModelSelectionMutation,
    insecureApprovalQuery, insecureApprovalMutation, hostSpawnQuery, hostSpawnMutation, hostOverridesQuery } from "$lib/api/settings";

  // Plain label + one line of help; `term` keeps the canonical name that docs and the CLI use.
  const policies = {
    "host-spawn": { query: hostSpawnQuery, mutation: hostSpawnMutation,
      label: "Let agents set up new hosts", term: "System Spawn",
      help: "Priority hosts (VIP) can hand agents a one-time installer to provision new systems over SSH.",
      details: "Off by default. Only active VIP hosts may provision. New hosts are secure by default and never inherit VIP. Optional daemons run permanently or for a fixed duration, then finish active work and stop. Turning this off blocks further setup material; installed hosts remain." },
    "auto-update": { query: autoUpdateQuery, mutation: autoUpdateMutation,
      label: "Update hosts automatically", term: "auto-update",
      help: "Hosts install the fleet's pinned version in the background. Each host can override this.",
      details: "Maintenance checks every 15 minutes. Starting a session never waits for an upgrade." },
    "reverse-dns": { query: reverseDnsQuery, mutation: reverseDnsMutation,
      label: "Look up host names", term: "reverse DNS",
      help: "Resolve host names from PTR records for connection metadata and audit logs. Each host can override this.",
      details: "DNS lookups can add latency. Individual hosts can override the fleet's lookup mode." },
    "api-keys-in-chat": { query: apiKeysInChatQuery, mutation: apiKeysInChatMutation,
      label: "Tell agents how to treat keys pasted in chat", term: "API keys in chat",
      help: "Agents use keys an operator supplies for the task, without lectures, and avoid echoing or storing them.",
      details: "Applies to Codex, Claude and Grok. Managed documents update on the next sync or launch; this does not change API permissions." },
    "model-tier-check": { query: modelTierCheckQuery, mutation: modelTierCheckMutation,
      label: "Agents check their model against the task", term: "model-tier self-check",
      help: "Before starting, agents compare their model tier with the assignment and recommend a stronger model if it falls short.",
      details: "On by default. Agents one tier below the task name a stronger model and continue; two or more tiers below, they stop and recommend one. Read-only scouting takes the tier of the decisions it feeds, never Tier 5 by default. Five tiers: Haiku/Luna/Grok 4.5, Terra/Grok 4.6-4.7, Sonnet/Sol, Opus, Fable/Astra. Overrides must explicitly acknowledge the mismatch. Recommendations use only the latest enabled models of each host's active engines. This is agent guidance, not a runtime block. Managed documents update on the next sync or launch." },
    "subagent-model-selection": { query: subagentModelSelectionQuery, mutation: subagentModelSelectionMutation,
      label: "Choose models for delegated work", term: "subagent model selection",
      help: "Agents assess each delegated task and may choose a stronger or lighter model to fit it.",
      details: "Off by default. Quality comes first. This adds guidance to managed agent documents on the next sync; it does not grant delegation or override user and runtime instructions. The parent remains responsible for review and verification. Available models depend on the host and launcher." },
    "insecure-approval": { query: insecureApprovalQuery, mutation: insecureApprovalMutation,
      label: "Allow temporary-access requests", term: "insecure-host approvals",
      help: "Hosts without a secure connection can ask an admin to open a time-limited access window.",
      details: "The approval workflow requires a connected admin client. Turning it off disables that request workflow; it does not revoke active access windows or domain allowances. Manage individual access windows and requests on Hosts." },
  };
  /** Settings an individual host may override; the count comes from /admin/settings/host-overrides. */
  const overridable = { "auto-update": "auto_update", "reverse-dns": "reverse_dns" } as const;
  let { id }: { id: keyof typeof policies } = $props();
  // Each instance has a fixed policy identity for its entire mounted lifetime.
  const policy = untrack(() => policies[id]);
  const query = policy.query();
  const mutation = policy.mutation();
  const overrideKey = untrack(() => (overridable as Record<string, "auto_update" | "reverse_dns">)[id]);
  const overrides = overrideKey ? hostOverridesQuery() : null;
  const overrideCount = $derived(overrideKey && overrides ? ($overrides?.data?.[overrideKey] ?? null) : undefined);
  const disabled = $derived(!$authStore.can("settings.manage") || !$query.isSuccess || $query.isFetching || $mutation.isPending);
</script>

<PolicyRow {id} label={policy.label} term={policy.term} help={policy.help} details={policy.details} {overrideCount} overrideNoun="setting" controlId={`${id}-toggle`}>
  {#snippet control()}
    {#key `${$mutation.status}:${$query.data?.enabled}`}
      <Switch id={`${id}-toggle`} checked={$query.data?.enabled ?? false} {disabled} aria-describedby={`${id}-status`} onCheckedChange={(enabled) => $mutation.mutate(enabled)} />
    {/key}
  {/snippet}
  <div id={`${id}-status`} role="status" aria-live="polite" class="text-body-sm text-muted-foreground empty:hidden">
    {#if $query.isPending}Loading current setting…
    {:else if $query.isError}<span class="text-destructive">Could not load setting: {$query.error.message}</span>
    {:else if $mutation.isPending}Saving…
    {:else if $mutation.isError}<span class="text-destructive">Save failed: {$mutation.error.message}. Check the refreshed server value before retrying.</span>
    {:else if $mutation.isSuccess}Saved{/if}
  </div>
  {#if $query.isError}<Button variant="outline" size="sm" class="mt-1" onclick={() => void $query.refetch()}>Retry loading</Button>{/if}
</PolicyRow>
