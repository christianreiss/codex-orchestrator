<script lang="ts">
  import CommunicatorPanel from "$lib/components/hosts/CommunicatorPanel.svelte";
  import SessionHousekeeping from "$lib/components/policies/SessionHousekeeping.svelte";
  import DaemonPanel from "$lib/components/hosts/DaemonPanel.svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { useQueryClient } from "@tanstack/svelte-query";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import DangerZone from "$lib/components/layout/DangerZone.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { Alert, AlertDescription } from "$lib/components/ui/alert";
  import * as Tabs from "$lib/components/ui/tabs";
  import StatusPill from "$lib/components/hosts/StatusPill.svelte";
  import EngineBadge from "$lib/components/hosts/EngineBadge.svelte";
  import EnginePanel from "$lib/components/hosts/EnginePanel.svelte";
  import InsecureCountdown from "$lib/components/hosts/InsecureCountdown.svelte";
  import ConfirmDialog from "$lib/components/hosts/ConfirmDialog.svelte";
  import InputDialog from "$lib/components/hosts/InputDialog.svelte";
  import InsecureWindowPopover from "$lib/components/hosts/InsecureWindowPopover.svelte";
  import ToggleRow from "$lib/components/hosts/ToggleRow.svelte";
  import { useFleetEngines, FLEET_DISABLED_TAG } from "$lib/engines/fleet-engines";
  import { ENGINE_META } from "$lib/constants/engines";
  import OverridePopover from "$lib/components/hosts/OverridePopover.svelte";
  import { CopyButton } from "$lib/components/ui/copy-button";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Download from "@lucide/svelte/icons/download";
  import AlertTriangle from "@lucide/svelte/icons/triangle-alert";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import { relativeTime } from "$lib/utils/format";
  import { autoCopyText } from "$lib/utils/clipboard";
  import { CLAUDE_MODEL_OPTIONS, CODEX_MODELS, GROK_MODEL_OPTIONS, REASONING_EFFORT_OPTIONS } from "$lib/constants/models";
  import {
    hostDetailQuery,
    hostsKeys,
    hostCxxWrapperState,
    hostEngines,
    hostLatestRefresh,
    hostStatusKind,
    isInsecureWindowActive,
    createDeleteHostMutation,
    createReleaseIpBindingMutation,
    createMintInstallerMutation,
    createSecureToggleMutation,
    createVipToggleMutation,
    createRoamingToggleMutation,
    createAutoUpdateToggleMutation,
    createScalingExemptToggleMutation,
    createCurlInsecureToggleMutation,
    createBrowserOsMcpToggleMutation,
    createModelOverrideMutation,
    createCodexVersionMutation,
    createClaudeVersionMutation,
    createGrokVersionMutation,
    createReverseDnsMutation,
    createAgentsVersionMutation,
    createHostEnginesMutation,
  } from "$lib/api/hosts";
  import { modelDefaultsQuery } from "$lib/api/settings";
  import type { HostEngine, InstallerInfo } from "$lib/api/types";
  import {
    createEnableInsecureMutation,
    createDisableInsecureMutation,
  } from "$lib/api/insecure";
  import { toast } from "svelte-sonner";

  const qc = useQueryClient();
  const id = $derived(page.params.id ?? "");
  const detail = $derived(hostDetailQuery(id));

  // Mutations
  const deleteMut = createDeleteHostMutation(qc);
  const releaseIpBinding = createReleaseIpBindingMutation(qc);
  const mintInstaller = createMintInstallerMutation(qc);
  const secure = createSecureToggleMutation(qc);
  const vip = createVipToggleMutation(qc);
  const roaming = createRoamingToggleMutation(qc);
  const autoUpdate = createAutoUpdateToggleMutation(qc);
  const scaling = createScalingExemptToggleMutation(qc);
  const curlInsecure = createCurlInsecureToggleMutation(qc);
  const browserOsMcp = createBrowserOsMcpToggleMutation(qc);
  const modelOverride = createModelOverrideMutation(qc);
  const codexVersion = createCodexVersionMutation(qc);
  const claudeVersion = createClaudeVersionMutation(qc);
  const grokVersion = createGrokVersionMutation(qc);
  const grokDefaults = modelDefaultsQuery("grok");
  const reverseDns = createReverseDnsMutation(qc);
  const agentsVersion = createAgentsVersionMutation(qc);
  const hostEnginesMutation = createHostEnginesMutation(qc);
  const insecureEnable = createEnableInsecureMutation(qc);
  const insecureDisable = createDisableInsecureMutation(qc);
  // Fleet engine master switches: an engine switched off fleet-wide cannot be
  // added to a host, but an assigned one can still be removed.
  const fleet = useFleetEngines();

  const host = $derived($detail.data?.host);
  const overview = $derived($detail.data?.overview);
  const cxxWrapper = $derived(
    host ? hostCxxWrapperState(host) : { display: "—", drift: false },
  );

  /** Toast on both success and error — reserved for irreversible/high-consequence actions. */
  async function run<T>(
    label: string,
    p: Promise<T>,
    opts?: { rethrow?: boolean },
  ): Promise<void> {
    try {
      await p;
      toast.success(label);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Action failed";
      toast.error(msg);
      if (opts?.rethrow) throw err;
    }
  }

  /**
   * Toast only on error — for ordinary, reversible settings edits. The
   * control itself (a switch flipping, a popover/dialog closing) is the
   * success feedback; a toast on every one of these was the single loudest
   * noise source on this page.
   */
  async function runQuiet<T>(p: Promise<T>): Promise<void> {
    try {
      await p;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Action failed";
      toast.error(msg);
      throw err;
    }
  }

  async function refresh(): Promise<void> {
    await qc.invalidateQueries({ queryKey: hostsKeys.detail(id) });
    toast.success("Refreshing…");
  }

  /** Absolute local timestamp for a stat tile's hint line. */
  function absoluteTime(iso?: string | null): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
  }

  // Dialog state
  let confirmDeleteOpen = $state(false);
  let confirmReleaseIpBindingOpen = $state(false);
  let agentsDialogOpen = $state(false);
  let installerDialogOpen = $state(false);
  let installerResult = $state<InstallerInfo | null>(null);
  let installerEngines = $state<Array<"codex" | "claude" | "grok"> | undefined>(undefined);

  async function doDelete(): Promise<void> {
    try {
      await $deleteMut.mutateAsync({ id });
      toast.success("Host deleted");
      void goto(`${base}/hosts`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Delete failed";
      toast.error(msg);
      throw err;
    }
  }

  async function doReleaseIpBinding(): Promise<void> {
    await run(
      "IP binding released",
      $releaseIpBinding.mutateAsync({ id }),
      { rethrow: true },
    );
  }

  async function doMintInstaller(engines?: Array<"codex" | "claude" | "grok">): Promise<void> {
    try {
      installerEngines = engines ? [...engines] : undefined;
      const result = await $mintInstaller.mutateAsync({
        id,
        engines,
        curl_insecure: host?.curl_insecure,
      });
      installerResult = result.installer;
      installerDialogOpen = true;
      await autoCopyText(
        result.installer.command,
        "Installer minted and command copied",
        "Installer minted",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Installer mint failed";
      toast.error(msg);
    }
  }

  async function recreateInstaller(): Promise<void> {
    await doMintInstaller(installerEngines);
  }

  // Derived action items
  const actionItems = $derived.by<Array<{ tone: "warning" | "info"; text: string }>>(() => {
    if (!host || !overview) return [];
    const items: Array<{ tone: "warning" | "info"; text: string }> = [];
    const cv = overview.versions.client_version;
    const hv = host.client_version_override ?? host.client_version;
    if (hostEngines(host).includes("codex") && cv && hv && cv !== hv) {
      items.push({ tone: "warning", text: `Codex version drift: host on ${hv}, fleet on ${cv}.` });
    }
    const ccv = overview.versions.claude_version;
    const chv = host.claude_client_version_override ?? host.claude_client_version;
    if (hostEngines(host).includes("claude") && ccv && chv && ccv !== chv) {
      items.push({ tone: "warning", text: `Claude version drift: host on ${chv}, fleet on ${ccv}.` });
    }
    const gv = overview.versions.grok_version;
    const ghv = host.grok_client_version_override ?? host.grok_client_version;
    if (hostEngines(host).includes("grok") && gv && ghv && gv !== ghv) {
      items.push({ tone: "warning", text: `Grok version drift: host on ${ghv}, fleet on ${gv}.` });
    }
    if (cxxWrapper.drift) {
      items.push({
        tone: "warning",
        text: `CXX migration drift: ${cxxWrapper.display}. Re-run the host installer.`,
      });
    }
    if (host.authed === false) {
      items.push({ tone: "warning", text: "Host has not authenticated yet (no payload digest)." });
    } else if (host.auth_outdated) {
      items.push({ tone: "warning", text: "Auth payload is stale relative to fleet canonical digest." });
    }
    if (isInsecureWindowActive(host)) {
      items.push({ tone: "info", text: `Insecure window open until ${host.insecure_enabled_until}.` });
    }
    for (const engine of $fleet.disabled) {
      if (!hostEngines(host).includes(engine)) continue;
      const meta = ENGINE_META[engine];
      items.push({
        tone: "info",
        text: `${meta.label} is disabled fleet-wide: this host refuses to launch ${meta.command} and stops syncing it until it is turned back on under Engines. The assignment and credentials are kept.`,
      });
    }
    return items;
  });

  // For controls panel
  const codexEngine = $derived(host ? hostEngines(host).includes("codex") : false);
  const claudeEngine = $derived(host ? hostEngines(host).includes("claude") : false);
  const grokEngine = $derived(host ? hostEngines(host).includes("grok") : false);
  const engineList = $derived<HostEngine[]>(host ? (hostEngines(host) as HostEngine[]) : []);
  const codexSwitchDisabled = $derived(
    $hostEnginesMutation.isPending || (codexEngine && engineList.length <= 1) || (!codexEngine && !$fleet.isEnabled("codex")),
  );
  const claudeSwitchDisabled = $derived(
    $hostEnginesMutation.isPending || (claudeEngine && engineList.length <= 1) || (!claudeEngine && !$fleet.isEnabled("claude")),
  );
  const grokSwitchDisabled = $derived(
    $hostEnginesMutation.isPending || (grokEngine && engineList.length <= 1) || (!grokEngine && !$fleet.isEnabled("grok")),
  );
  const grokModel = $derived(host?.grok_model_override ?? $grokDefaults.data?.model ?? "grok-4.7");
  const grokEfforts = $derived(
    ($grokDefaults.data?.catalog.find(model => model.model === grokModel)?.persistent_efforts
      ?? (grokModel === "grok-4.5" ? ["low", "medium", "high"] : ["low", "medium", "high", "xhigh"]))
      .map(value => ({ value, label: REASONING_EFFORT_OPTIONS.find(option => option.value === value)?.label ?? value })),
  );
  // Reverse-DNS tri-state segmented control.
  type ReverseDnsMode = "global" | "enabled" | "disabled";
  const reverseDnsValue = $derived.by<ReverseDnsMode>(() => {
    const raw = (host?.reverse_dns_mode ?? "").toString().toLowerCase();
    if (raw === "enabled" || raw === "1" || raw === "true") return "enabled";
    if (raw === "disabled" || raw === "0" || raw === "false") return "disabled";
    return "global";
  });

  async function setReverseDns(mode: ReverseDnsMode): Promise<void> {
    if (reverseDnsValue === mode) return;
    await runQuiet($reverseDns.mutateAsync({ id, mode }));
  }

  async function setHostEngine(engine: HostEngine, enabled: boolean): Promise<void> {
    const current: HostEngine[] = engineList.length ? [...engineList] : ["codex"];
    const next: HostEngine[] = enabled
      ? Array.from(new Set([...current, engine]))
      : current.filter((item) => item !== engine);
    if (next.length === 0) return;
    await runQuiet($hostEnginesMutation.mutateAsync({ id, engines: next }));
  }

  const activeTab = $derived(["overview", "settings", "operations"].includes(page.url.searchParams.get("tab") ?? "")
    ? page.url.searchParams.get("tab")! : "overview");
  function changeTab(tab: string) {
    const url = new URL(page.url);
    url.searchParams.set("tab", tab);
    void goto(url, { noScroll: true, keepFocus: true });
  }
  const modelOverrideCount = $derived(host ? [
    host.model_override, host.reasoning_effort_override, host.client_version_override,
    host.claude_model_override, host.claude_client_version_override,
    host.grok_model_override, host.grok_reasoning_effort_override, host.grok_client_version_override,
  ].filter(value => value != null && value !== "").length : 0);
  let modelsOpen = $state(false);
  let modelsHost = $state<string | null>(null);
  $effect(() => {
    if (host && modelsHost !== id) {
      modelsOpen = modelOverrideCount > 0;
      modelsHost = id;
    }
  });

  async function saveCodexVersion(v: string | null): Promise<void> {
    await runQuiet($codexVersion.mutateAsync({ id, version: v }));
  }
  async function saveClaudeVersion(v: string | null): Promise<void> {
    await runQuiet($claudeVersion.mutateAsync({ id, version: v }));
  }
  async function saveGrokVersion(v: string | null): Promise<void> {
    await runQuiet($grokVersion.mutateAsync({ id, version: v }));
  }
  async function saveGrokModel(v: string | null): Promise<void> {
    await runQuiet($modelOverride.mutateAsync({ id, engine: "grok", model: v }));
  }
  async function saveGrokEffort(v: string | null): Promise<void> {
    await runQuiet($modelOverride.mutateAsync({ id, engine: "grok", reasoning_effort: v }));
  }
  async function saveCodexModel(v: string | null): Promise<void> {
    await runQuiet($modelOverride.mutateAsync({ id, engine: "codex", model: v }));
  }
  async function saveClaudeModel(v: string | null): Promise<void> {
    await runQuiet($modelOverride.mutateAsync({ id, engine: "claude", model: v }));
  }
  async function saveReasoningEffort(v: string | null): Promise<void> {
    await runQuiet($modelOverride.mutateAsync({ id, engine: "codex", reasoning_effort: v }));
  }
</script>

{#if $detail.isLoading}
  <div class="flex flex-col gap-3">
    <Skeleton class="h-16 w-full" />
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Skeleton class="h-24" />
      <Skeleton class="h-24" />
      <Skeleton class="h-24" />
      <Skeleton class="h-24" />
    </div>
    <Skeleton class="h-56 w-full" />
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Skeleton class="h-40" />
      <Skeleton class="h-40" />
    </div>
  </div>
{:else if $detail.isError || !host}
  <div class="rounded-md border border-destructive/25 bg-destructive-muted p-4 text-sm text-destructive-muted-foreground">
    Failed to load host: {$detail.error?.message ?? "not found"}
  </div>
{:else}
  <PageHeader title={host.fqdn} subtitle="Host #{host.id}">
    {#snippet actions()}
      <a
        href={`${base}/hosts`}
        class="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input hover:bg-accent"
        aria-label="Back"
      >
        <ArrowLeft class="h-4 w-4" />
      </a>
      <Button variant="outline" onclick={refresh}>
        <RefreshCw class="h-4 w-4" /> Refresh
      </Button>
    {/snippet}
  </PageHeader>

  <div class="flex flex-col gap-3">
    <!-- Status line: reachability | security | engines. VIP/roaming/auto-update/
         BrowserOS are controls further down, not pills — a pill is for state
         you can't change on this page. -->
    <div class="flex flex-wrap items-center gap-1.5">
      {#if hostStatusKind(host) === "online"}
        <StatusPill tone="online" label="Online" />
      {:else if hostStatusKind(host) === "auth-missing"}
        <StatusPill tone="warning" label="Auth missing" />
      {:else if hostStatusKind(host) === "auth-outdated"}
        <StatusPill tone="warning" label="Outdated auth" />
      {:else}
        <StatusPill tone="offline" label="Offline" />
      {/if}
      {#if isInsecureWindowActive(host)}
        <StatusPill tone="warning" label="Insecure" />
      {:else if host.secure}
        <StatusPill tone="secure" label="Secure" />
      {:else}
        <StatusPill tone="muted" label="Insecure (closed)" />
      {/if}
      {#each hostEngines(host) as engine}
        <EngineBadge {engine} fleetDisabled={!$fleet.isEnabled(engine)} />
      {/each}
    </div>

    {#if actionItems.length > 0}
      <div class="flex flex-col gap-2">
        {#each actionItems as item}
          <Alert variant={item.tone}>
            <AlertTriangle class="h-4 w-4" />
            <AlertDescription>{item.text}</AlertDescription>
          </Alert>
        {/each}
      </div>
    {/if}

    <Tabs.Root value={activeTab} onValueChange={changeTab}>
      <Tabs.List aria-label="Host sections" class="mb-3">
        <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
        <Tabs.Trigger value="settings">Settings</Tabs.Trigger>
        <Tabs.Trigger value="operations">Operations</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="overview" hidden={activeTab !== "overview"}>
        <div class="space-y-4">
          <dl class="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border bg-card p-4 lg:grid-cols-4">
            {@render dt("Last contact", relativeTime(hostLatestRefresh(host)) || "—", absoluteTime(hostLatestRefresh(host)))}
            {@render dt("Last cron check", relativeTime(host.last_cron_check) || "—", absoluteTime(host.last_cron_check))}
            {@render dt("API calls (recent)", String(host.api_calls ?? "—"))}
            {@render dt("CXX wrapper", cxxWrapper.display)}
          </dl>
          <section class="rounded-lg border bg-card p-4" aria-labelledby="host-network-heading">
            <h2 id="host-network-heading" class="mb-3 text-sm font-semibold">Identity & network</h2>
            <dl class="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
              {@render dt("Host ID", String(host.id))}
              {@render dt("FQDN", host.fqdn)}
              {@render dt("IPv4", host.ip4 ?? "—")}
              {@render dt("IPv6", host.ip6 ?? "—")}
            </dl>
          </section>
          <section class="rounded-lg border bg-card p-4" aria-labelledby="host-engines-heading">
            <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 id="host-engines-heading" class="text-sm font-semibold">Engine versions</h2>
              <Button variant="outline" size="sm" onclick={() => doMintInstaller()} disabled={$mintInstaller.isPending}>
                <Download class="h-3.5 w-3.5" /> {$mintInstaller.isPending ? "Minting…" : "Mint installer"}
              </Button>
            </div>
            <dl class="divide-y">
              {#each engineList as engine}
                <div class="flex items-center justify-between gap-3 py-2 text-sm">
                  <dt><EngineBadge {engine} fleetDisabled={!$fleet.isEnabled(engine)} /></dt>
                  <dd class="font-mono text-xs">{engine === "codex" ? host.client_version ?? "—" : engine === "claude" ? host.claude_client_version ?? "—" : host.grok_client_version ?? "—"}</dd>
                </div>
              {/each}
            </dl>
          </section>
        </div>
      </Tabs.Content>
      <Tabs.Content value="settings" hidden={activeTab !== "settings"}>
        <div class="space-y-4">
          <section class="host-controls rounded-lg border bg-card p-4" aria-label="Host settings">
            <h2 class="text-sm font-semibold">Engines</h2>
            <div class="grid grid-cols-1 gap-x-6 sm:grid-cols-3">
              <ToggleRow
                label="Codex engine"
                checked={codexEngine}
                disabled={codexSwitchDisabled}
                note={$fleet.isEnabled("codex") ? undefined : FLEET_DISABLED_TAG}
                onchange={(v) => setHostEngine("codex", v)}
              />
              <ToggleRow
                label="Claude engine"
                checked={claudeEngine}
                disabled={claudeSwitchDisabled}
                note={$fleet.isEnabled("claude") ? undefined : FLEET_DISABLED_TAG}
                onchange={(v) => setHostEngine("claude", v)}
              />
              <ToggleRow
                label="Grok engine"
                checked={grokEngine}
                disabled={grokSwitchDisabled}
                note={$fleet.isEnabled("grok") ? undefined : FLEET_DISABLED_TAG}
                onchange={(v) => setHostEngine("grok", v)}
              />
            </div>
            <p class="mt-2 text-xs text-muted-foreground">
              Engine changes apply on the host's next <code>cdx</code>/<code>clx</code>/<code>cgx</code> run, or its next
              scheduled maintenance tick if none runs interactively.
            </p>

            <div class="mt-5 grid items-start gap-6 lg:grid-cols-2">
              <section aria-labelledby="host-access-heading">
                <h2 id="host-access-heading" class="mb-1 text-sm font-semibold">Access & network</h2>
                <ToggleRow
                  label="Secure"
                  checked={host.secure}
                  onchange={(v) => runQuiet($secure.mutateAsync({ id, value: v }))}
                />
                <ToggleRow
                  label="Curl insecure"
                  checked={host.curl_insecure}
                  onchange={(v) => runQuiet($curlInsecure.mutateAsync({ id, value: v }))}
                />
                <ToggleRow
                  label="Roaming"
                  checked={host.allow_roaming_ips}
                  onchange={(v) => runQuiet($roaming.mutateAsync({ id, value: v }))}
                />
                <div class="flex flex-wrap items-center justify-between gap-2 border-b py-3">
                  <span class="text-sm">Reverse DNS</span>
                  <div class="inline-flex w-fit overflow-hidden rounded-md border border-input text-[11px]">
                    {#each [
                      { id: "global", label: "Inherit" },
                      { id: "enabled", label: "Force on" },
                      { id: "disabled", label: "Force off" },
                    ] as opt (opt.id)}
                      <button
                        type="button"
                        class="px-2 py-1 transition-colors hover:bg-accent {reverseDnsValue === opt.id
                          ? 'bg-foreground text-background'
                          : 'bg-background text-foreground'}"
                        disabled={$reverseDns.isPending}
                        aria-pressed={reverseDnsValue === opt.id}
                        onclick={() => void setReverseDns(opt.id as ReverseDnsMode)}
                      >
                        {opt.label}
                      </button>
                    {/each}
                  </div>
                </div>
                {#if isInsecureWindowActive(host) || host.secure === false}
                  <div class="flex flex-wrap items-center gap-2 pt-3">
                    <InsecureCountdown until={host.insecure_enabled_until} />
                    {#if isInsecureWindowActive(host)}
                      <InsecureWindowPopover
                        label="Extend window"
                        variant="outline"
                        heading="Extend insecure window"
                        confirmLabel="Extend"
                        onConfirm={(duration_minutes) =>
                          run("Window extended", $insecureEnable.mutateAsync({ id, duration_minutes }))}
                      />
                      <Button
                        variant="ghost"
                        onclick={() => run("Window closed", $insecureDisable.mutateAsync({ id }))}
                      >
                        Close window
                      </Button>
                    {:else if host.secure === false}
                      <InsecureWindowPopover
                        label="Open insecure window"
                        heading="Open insecure window"
                        confirmLabel="Open"
                        onConfirm={(duration_minutes) =>
                          run("Window opened", $insecureEnable.mutateAsync({ id, duration_minutes }))}
                      />
                    {/if}
                  </div>
                {/if}
                {#if host.ip4 || host.ip6}
                  <Button class="mt-3" variant="outline" size="sm" onclick={() => (confirmReleaseIpBindingOpen = true)}>Release IP binding</Button>
                {/if}
              </section>
              <section aria-labelledby="host-fleet-heading">
                <h2 id="host-fleet-heading" class="mb-1 text-sm font-semibold">Fleet & integrations</h2>
                <ToggleRow
                  label="VIP"
                  checked={host.vip}
                  onchange={(v) => runQuiet($vip.mutateAsync({ id, value: v }))}
                />
                <ToggleRow
                  label="Auto-update"
                  checked={host.effective_auto_update_enabled}
                  onchange={(v) => runQuiet($autoUpdate.mutateAsync({ id, value: v }))}
                />
                <ToggleRow
                  label="Scaling exempt"
                  checked={host.lane_preference === "exempt"}
                  onchange={(v) => runQuiet($scaling.mutateAsync({ id, value: v }))}
                />
                <ToggleRow
                  label="BrowserOS MCP"
                  checked={host.browseros_mcp_enabled}
                  onchange={(v) => runQuiet($browserOsMcp.mutateAsync({ id, value: v }))}
                />
              </section>
            </div>
          </section>
          <Collapsible.Root bind:open={modelsOpen} class="rounded-lg border bg-card">
            <Collapsible.Trigger class="flex w-full items-center justify-between gap-3 p-4 text-left">
              <span><span class="block text-sm font-semibold">Model & version overrides</span><span class="text-xs text-muted-foreground">{modelOverrideCount ? `${modelOverrideCount} set` : "All inherit fleet defaults"}</span></span>
              <ChevronDown class={`h-4 w-4 transition-transform ${modelsOpen ? "rotate-180" : ""}`} />
            </Collapsible.Trigger>
            <Collapsible.Content class="px-4 pb-4">
              <p class="mb-3 text-xs text-muted-foreground">Blank clears an override and inherits the fleet default.</p>
              <div class="grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))]">
                {#if codexEngine}
                  <EnginePanel
                    engine="codex"
                    digest={host.canonical_digest ? host.canonical_digest.slice(0, 16) + "…" : "—"}
                  >
                    <OverridePopover
                      label="Version"
                      override={host.client_version_override}
                      inheritedValue={host.client_version}
                      inheritedLabel="detected"
                      placeholder={overview?.versions.client_version ?? "0.30.0"}
                      pending={$codexVersion.isPending}
                      onSave={saveCodexVersion}
                    />
                    <OverridePopover
                      label="Model"
                      override={host.model_override}
                      options={CODEX_MODELS}
                      pending={$modelOverride.isPending}
                      onSave={saveCodexModel}
                    />
                    <OverridePopover
                      label="Reasoning effort"
                      override={host.reasoning_effort_override}
                      options={REASONING_EFFORT_OPTIONS}
                      pending={$modelOverride.isPending}
                      onSave={saveReasoningEffort}
                    />
                  </EnginePanel>
                {/if}

                {#if claudeEngine}
                  <EnginePanel
                    engine="claude"
                    digest={host.claude_canonical_digest ? host.claude_canonical_digest.slice(0, 16) + "…" : "—"}
                  >
                    <OverridePopover
                      label="Version"
                      override={host.claude_client_version_override}
                      inheritedValue={host.claude_client_version}
                      inheritedLabel="detected"
                      placeholder={overview?.versions.claude_version ?? "1.0.0"}
                      pending={$claudeVersion.isPending}
                      onSave={saveClaudeVersion}
                    />
                    <OverridePopover
                      label="Model"
                      override={host.claude_model_override}
                      options={CLAUDE_MODEL_OPTIONS}
                      pending={$modelOverride.isPending}
                      onSave={saveClaudeModel}
                    />
                  </EnginePanel>
                {/if}
                {#if grokEngine}
                  <EnginePanel engine="grok" digest={host.grok_canonical_digest ? host.grok_canonical_digest.slice(0, 16) + "…" : "—"}>
                    <OverridePopover label="Version" override={host.grok_client_version_override ?? null}
                      inheritedValue={host.grok_client_version} inheritedLabel="detected"
                      placeholder={overview?.versions.grok_version ?? "1.0.50"}
                      pending={$grokVersion.isPending} onSave={saveGrokVersion} />
                    <OverridePopover label="Model" override={host.grok_model_override ?? null}
                      options={GROK_MODEL_OPTIONS} pending={$modelOverride.isPending} onSave={saveGrokModel} />
                    <OverridePopover label="Reasoning effort" override={host.grok_reasoning_effort_override ?? null}
                      options={grokEfforts} pending={$modelOverride.isPending} onSave={saveGrokEffort} />
                  </EnginePanel>
                {/if}
              </div>
            </Collapsible.Content>
          </Collapsible.Root>
            <div class="flex items-center justify-between rounded-md border p-2.5">
              <div class="min-w-0">
                <div class="text-sm">Agents doc override</div>
                <div class="truncate font-mono text-xs text-muted-foreground">
                  {host.agents_document_id_override ?? "No override set"}
                </div>
              </div>
              <Button variant="outline" size="sm" onclick={() => (agentsDialogOpen = true)}>
                Edit
              </Button>
            </div>
        </div>
      </Tabs.Content>
      <Tabs.Content value="operations" hidden={activeTab !== "operations"}>
        <div class="space-y-4">
          {#key id}<CommunicatorPanel {id}/><DaemonPanel {id}/><SessionHousekeeping hostId={id}/>{/key}
          <DangerZone description="Permanently remove this host from the fleet.">
            <Button variant="destructive" onclick={() => (confirmDeleteOpen = true)}>
              <Trash2 class="h-4 w-4" /> Delete host
            </Button>
          </DangerZone>
        </div>
      </Tabs.Content>
    </Tabs.Root>
  </div>

  <ConfirmDialog
    bind:open={confirmReleaseIpBindingOpen}
    onOpenChange={(v) => (confirmReleaseIpBindingOpen = v)}
    title="Release IP binding?"
    description="Clear the stored IPv4 and IPv6 bindings for this host. Its next valid authenticated request will establish the new binding; security and roaming settings stay unchanged."
    confirmLabel="Release binding"
    destructive
    onConfirm={doReleaseIpBinding}
  />
  <ConfirmDialog
    bind:open={confirmDeleteOpen}
    onOpenChange={(v) => (confirmDeleteOpen = v)}
    title="Delete host?"
    description={`Permanently remove ${host.fqdn} from the fleet. This cannot be undone.`}
    confirmLabel="Delete"
    destructive
    onConfirm={doDelete}
  />
  <InputDialog
    bind:open={agentsDialogOpen}
    onOpenChange={(v) => (agentsDialogOpen = v)}
    title="Agents version override"
    description="Pin a specific agents document by id for this host. Empty clears."
    label="Agents document id"
    placeholder="42"
    initialValue={host.agents_document_id_override ? String(host.agents_document_id_override) : ""}
    onSubmit={(v) => {
      const parsed = v === null || v === "" ? null : Number.parseInt(v, 10);
      return runQuiet(
        $agentsVersion.mutateAsync({ id, document_id: Number.isFinite(parsed) ? parsed : null }),
      );
    }}
  />
  <Dialog.Root bind:open={installerDialogOpen}>
    <Dialog.Content class="sm:max-w-xl">
      <Dialog.Header>
        <Dialog.Title>Installer minted</Dialog.Title>
        <Dialog.Description>
          {installerResult?.label ?? "Host"} installer for {host.fqdn}. Token expires {installerResult
            ? new Date(installerResult.expires_at).toLocaleString()
            : "—"}.
        </Dialog.Description>
      </Dialog.Header>
      <div class="space-y-3">
        <div class="space-y-1.5">
          <Label for="host-installer-url">Installer URL</Label>
          <Input id="host-installer-url" readonly value={installerResult?.url ?? ""} class="font-mono text-xs" />
        </div>
        <div class="space-y-1.5">
          <Label for="host-installer-command">Installer command</Label>
          <textarea
            id="host-installer-command"
            readonly
            class="h-36 w-full resize-none rounded-md border border-input bg-muted/40 p-3 font-mono text-xs"
            value={installerResult?.command ?? ""}
          ></textarea>
        </div>
      </div>
      <Dialog.Footer>
        <Button variant="secondary" onclick={recreateInstaller} disabled={$mintInstaller.isPending}>
          <RefreshCw class="h-4 w-4" /> {$mintInstaller.isPending ? "Minting…" : "Re-create"}
        </Button>
        <CopyButton
          value={installerResult?.url ?? ""}
          label="Copy URL"
          toastMessage="Installer URL copied"
          disabled={!installerResult?.url}
        />
        <CopyButton
          value={installerResult?.command ?? ""}
          label="Copy command"
          toastMessage="Installer command copied"
          disabled={!installerResult?.command}
        />
        <Button variant="ghost" onclick={() => (installerDialogOpen = false)}>Close</Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
{/if}

{#snippet dt(label: string, value: string, title: string | null = null)}
  <div class="flex flex-col" title={title ?? undefined}>
    <dt class="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
    <dd class="break-all font-mono text-xs">{value}</dd>
  </div>
{/snippet}

<style>
  .host-controls :global(.host-toggle) { border: 0; border-bottom: 1px solid hsl(var(--border)); border-radius: 0; padding: 0.75rem 0; gap: 1rem; }
</style>
