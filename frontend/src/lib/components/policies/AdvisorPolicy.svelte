<script lang="ts">
  import { authStore } from "$lib/stores/auth";
  import { Switch } from "$lib/components/ui/switch";
  import PolicyCard from "./PolicyCard.svelte";
  import { advisorQuery, advisorMutation, type AdvisorSettings } from "$lib/api/advisor";
  import { hostDaemonsQuery } from "$lib/api/hostDaemons";
  import type { Engine } from "$lib/portal/types";

  const query = advisorQuery();
  const save = advisorMutation();
  const daemons = hostDaemonsQuery();
  const canManage = $derived($authStore.can("agent_messaging.manage"));
  const disabled = $derived(!canManage || !$query.isSuccess || $save.isPending);
  const settings = $derived($query.data?.settings);
  const daemonHosts = $derived(($daemons.data?.hosts ?? []).filter((h) => h.enabled));
  const reasons: Record<string, string> = {
    ok: "Available to agents",
    advisor_disabled: "Disabled",
    advisor_host_unset: "Choose an advisor host",
    agent_messaging_disabled: "Agent Messaging is off",
    advisor_host_missing: "The advisor host no longer exists",
    advisor_daemon_disabled: "The advisor host's daemon is disabled",
    advisor_daemon_unhealthy: "The advisor host's daemon is not reachable",
    advisor_engine_unavailable: "The engine is not ready on the advisor host",
  };
  function update(patch: Partial<AdvisorSettings>) {
    if (!settings) return;
    $save.mutate({ ...settings, ...patch });
  }
</script>

<PolicyCard id="advisor" title="Fleet Advisor"
  scope="Agent tools · Codex, Claude and Grok"
  description="Let agents ask a server-hosted senior reviewer for a second opinion: verification, tier checks and classification."
  details="Advisors run as host daemon sessions on the chosen host, normally the stack's advisor container. Its daemon settings decide how many run at once (max parallel) and when idle ones close (idle minutes, default 60). Set the advisor model with that host's model override, ideally a Tier-4 model. Agents see the advisor_* tools and the Fleet Advisor section of their managed instructions only while this is enabled and the host is ready; documents update on the next sync or launch.">
  <div class="flex items-center justify-between gap-4">
    <div>
      <label for="advisor-toggle" class="text-sm font-medium">Enable the Fleet Advisor</label>
      <p class="mt-1 text-xs text-muted-foreground">Changes apply immediately.</p>
    </div>
    {#key `${$save.status}:${settings?.enabled}`}
      <Switch id="advisor-toggle" checked={settings?.enabled ?? false} {disabled}
        aria-describedby="advisor-status" onCheckedChange={(enabled) => update({ enabled })} />
    {/key}
  </div>
  <div class="flex flex-wrap items-center gap-3">
    <label for="advisor-host" class="text-sm">Advisor host</label>
    <select id="advisor-host" class="rounded-md border bg-background px-3 py-2 text-sm" {disabled}
      value={settings?.host_id ?? ""}
      onchange={(e) => update({ host_id: e.currentTarget.value ? Number(e.currentTarget.value) : null })}>
      <option value="">Not set</option>
      {#each daemonHosts as host (host.host_id)}
        <option value={host.host_id}>{host.fqdn ?? `Host ${host.host_id}`} · {host.max_parallel} slots</option>
      {/each}
    </select>
    <label for="advisor-engine" class="text-sm">Engine</label>
    <select id="advisor-engine" class="rounded-md border bg-background px-3 py-2 text-sm" {disabled}
      value={settings?.engine ?? "claude"}
      onchange={(e) => update({ engine: e.currentTarget.value as Engine })}>
      <option value="claude">Claude</option><option value="codex">Codex</option><option value="grok">Grok</option>
    </select>
  </div>
  <div id="advisor-status" role="status" aria-live="polite" class="text-sm text-muted-foreground">
    {#if $query.isPending}Loading current policy…
    {:else if $query.isError}<span class="text-destructive">Could not load the advisor: {$query.error.message}</span>
    {:else if $save.isPending}Saving…
    {:else if $save.isError}<span class="text-destructive">Save failed: {$save.error.message}. The saved value is unchanged.</span>
    {:else}{reasons[$query.data.availability.reason] ?? $query.data.availability.reason}{#if $save.isSuccess} · Saved{/if}{/if}
  </div>
  {#if $query.data?.advisors.length}
    <div class="overflow-x-auto">
      <table class="w-full text-left text-xs">
        <thead class="text-muted-foreground"><tr><th class="py-1 pr-3 font-medium">Opened</th><th class="py-1 pr-3 font-medium">Kind</th><th class="py-1 pr-3 font-medium">State</th><th class="py-1 pr-3 font-medium">Turns</th><th class="py-1 font-medium">Verdict</th></tr></thead>
        <tbody>
          {#each $query.data.advisors.slice(0, 10) as row (row.advisor_session_id)}
            <tr class="border-t">
              <td class="py-1 pr-3 whitespace-nowrap">{new Date(row.created_at).toLocaleString()}</td>
              <td class="py-1 pr-3">{row.kind}</td>
              <td class="py-1 pr-3">{row.status}{row.busy ? " · answering" : ""}{row.close_reason ? ` · ${row.close_reason}` : ""}</td>
              <td class="py-1 pr-3">{row.turns}</td>
              <td class="py-1">{row.verdict ? `${row.verdict.verdict}${row.verdict.tier ? ` · tier ${row.verdict.tier}` : ""}` : "—"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
  {#if !canManage}<p class="text-xs text-muted-foreground">Read only. Requires agent_messaging.manage.</p>{/if}
</PolicyCard>
