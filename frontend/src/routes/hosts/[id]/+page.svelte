<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { useQueryClient } from "@tanstack/svelte-query";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import * as Card from "$lib/components/ui/card";
  import StatusPill from "$lib/components/hosts/StatusPill.svelte";
  import EngineBadge from "$lib/components/hosts/EngineBadge.svelte";
  import InsecureCountdown from "$lib/components/hosts/InsecureCountdown.svelte";
  import ConfirmDialog from "$lib/components/hosts/ConfirmDialog.svelte";
  import InputDialog from "$lib/components/hosts/InputDialog.svelte";
  import SeedAuthDialog from "$lib/components/hosts/SeedAuthDialog.svelte";
  import InsecureWindowPopover from "$lib/components/hosts/InsecureWindowPopover.svelte";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import Copy from "@lucide/svelte/icons/copy";
  import Download from "@lucide/svelte/icons/download";
  import AlertTriangle from "@lucide/svelte/icons/triangle-alert";
  import { relativeTime } from "$lib/utils/format";
  import {
    hostDetailQuery,
    hostsKeys,
    hostEngines,
    hostLatestRefresh,
    hostStatusKind,
    isInsecureWindowActive,
    createDeleteHostMutation,
    createClearHostAuthMutation,
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
  const clearAuth = createClearHostAuthMutation(qc);
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

  async function run<T>(label: string, p: Promise<T>): Promise<void> {
    try {
      await p;
      toast.success(label);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Action failed";
      toast.error(msg);
    }
  }

  async function refresh(): Promise<void> {
    await qc.invalidateQueries({ queryKey: hostsKeys.detail(id) });
    toast.success("Refreshing…");
  }

  // Dialog state
  let confirmDeleteOpen = $state(false);
  let confirmClearOpen = $state(false);
  let codexDialogOpen = $state(false);
  let claudeDialogOpen = $state(false);
  let codexModelDialogOpen = $state(false);
  let claudeModelDialogOpen = $state(false);
  let agentsDialogOpen = $state(false);
  let installerDialogOpen = $state(false);
  let installerResult = $state<InstallerInfo | null>(null);
  let installerEngines = $state<Array<"codex" | "claude"> | undefined>(undefined);
  let seedAuthOpen = $state(false);

  async function doDelete(): Promise<void> {
    try {
      await $deleteMut.mutateAsync({ id });
      toast.success("Host deleted");
      void goto(`${base}/hosts`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Delete failed";
      toast.error(msg);
    }
  }

  async function doClear(): Promise<void> {
    await run("Auth cleared", $clearAuth.mutateAsync({ id }));
  }

  async function doMintInstaller(engines?: Array<"codex" | "claude">): Promise<void> {
    try {
      installerEngines = engines ? [...engines] : undefined;
      const result = await $mintInstaller.mutateAsync({ id, engines });
      installerResult = result.installer;
      installerDialogOpen = true;
      const copied = await writeInstallerCommandToClipboard(result.installer.command);
      toast.success(copied ? "Installer minted and command copied" : "Installer minted");
      if (!copied) toast.error("Auto-copy failed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Installer mint failed";
      toast.error(msg);
    }
  }

  async function recreateInstaller(): Promise<void> {
    await doMintInstaller(installerEngines);
  }

  async function copyInstallerCommand(): Promise<void> {
    if (!installerResult?.command) return;
    const copied = await writeInstallerCommandToClipboard(installerResult.command);
    if (copied) {
      toast.success("Installer command copied");
    } else {
      toast.error("Copy failed");
    }
  }

  async function writeInstallerCommandToClipboard(command: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(command);
      return true;
    } catch {
      return false;
    }
  }

  async function copyInstallerUrl(): Promise<void> {
    if (!installerResult?.url) return;
    try {
      await navigator.clipboard.writeText(installerResult.url);
      toast.success("Installer URL copied");
    } catch {
      toast.error("Copy failed");
    }
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
  // Pre-select an engine on the Seed Auth dialog when the host has only one.
  const seedDefaultEngine = $derived<"codex" | "claude">(
    codexEngine && !claudeEngine
      ? "codex"
      : !codexEngine && claudeEngine
        ? "claude"
        : "codex",
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
    const label =
      mode === "global"
        ? "Reverse DNS inherits fleet default"
        : mode === "enabled"
          ? "Reverse DNS forced on"
          : "Reverse DNS forced off";
    await run(label, $reverseDns.mutateAsync({ id, mode }));
  }

  async function setHostEngine(engine: HostEngine, enabled: boolean): Promise<void> {
    const current: HostEngine[] = engineList.length ? [...engineList] : ["codex"];
    const next: HostEngine[] = enabled
      ? Array.from(new Set([...current, engine]))
      : current.filter((item) => item !== engine);
    if (next.length === 0) return;
    await run(`${engine === "codex" ? "Codex" : "Claude"} ${enabled ? "enabled" : "disabled"}`, $hostEnginesMutation.mutateAsync({ id, engines: next }));
  }
</script>

{#if $detail.isLoading}
  <div class="space-y-3">
    <Skeleton class="h-10 w-64" />
    <Skeleton class="h-40 w-full" />
    <Skeleton class="h-40 w-full" />
  </div>
{:else if $detail.isError || !host}
  <div class="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
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

  <div class="mb-5 flex flex-wrap items-center gap-1.5">
    {#if isInsecureWindowActive(host)}
      <StatusPill tone="warning" label="Insecure" />
    {:else if host.secure}
      <StatusPill tone="secure" label="Secure" />
    {:else}
      <StatusPill tone="muted" label="Insecure (closed)" />
    {/if}
    {#if hostStatusKind(host) === "online"}
      <StatusPill tone="online" label="Online" />
    {:else if hostStatusKind(host) === "auth-missing"}
      <StatusPill tone="warning" label="Auth missing" />
    {:else if hostStatusKind(host) === "auth-outdated"}
      <StatusPill tone="warning" label="Outdated auth" />
    {:else}
      <StatusPill tone="offline" label="Offline" />
    {/if}
    {#if host.vip}
      <StatusPill tone="info" label="VIP" />
    {/if}
    {#if host.allow_roaming_ips}
      <StatusPill tone="info" label="Roaming" />
    {/if}
    {#if host.browseros_mcp_enabled}
      <StatusPill tone="info" label="BrowserOS" />
    {/if}
    {#if host.effective_auto_update_enabled}
      <StatusPill tone="online" label="Auto-update" />
    {/if}
    {#each hostEngines(host) as engine}
      <EngineBadge {engine} />
    {/each}
  </div>

  <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
    <!-- Stats -->
    <Card.Root>
      <Card.Header>
        <Card.Title>Stats</Card.Title>
      </Card.Header>
      <Card.Content class="space-y-2 text-sm">
        <div class="flex justify-between">
          <span class="text-muted-foreground">Last contact</span>
          <span>{relativeTime(hostLatestRefresh(host)) || "—"}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-muted-foreground">Last cron check</span>
          <span>{relativeTime(host.last_cron_check) || "—"}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-muted-foreground">API calls (recent)</span>
          <span>{host.api_calls ?? "—"}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-muted-foreground">Insecure window</span>
          <InsecureCountdown until={host.insecure_enabled_until} />
        </div>
      </Card.Content>
    </Card.Root>

    <!-- Action items -->
    <Card.Root>
      <Card.Header>
        <Card.Title>Action items</Card.Title>
      </Card.Header>
      <Card.Content class="text-sm">
        {#if actionItems.length === 0}
          <p class="text-muted-foreground">Nothing requires attention.</p>
        {:else}
          <ul class="space-y-2">
            {#each actionItems as item}
              <li
                class="flex items-start gap-2 rounded-md border px-2.5 py-1.5 {item.tone === 'warning'
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                  : 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300'}"
              >
                <AlertTriangle class="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>{item.text}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </Card.Content>
    </Card.Root>

    <!-- Technical context -->
    <Card.Root class="lg:col-span-2">
      <Card.Header>
        <Card.Title>Technical context</Card.Title>
        <Card.Description>Configuration and runtime state pulled from the host record.</Card.Description>
      </Card.Header>
      <Card.Content>
        <dl class="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {@render dt("Host ID", String(host.id))}
          {@render dt("FQDN", host.fqdn)}
          {@render dt("IP (v4)", host.ip4 ?? "—")}
          {@render dt("IP (v6)", host.ip6 ?? "—")}
          {@render dt("Codex version", host.client_version_override ?? host.client_version ?? "—")}
          {@render dt("Claude version", host.claude_client_version_override ?? host.claude_client_version ?? "—")}
          {@render dt("Wrapper (Codex)", host.wrapper_version ?? "—")}
          {@render dt("Wrapper (Claude)", host.claude_wrapper_version ?? "—")}
          {@render dt("Model override", host.model_override ?? "—")}
          {@render dt("Reasoning override", host.reasoning_effort_override ?? "—")}
          {@render dt("Claude model", host.claude_model_override ?? "—")}
          {@render dt("Binary digest", host.canonical_digest ? host.canonical_digest.slice(0, 16) + "…" : "—")}
          {@render dt("VIP", host.vip ? "yes" : "no")}
          {@render dt("Auto-update", host.effective_auto_update_enabled ? host.auto_update_label || "on" : "off")}
          {@render dt(
            "Insecure",
            host.secure
              ? "secure"
              : host.insecure_enabled_until
                ? `until ${host.insecure_enabled_until}`
                : "off",
          )}
          {@render dt("Roaming", host.allow_roaming_ips ? "allowed" : "static")}
          {@render dt("Lane", host.lane_preference ?? "—")}
          <div class="flex flex-col">
            <dt class="text-[11px] uppercase tracking-wide text-muted-foreground">Reverse DNS</dt>
            <dd class="mt-1">
              <div class="inline-flex overflow-hidden rounded-md border border-input text-[11px]">
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
            </dd>
          </div>
          {@render dt("Agents doc override", host.agents_document_id_override ? String(host.agents_document_id_override) : "—")}
        </dl>
      </Card.Content>
    </Card.Root>

    <!-- Controls -->
    <Card.Root class="lg:col-span-2">
      <Card.Header>
        <Card.Title>Controls</Card.Title>
        <Card.Description>Optimistic toggles and lifecycle actions.</Card.Description>
      </Card.Header>
      <Card.Content>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {@render toggleRow("Secure", host.secure, (v) =>
            run(v ? "Secure" : "Insecure", $secure.mutateAsync({ id, value: v })),
          )}
          {@render toggleRow("Auto-update", host.effective_auto_update_enabled, (v) =>
            run(v ? "Auto-update on" : "Auto-update off", $autoUpdate.mutateAsync({ id, value: v })),
          )}
          {@render toggleRow("VIP", host.vip, (v) =>
            run(v ? "VIP on" : "VIP off", $vip.mutateAsync({ id, value: v })),
          )}
          {@render toggleRow("Roaming", host.allow_roaming_ips, (v) =>
            run(v ? "Roaming on" : "Roaming off", $roaming.mutateAsync({ id, value: v })),
          )}
          {@render toggleRow("Scaling exempt", host.lane_preference === "exempt", (v) =>
            run("Scaling pref updated", $scaling.mutateAsync({ id, value: v })),
          )}
          {@render toggleRow("Curl insecure", host.curl_insecure, (v) =>
            run("Curl insecure updated", $curlInsecure.mutateAsync({ id, value: v })),
          )}
          {@render toggleRow("BrowserOS MCP", host.browseros_mcp_enabled, (v) =>
            run(v ? "BrowserOS MCP on" : "BrowserOS MCP off", $browserOsMcp.mutateAsync({ id, value: v })),
          )}
          {@render engineSwitchRow("Codex", codexEngine, codexSwitchDisabled, (v) => setHostEngine("codex", v))}
          {@render engineSwitchRow("Claude", claudeEngine, claudeSwitchDisabled, (v) => setHostEngine("claude", v))}
        </div>

        <div class="mt-4 flex flex-wrap gap-2 border-t pt-4">
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

          {#if codexEngine}
            <Button variant="outline" onclick={() => (codexDialogOpen = true)}>
              Codex version
            </Button>
            <Button variant="outline" onclick={() => (codexModelDialogOpen = true)}>
              Codex model override
            </Button>
          {/if}
          {#if claudeEngine}
            <Button variant="outline" onclick={() => (claudeDialogOpen = true)}>
              Claude version
            </Button>
            <Button variant="outline" onclick={() => (claudeModelDialogOpen = true)}>
              Claude model override
            </Button>
          {/if}

          <Button variant="outline" onclick={() => (agentsDialogOpen = true)}>
            Agents version
          </Button>

          <Button variant="outline" onclick={() => doMintInstaller()} disabled={$mintInstaller.isPending}>
            <Download class="h-4 w-4" /> {$mintInstaller.isPending ? "Minting…" : "Mint installer"}
          </Button>

          <div class="ml-auto flex gap-2">
            <Button variant="outline" onclick={() => (seedAuthOpen = true)}>
              <KeyRound class="h-4 w-4" /> Seed auth
            </Button>
            <Button variant="outline" onclick={() => (confirmClearOpen = true)}>
              <KeyRound class="h-4 w-4" /> Clear auth
            </Button>
            <Button variant="destructive" onclick={() => (confirmDeleteOpen = true)}>
              <Trash2 class="h-4 w-4" /> Delete host
            </Button>
          </div>
        </div>
      </Card.Content>
    </Card.Root>
  </div>

  <ConfirmDialog
    bind:open={confirmDeleteOpen}
    onOpenChange={(v) => (confirmDeleteOpen = v)}
    title="Delete host?"
    description={`Permanently remove ${host.fqdn} from the fleet. This cannot be undone.`}
    confirmLabel="Delete"
    destructive
    onConfirm={doDelete}
  />
  <ConfirmDialog
    bind:open={confirmClearOpen}
    onOpenChange={(v) => (confirmClearOpen = v)}
    title="Clear auth?"
    description={`Drop ${host.fqdn}'s API key and payload digest. The host will re-pair on next contact.`}
    confirmLabel="Clear"
    destructive
    onConfirm={doClear}
  />
  <InputDialog
    bind:open={codexDialogOpen}
    onOpenChange={(v) => (codexDialogOpen = v)}
    title="Codex version override"
    description="Pin a specific Codex client version for this host (semver). Empty clears."
    label="Version"
    placeholder={overview?.versions.client_version ?? "0.30.0"}
    initialValue={host.client_version_override ?? ""}
    onSubmit={(v) => run("Version updated", $codexVersion.mutateAsync({ id, version: v }))}
  />
  <InputDialog
    bind:open={claudeDialogOpen}
    onOpenChange={(v) => (claudeDialogOpen = v)}
    title="Claude version override"
    description="Pin a specific Claude client version for this host. Empty clears."
    label="Version"
    placeholder={overview?.versions.claude_version ?? "1.0.0"}
    initialValue={host.claude_client_version_override ?? ""}
    onSubmit={(v) => run("Version updated", $claudeVersion.mutateAsync({ id, version: v }))}
  />
  <InputDialog
    bind:open={codexModelDialogOpen}
    onOpenChange={(v) => (codexModelDialogOpen = v)}
    title="Codex model override"
    description="Pin a specific Codex model. Empty clears the override."
    label="Model"
    placeholder="gpt-5.5"
    initialValue={host.model_override ?? ""}
    onSubmit={(v) => run("Model updated", $modelOverride.mutateAsync({ id, engine: "codex", model: v }))}
  />
  <InputDialog
    bind:open={claudeModelDialogOpen}
    onOpenChange={(v) => (claudeModelDialogOpen = v)}
    title="Claude model override"
    description="Pin a specific Claude model. Empty clears the override."
    label="Model"
    placeholder="claude-sonnet-4-7"
    initialValue={host.claude_model_override ?? ""}
    onSubmit={(v) => run("Model updated", $modelOverride.mutateAsync({ id, engine: "claude", model: v }))}
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
      return run(
        "Agents version updated",
        $agentsVersion.mutateAsync({ id, document_id: Number.isFinite(parsed) ? parsed : null }),
      );
    }}
  />
  <SeedAuthDialog bind:open={seedAuthOpen} defaultEngine={seedDefaultEngine} />
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
        <Button variant="outline" onclick={copyInstallerUrl} disabled={!installerResult?.url}>
          <Copy class="h-4 w-4" /> Copy URL
        </Button>
        <Button variant="outline" onclick={copyInstallerCommand} disabled={!installerResult?.command}>
          <Copy class="h-4 w-4" /> Copy command
        </Button>
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

{#snippet toggleRow(label: string, checked: boolean, onchange: (v: boolean) => void | Promise<void>)}
  <div class="flex items-center justify-between rounded-md border p-2.5">
    <span class="text-sm">{label}</span>
    <Switch
      {checked}
      onCheckedChange={(v) => {
        void onchange(Boolean(v));
      }}
      aria-label={label}
    />
  </div>
{/snippet}

{#snippet engineSwitchRow(label: string, checked: boolean, disabled: boolean, onchange: (v: boolean) => void | Promise<void>)}
  <div class="flex items-center justify-between rounded-md border p-2.5">
    <span class="text-sm">{label}</span>
    <Switch
      {checked}
      {disabled}
      onCheckedChange={(v) => {
        void onchange(Boolean(v));
      }}
      aria-label="{label} engine"
    />
  </div>
{/snippet}
