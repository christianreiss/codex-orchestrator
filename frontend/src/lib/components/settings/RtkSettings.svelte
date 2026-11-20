<script lang="ts">
  import { untrack } from "svelte";
  import { createQuery } from "@tanstack/svelte-query";
  import { api } from "$lib/api/client";
  import { RTK_ENGINES, type RtkPolicies } from "$lib/api/rtk";
  import { authStore } from "$lib/stores/auth";
  import { Section } from "$lib/components/page";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import { Button } from "$lib/components/ui/button";
  import { hostOverridesQuery } from "$lib/api/settings";
  import RtkPolicyRow from "./RtkPolicyRow.svelte";
  import { useFleetEngines } from "$lib/engines/fleet-engines";
  // On a host, `engines` are the ones that host runs: the others are not listed (UX-05), and the
  // whole block collapses to one summary line, since inheriting the fleet default is the normal case.
  let { hostId, engines }: { hostId?: string; engines?: readonly string[] } = $props();
  const targetHost = untrack(() => hostId);
  const query = createQuery({
    queryKey: targetHost ? ["hosts", targetHost, "rtk"] : ["settings", "rtk"],
    queryFn: async () => {
      const value = await api.get<RtkPolicies>(targetHost ? `/admin/hosts/${targetHost}/rtk` : "/admin/rtk");
      if (!RTK_ENGINES.every((engine) => typeof value.engines?.[engine]?.enabled === "boolean")) throw new Error("Command output filtering policies are unavailable.");
      return value;
    },
  });
  const overrides = untrack(() => hostId) ? null : hostOverridesQuery();
  const canManage = $derived($authStore.can(targetHost ? "hosts.manage" : "settings.manage"));
  // The response keeps all four policies; only engines switched on fleet-wide get a row.
  const fleet = useFleetEngines();
  const shown = $derived(RTK_ENGINES.filter((engine) => $fleet.isEnabled(engine) && (!engines || engines.includes(engine))));
  const overridden = $derived($query.data ? shown.filter((engine) => $query.data!.engines[engine]?.source === "host").length : 0);
  const summary = $derived(
    !targetHost ? "" : $query.isPending ? "Loading…" : !$query.data ? "Unavailable" : overridden === 0 ? "All engines inherit the fleet default" : `${overridden} ${overridden === 1 ? "engine overrides" : "engines override"} the fleet default`,
  );
</script>
{#snippet body()}
<Section id={targetHost ? "host-rtk" : "rtk"} title="Command output filtering" description="RTK can condense supported command output. Every engine that is switched on receives instructions to use RTK; agents choose when to apply it. Changes save immediately and apply to new sessions after host sync; running sessions keep their launch policy.">
  {#if !canManage}<p class="text-body-sm text-muted-foreground">Read only. Changing these rules requires {targetHost ? "hosts.manage" : "settings.manage"}.</p>{/if}
  {#if $query.isPending}<p role="status" class="text-body-sm text-muted-foreground">Loading output filtering policies…</p>{/if}
  {#if $query.error}<div class="space-y-2"><p role="alert" class="text-body-sm text-destructive">Could not refresh output filtering: {$query.error.message}. {$query.data ? "Retained policies may be stale; editing is paused." : "No policy is available."}</p><Button size="sm" variant="outline" onclick={() => void $query.refetch()}>Reload output filtering</Button></div>{/if}
  {#if $query.data}
    <div class="divide-y border-y">{#each shown as engine}<RtkPolicyRow {engine} policy={$query.data.engines[engine]} hostId={targetHost} {canManage} stale={$query.isError} overrideCount={overrides ? ($overrides?.data?.rtk?.[engine] ?? null) : undefined} />{/each}</div>
  {/if}
  <p class="mt-3 text-body-sm text-muted-foreground">Raw output is kept locally for recall during the session and removed when it ends. No command output is collected centrally. Adapter reports describe the last observation, not every running session.</p>
  <p class="mt-2 text-body-sm text-muted-foreground">Use <code>--no-rtk</code> for an unfiltered session or <code>rtk bypass &lt;command&gt;</code> for one raw command.</p>
</Section>
{/snippet}

{#if targetHost}
  <details class="group border-t pt-3" data-testid="host-rtk">
    <summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 text-h2 [&::-webkit-details-marker]:hidden">
      <ChevronRight class="h-4 w-4 transition-transform group-open:rotate-90" aria-hidden="true" />
      Command output filtering
      <span class="text-body-sm font-normal text-muted-foreground">{summary}</span>
    </summary>
    <div class="mt-4">{@render body()}</div>
  </details>
{:else}
  {@render body()}
{/if}
