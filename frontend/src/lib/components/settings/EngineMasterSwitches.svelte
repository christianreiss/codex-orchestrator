<script lang="ts">
  /**
   * Fleet-wide engine master switches: one compact row, each switch confirmed in
   * both directions. Turning an engine off suspends it on every host and stops
   * every server task for it; nothing is uninstalled and no credential is
   * deleted. The admin console itself never depends on an engine, so all three
   * may be off at once.
   */
  import { toast } from "svelte-sonner";
  import { useQueryClient } from "@tanstack/svelte-query";
  import AlertTriangle from "@lucide/svelte/icons/triangle-alert";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { Badge } from "$lib/components/ui/badge";
  import { authStore } from "$lib/stores/auth";
  import {
    apiSurfacesQuery,
    engineStateMutation,
    engineStateQuery,
    engineStateQueryKey,
  } from "$lib/api/settings";
  import { hostEngines, hostsListQuery } from "$lib/api/hosts";
  import { ENGINES, ENGINE_META, type Engine } from "$lib/constants/engines";
  import { fleetEngineView } from "$lib/engines/fleet-state";
  import { relativeTime } from "$lib/utils/format";
  import type { EngineStateRow, EngineStateValue } from "$lib/api/types";
  import { Switch } from "$lib/components/ui/switch";
  import { Label } from "$lib/components/ui/label";
  import EngineSwitchConfirmDialog from "./EngineSwitchConfirmDialog.svelte";
  import { engineSwitchConfirmCopy } from "./engine-switch-consequences";

  type Intent = { engine: Engine; enabled: boolean };

  const qc = useQueryClient();
  const query = engineStateQuery();
  // Both unconditional, as in AgentMessagingSection: gating them on a
  // capability read once at mount would freeze them if auth resolves late. A
  // viewer without access gets one swallowed 403 and the copy drops the count.
  const hosts = hostsListQuery();
  const surfaces = apiSurfacesQuery();

  const view = $derived(fleetEngineView($query.data));
  const canMutate = $derived($authStore.can("settings.manage"));

  /**
   * The position the operator asked for but has not confirmed yet.
   *
   * `SwitchRow` passes `checked` one way into bits-ui, whose Switch flips
   * itself on click. Routing intent through here makes the bound value really
   * transition (old -> new -> old on Cancel), which is what pushes the revert;
   * reading the server row directly would leave the switch visually flipped.
   */
  let pending = $state<Intent | null>(null);
  /** What the dialog shows; kept after `pending` clears so the close animation does not re-word itself. */
  let shown = $state<Intent>({ engine: "codex", enabled: true });

  const label = (engine: Engine) => view.row(engine)?.label ?? ENGINE_META[engine].label;

  const mutation = engineStateMutation({
    onSuccess: (data) => {
      // Write the confirmed row before clearing intent, so the switch does not
      // bounce back to the old position until the refetch lands.
      const { previous: _previous, hosts_suspended: _suspended, ...row } = data;
      qc.setQueryData<EngineStateValue>(engineStateQueryKey, (prev) =>
        prev?.engines
          ? { engines: prev.engines.map((r: EngineStateRow) => (r.engine === row.engine ? { ...r, ...row } : r)) }
          : prev,
      );
      pending = null;
      const name = label(data.engine);
      if (data.enabled) {
        toast.success(`${name} enabled fleet-wide; hosts resume it on their next launch or within 15 minutes`);
      } else {
        const suspended = data.hosts_suspended > 0
          ? `; ${data.hosts_suspended} ${data.hosts_suspended === 1 ? "host" : "hosts"} suspended`
          : "";
        toast.success(`${name} disabled fleet-wide${suspended}. New launches are refused.`);
      }
    },
    onError: (error) => {
      pending = null;
      toast.error(error.message);
    },
  });

  const confirmOpen = $derived(
    pending !== null && pending.enabled !== view.isEnabled(pending.engine),
  );

  const copy = $derived.by(() => {
    const { engine, enabled } = shown;
    const hostRows = $hosts.data?.hosts;
    const surfaceRows = $surfaces.data?.surfaces;
    return engineSwitchConfirmCopy(enabled, {
      label: label(engine),
      command: ENGINE_META[engine].command,
      activeHosts: hostRows
        ? hostRows.filter((host) => host.status === "active" && hostEngines(host).includes(engine)).length
        : null,
      routedApis: surfaceRows
        ? surfaceRows.filter((s) => s.backend === engine && !s.disabled).map((s) => s.base_path)
        : null,
      lastEnabled: !enabled && view.known && view.enabled.length === 1 && view.enabled[0] === engine,
    });
  });

  function describe(engine: Engine): string {
    if ($query.isPending) return "Loading current state…";
    if ($query.isError) return `Could not load: ${$query.error?.message ?? "unknown error"}`;
    const row = view.row(engine);
    if (!row) return "State unavailable.";
    const hostsText = `${row.assigned_hosts} ${row.assigned_hosts === 1 ? "host" : "hosts"} assigned`;
    const parts = [row.enabled ? `On · ${hostsText}` : `Off fleet-wide · ${hostsText}, suspended`];
    if (row.updated_at) {
      parts.push(`changed ${relativeTime(row.updated_at)}${row.updated_by ? ` by ${row.updated_by}` : ""}`);
    }
    return parts.join(" · ");
  }

  function short(engine: Engine): string {
    const row = view.row(engine);
    if (!row) return $query.isPending ? "Loading…" : "State unavailable";
    const hostsText = `${row.assigned_hosts} ${row.assigned_hosts === 1 ? "host" : "hosts"}`;
    return row.enabled ? `On · ${hostsText}` : `Off · ${hostsText} suspended`;
  }

  function request(engine: Engine, enabled: boolean) {
    shown = { engine, enabled };
    pending = { engine, enabled };
  }
</script>

<div aria-label="Fleet engine switches" role="group">
  {#if view.known && view.enabled.length === 0}
    <Alert variant="destructive" class="mb-2 rounded-md px-3 py-2">
      <AlertTriangle class="h-4 w-4" />
      <AlertTitle>Every engine is off</AlertTitle>
      <AlertDescription>
        No host can launch an agent until an engine is turned back on. The admin console and
        configuration keep working.
      </AlertDescription>
    </Alert>
  {/if}
  <div class="grid divide-y rounded-md border md:grid-cols-3 md:divide-x md:divide-y-0">
    {#each ENGINES as engine (engine)}
      {@const on = view.isEnabled(engine)}
      <div class="flex items-center justify-between gap-3 px-3 py-2">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="h-2 w-2 shrink-0 rounded-full {ENGINE_META[engine].color}" aria-hidden="true"></span>
            <Label for="engine-switch-{engine}" class="text-body font-medium">{label(engine)}</Label>
            <code class="text-caption text-muted-foreground">{ENGINE_META[engine].command}</code>
            {#if !on}<Badge variant="warning">Off</Badge>{/if}
          </div>
          <p class="mt-0.5 truncate text-caption font-normal text-muted-foreground" title={describe(engine)}>{short(engine)}</p>
        </div>
        <Switch
          id="engine-switch-{engine}"
          checked={pending?.engine === engine ? pending.enabled : on}
          disabled={!canMutate || !view.known || $mutation.isPending}
          onCheckedChange={(next) => request(engine, next)}
          aria-label="{label(engine)} ({ENGINE_META[engine].command})"
        />
      </div>
    {/each}
  </div>
  {#if $mutation.isError}<p class="mt-2 text-caption text-destructive" role="alert">{$mutation.error?.message}</p>{/if}
  <p class="mt-1.5 text-caption font-normal text-muted-foreground">
    Off suspends an engine on every host: running sessions are not killed, and nothing is uninstalled or deleted. Both directions ask first.
  </p>
</div>

<EngineSwitchConfirmDialog
  open={confirmOpen}
  {copy}
  busy={$mutation.isPending}
  onConfirm={() => {
    if (pending !== null) $mutation.mutate(pending);
  }}
  onCancel={() => (pending = null)}
/>
