<script lang="ts">
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
  import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "$lib/components/ui/card";
  import { Alert, AlertDescription } from "$lib/components/ui/alert";
  import StatCard from "$lib/components/dashboard/StatCard.svelte";
  import StatusPill from "$lib/components/hosts/StatusPill.svelte";
  import EngineBadge from "$lib/components/hosts/EngineBadge.svelte";
  import EnginePanel from "$lib/components/hosts/EnginePanel.svelte";
  import InsecureCountdown from "$lib/components/hosts/InsecureCountdown.svelte";
  import ConfirmDialog from "$lib/components/hosts/ConfirmDialog.svelte";
  import InputDialog from "$lib/components/hosts/InputDialog.svelte";
  import InsecureWindowPopover from "$lib/components/hosts/InsecureWindowPopover.svelte";
  import ToggleRow from "$lib/components/hosts/ToggleRow.svelte";
  import OverridePopover from "$lib/components/hosts/OverridePopover.svelte";
  import { CopyButton } from "$lib/components/ui/copy-button";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Download from "@lucide/svelte/icons/download";
  import AlertTriangle from "@lucide/svelte/icons/triangle-alert";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Package from "@lucide/svelte/icons/package";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import Network from "@lucide/svelte/icons/network";
  import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
  import Plug from "@lucide/svelte/icons/plug";
  import Clock from "@lucide/svelte/icons/clock";
  import Timer from "@lucide/svelte/icons/timer";
  import Activity from "@lucide/svelte/icons/activity";
  import Terminal from "@lucide/svelte/icons/terminal";
  import { relativeTime } from "$lib/utils/format";
  import { autoCopyText } from "$lib/utils/clipboard";
  import { CLAUDE_MODEL_OPTIONS, CODEX_MODELS, REASONING_EFFORT_OPTIONS } from "$lib/constants/models";
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
    createReverseDnsMutation,
    createAgentsVersionMutation,
    createHostEnginesMutation,
  } from "$lib/api/hosts";
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
  const reverseDns = createReverseDnsMutation(qc);
  const agentsVersion = createAgentsVersionMutation(qc);
  const hostEnginesMutation = createHostEnginesMutation(qc);
  const insecureEnable = createEnableInsecureMutation(qc);
  const insecureDisable = createDisableInsecureMutation(qc);

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
  let installerEngines = $state<Array<"codex" | "claude"> | undefined>(undefined);

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

  async function doMintInstaller(engines?: Array<"codex" | "claude">): Promise<void> {
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
    return items;
  });

  // For controls panel
  const codexEngine = $derived(host ? hostEngines(host).includes("codex") : false);
  const claudeEngine = $derived(host ? hostEngines(host).includes("claude") : false);
  const engineList = $derived<HostEngine[]>(host ? (hostEngines(host) as HostEngine[]) : []);
  const codexSwitchDisabled = $derived($hostEnginesMutation.isPending || (codexEngine && !claudeEngine));
  const claudeSwitchDisabled = $derived($hostEnginesMutation.isPending || (claudeEngine && !codexEngine));
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

  // Fleet policy overrides — collapsible, auto-expanded once on load only when
  // it actually contains a non-default value.
  const policyOverrideCount = $derived.by(() => {
    if (!host) return 0;
    let n = 0;
    if (host.vip) n++;
    if (host.allow_roaming_ips) n++;
    if (host.auto_update_override !== null && host.auto_update_override !== undefined) n++;
    if (host.lane_preference === "exempt") n++;
    if (reverseDnsValue !== "global") n++;
    if (host.agents_document_id_override != null) n++;
    return n;
  });
  let policyOpen = $state(false);
  let policyOpenInitialized = false;
  $effect(() => {
    if (host && !policyOpenInitialized) {
      policyOpen = policyOverrideCount > 0;
      policyOpenInitialized = true;
    }
  });

  async function saveCodexVersion(v: string | null): Promise<void> {
    await runQuiet($codexVersion.mutateAsync({ id, version: v }));
  }
  async function saveClaudeVersion(v: string | null): Promise<void> {
    await runQuiet($claudeVersion.mutateAsync({ id, version: v }));
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
  <div class="flex flex-col gap-6">
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

  <div class="flex flex-col gap-6">
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
        <EngineBadge {engine} />
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

    <!-- Vitals at a glance. -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Last contact"
        value={relativeTime(hostLatestRefresh(host)) || "—"}
        hint={absoluteTime(hostLatestRefresh(host))}
      >
        {#snippet icon()}<Clock class="h-4 w-4" />{/snippet}
      </StatCard>
      <StatCard
        label="Last cron check"
        value={relativeTime(host.last_cron_check) || "—"}
        hint={absoluteTime(host.last_cron_check)}
      >
        {#snippet icon()}<Timer class="h-4 w-4" />{/snippet}
      </StatCard>
      <StatCard
        label="API calls (recent)"
        value={host.api_calls != null ? String(host.api_calls) : "—"}
      >
        {#snippet icon()}<Activity class="h-4 w-4" />{/snippet}
      </StatCard>
      <StatCard
        label="CXX wrapper"
        value={cxxWrapper.drift ? "Drift" : cxxWrapper.display}
        hint={cxxWrapper.drift ? cxxWrapper.display : null}
        class={cxxWrapper.drift ? "border-warning/40" : undefined}
      >
        {#snippet icon()}<Terminal class="h-4 w-4" />{/snippet}
      </StatCard>
    </div>

    <!-- Engines & versions: per-engine overrides via inline popovers, each
         showing the effective value and where it came from. -->
    <Card>
      <CardHeader class="flex flex-row items-start justify-between gap-3 space-y-0">
        <div class="space-y-1.5">
          <CardTitle class="flex items-center gap-2">
            <Package class="h-4 w-4 text-muted-foreground" /> Engines & versions
          </CardTitle>
          <CardDescription>Blank clears an override and inherits the fleet default.</CardDescription>
        </div>
        <Button variant="outline" size="sm" onclick={() => doMintInstaller()} disabled={$mintInstaller.isPending}>
          <Download class="h-3.5 w-3.5" /> {$mintInstaller.isPending ? "Minting…" : "Mint installer"}
        </Button>
      </CardHeader>
      <CardContent>
        <div class="grid gap-3 md:grid-cols-2">
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
        </div>
      </CardContent>
    </Card>

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <!-- Identity & network: facts only. -->
      <Card>
        <CardHeader class="flex flex-row items-start justify-between gap-3 space-y-0">
          <div class="space-y-1.5">
            <CardTitle class="flex items-center gap-2">
              <Network class="h-4 w-4 text-muted-foreground" /> Identity & network
            </CardTitle>
            <CardDescription>Network identity for this host.</CardDescription>
          </div>
          {#if host.ip4 || host.ip6}
            <Button variant="outline" size="sm" onclick={() => (confirmReleaseIpBindingOpen = true)}>
              Release IP binding
            </Button>
          {/if}
        </CardHeader>
        <CardContent>
          <dl class="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {@render dt("Host ID", String(host.id))}
            {@render dt("FQDN", host.fqdn)}
            {@render dt("IP (v4)", host.ip4 ?? "—")}
            {@render dt("IP (v6)", host.ip6 ?? "—")}
          </dl>
        </CardContent>
      </Card>

      <!-- Access & security -->
      <Card>
        <CardHeader class="flex flex-row items-start justify-between gap-3 space-y-0">
          <div class="space-y-1.5">
            <CardTitle class="flex items-center gap-2">
              <ShieldCheck class="h-4 w-4 text-muted-foreground" /> Access & security
            </CardTitle>
            <CardDescription>How strictly this host's requests are authenticated.</CardDescription>
          </div>
          {#if isInsecureWindowActive(host)}
            <InsecureCountdown until={host.insecure_enabled_until} />
          {/if}
        </CardHeader>
        <CardContent>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
          </div>
        </CardContent>
        {#if isInsecureWindowActive(host) || host.secure === false}
          <CardFooter class="flex flex-wrap gap-2">
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
          </CardFooter>
        {/if}
      </Card>
    </div>

    <!-- Fleet policy overrides: collapsible, trigger states what's inside. -->
    <Collapsible.Root bind:open={policyOpen}>
      <Card class="overflow-hidden">
        <h2 id="host-policy-overrides">
          <Collapsible.Trigger class="w-full">
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="group flex w-full flex-row items-center justify-between gap-3 p-5 text-left sm:p-6"
              >
                <div class="space-y-1.5">
                  <div class="flex items-center gap-2 text-lg font-semibold leading-tight tracking-[-0.02em]">
                    <SlidersHorizontal class="h-4 w-4 text-muted-foreground" /> Fleet policy overrides
                  </div>
                  <div class="text-sm text-muted-foreground">
                    {policyOverrideCount > 0
                      ? `${policyOverrideCount} set`
                      : "All inherit fleet defaults"}
                  </div>
                </div>
                <ChevronDown
                  class="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
                />
              </button>
            {/snippet}
          </Collapsible.Trigger>
        </h2>
        <Collapsible.Content>
          <CardContent class="space-y-3 pt-0">
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ToggleRow
                label="VIP"
                checked={host.vip}
                onchange={(v) => runQuiet($vip.mutateAsync({ id, value: v }))}
              />
              <ToggleRow
                label="Roaming"
                checked={host.allow_roaming_ips}
                onchange={(v) => runQuiet($roaming.mutateAsync({ id, value: v }))}
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
            </div>

            <div class="flex flex-col gap-1.5 rounded-md border p-2.5">
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
          </CardContent>
        </Collapsible.Content>
      </Card>
    </Collapsible.Root>

    <!-- Integrations -->
    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Plug class="h-4 w-4 text-muted-foreground" /> Integrations
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ToggleRow
            label="BrowserOS MCP"
            checked={host.browseros_mcp_enabled}
            onchange={(v) => runQuiet($browserOsMcp.mutateAsync({ id, value: v }))}
          />
          <ToggleRow
            label="Codex engine"
            checked={codexEngine}
            disabled={codexSwitchDisabled}
            onchange={(v) => setHostEngine("codex", v)}
          />
          <ToggleRow
            label="Claude engine"
            checked={claudeEngine}
            disabled={claudeSwitchDisabled}
            onchange={(v) => setHostEngine("claude", v)}
          />
        </div>
        <p class="mt-3 text-xs text-muted-foreground">
          Engine changes apply on the host's next <code>cdx</code>/<code>clx</code> run, or its next
          scheduled maintenance tick if neither runs interactively.
        </p>
      </CardContent>
    </Card>

    <DangerZone description="Permanently remove this host from the fleet.">
      <Button variant="destructive" onclick={() => (confirmDeleteOpen = true)}>
        <Trash2 class="h-4 w-4" /> Delete host
      </Button>
    </DangerZone>
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

{#snippet dt(label: string, value: string)}
  <div class="flex flex-col">
    <dt class="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
    <dd class="font-mono text-xs">{value}</dd>
  </div>
{/snippet}
