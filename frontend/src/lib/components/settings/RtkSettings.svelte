<script lang="ts">
  import { untrack } from "svelte";
  import { createQuery } from "@tanstack/svelte-query";
  import { api } from "$lib/api/client";
  import { RTK_ENGINES, type RtkPolicies } from "$lib/api/rtk";
  import { authStore } from "$lib/stores/auth";
  import { Section } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import RtkPolicyRow from "./RtkPolicyRow.svelte";
  let { hostId }: { hostId?: string } = $props();
  const targetHost = untrack(() => hostId);
  const query = createQuery({
    queryKey: targetHost ? ["hosts", targetHost, "rtk"] : ["settings", "rtk"],
    queryFn: async () => {
      const value = await api.get<RtkPolicies>(targetHost ? `/admin/hosts/${targetHost}/rtk` : "/admin/rtk");
      if (!RTK_ENGINES.every((engine) => typeof value.engines?.[engine]?.enabled === "boolean")) throw new Error("Command output filtering policies are unavailable.");
      return value;
    },
  });
  const canManage = $derived($authStore.can(targetHost ? "hosts.manage" : "settings.manage"));
</script>
<Section id={targetHost ? "host-rtk" : "rtk"} title="Command output filtering" description="RTK can condense supported command output. All four engines receive instructions to use RTK; agents choose when to apply it. Changes save immediately and apply to new sessions after host sync; running sessions keep their launch policy.">
  {#if !canManage}<p class="text-body-sm text-muted-foreground">Read only. Changing these rules requires {targetHost ? "hosts.manage" : "settings.manage"}.</p>{/if}
  {#if $query.isPending}<p role="status" class="text-body-sm text-muted-foreground">Loading output filtering policies…</p>{/if}
  {#if $query.error}<div class="space-y-2"><p role="alert" class="text-body-sm text-destructive">Could not refresh output filtering: {$query.error.message}. {$query.data ? "Retained policies may be stale; editing is paused." : "No policy is available."}</p><Button size="sm" variant="outline" onclick={() => void $query.refetch()}>Reload output filtering</Button></div>{/if}
  {#if $query.data}
    <div class="divide-y border-y">{#each RTK_ENGINES as engine}<RtkPolicyRow {engine} policy={$query.data.engines[engine]} hostId={targetHost} {canManage} stale={$query.isError || $query.isFetching} />{/each}</div>
  {/if}
  <p class="mt-3 text-body-sm text-muted-foreground">Raw output is kept locally for recall during the session and removed when it ends. No command output is collected centrally. Adapter reports describe the last observation, not every running session.</p>
  <p class="mt-2 text-body-sm text-muted-foreground">Use <code>--no-rtk</code> for an unfiltered session or <code>rtk bypass &lt;command&gt;</code> for one raw command.</p>
</Section>
