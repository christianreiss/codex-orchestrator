<script lang="ts">
  /** Per engine: how many hosts report it, the latest upstream version, and whether it is switched on. */
  import { base } from "$app/paths";
  import * as Table from "$lib/components/ui/table";
  import { Badge } from "$lib/components/ui/badge";
  import { ENGINES, ENGINE_META, type Engine } from "$lib/constants/engines";
  import { engineInstallCounts, type OverviewResponse } from "$lib/api/overview";
  import { useFleetEngines, FLEET_DISABLED_TAG, fleetDisabledTitle } from "$lib/engines/fleet-engines";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { StateBlock } from "$lib/components/page";
  import { checkedHint } from "./engine-releases";

  let { overview, loading = false }: { overview: OverviewResponse | undefined; loading?: boolean } = $props();
  const fleet = useFleetEngines();

  const distribution = $derived(overview?.version_distribution);
  const counts = $derived(engineInstallCounts(distribution));
  const total = $derived(overview?.totals?.hosts);
  /** Hosts that reported no CLI version for any engine. */
  const noVersion = $derived(
    distribution?.install_combinations
      ? distribution.install_combinations.filter((item) => item.engines.length === 0).reduce((sum, item) => sum + item.count, 0)
      : counts?.grok == null ? distribution?.install?.neither : undefined,
  );

  function latest(engine: Engine): { version: string | null; checked: string | null } {
    const v = overview?.versions;
    const prefix = engine === "codex" ? "cdx" : engine;
    return {
      version: (v?.[`${prefix}_version_available`] as string | null | undefined) ?? null,
      checked: checkedHint(v?.[`${prefix}_version_checked_at`] as string | null | undefined, Boolean(v?.[`${prefix}_version_stale`])),
    };
  }
</script>

{#if loading}
  <Skeleton class="h-24 w-full" />
{:else if !overview || !counts || total == null}
  <StateBlock state="empty" message="Engine coverage is unavailable until a fleet snapshot loads." />
{:else if total === 0}
  <StateBlock state="empty" message="Register a host to start building your fleet." description="Engine coverage appears after hosts report their versions." />
{:else}
  <div class="overflow-x-auto rounded-md border">
    <Table.Root>
      <Table.Caption class="sr-only">Engine installs and latest versions</Table.Caption>
      <Table.Header>
        <Table.Row>
          <Table.Head>Engine</Table.Head>
          <Table.Head>Hosts with it installed</Table.Head>
          <Table.Head>Latest version</Table.Head>
          <Table.Head>Status</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each ENGINES as engine (engine)}
          {@const on = $fleet.isEnabled(engine)}
          {@const release = latest(engine)}
          {@const count = counts?.[engine]}
          <Table.Row class={on ? undefined : "opacity-70"}>
            <Table.Cell>
              <span class="flex items-center gap-2 font-medium">
                <span class="h-2 w-2 rounded-full {ENGINE_META[engine].color}" aria-hidden="true"></span>{ENGINE_META[engine].label}
              </span>
            </Table.Cell>
            <Table.Cell class="tabular-nums">
              {#if count != null && total != null}
                {count} of {total}
                <span class="text-body-sm text-muted-foreground">({total ? Math.round((count / total) * 100) : 0}%)</span>
              {:else}<span class="text-muted-foreground">No data</span>{/if}
            </Table.Cell>
            <Table.Cell>
              <span class="font-mono">{release.version ?? "—"}</span>
              {#if release.checked}<span class="ml-2 text-body-sm text-muted-foreground">{release.checked}</span>{/if}
            </Table.Cell>
            <Table.Cell>
              {#if on}<Badge variant="success">On</Badge>
              {:else}<a href={`${base}/engines`}><Badge variant="warning" title={fleetDisabledTitle(ENGINE_META[engine].label)}>{FLEET_DISABLED_TAG}</Badge></a>{/if}
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </div>
  <p class="mt-1 text-body-sm text-muted-foreground">
    Hosts with several engines count towards each.{#if noVersion != null}{" "}No CLI version reported by <span class="tabular-nums">{noVersion}</span> {noVersion === 1 ? "host" : "hosts"}.{/if}
  </p>
{/if}
