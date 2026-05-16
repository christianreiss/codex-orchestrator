<script lang="ts">
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import {
    AlertCircle,
    ArrowLeft,
    CheckCircle2,
    Loader2,
    NotebookText,
    Play,
    PlugZap,
    Save,
  } from "@lucide/svelte";
  import { base } from "$app/paths";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "$lib/components/ui/card";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Badge } from "$lib/components/ui/badge";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { Switch } from "$lib/components/ui/switch";
  import {
    integrationKeys,
    joplinActivationLabel,
    joplinApi,
  } from "$lib/api/integrations";
  import { ApiError } from "$lib/api/client";
  import { relativeTime } from "$lib/utils/format";
  import type {
    JoplinConfigPayload,
    JoplinConfigState,
    JoplinSyncResult,
    JoplinSyncState,
    JoplinTestResult,
  } from "$lib/api/types";

  const qc = useQueryClient();

  const configQuery = createQuery<JoplinConfigState>({
    queryKey: integrationKeys.joplinConfig,
    queryFn: () => joplinApi.getConfig(),
    staleTime: 30_000,
  });

  // Form state. Initialized once config loads; tracked separately so
  // editing fields does not race against background refetches.
  let url = $state("");
  let email = $state("");
  let password = $state("");
  let intervalMinutes = $state<number>(15);
  let initialized = $state(false);
  let lastSync = $state<JoplinSyncResult | null>(null);
  let lastTest = $state<{ reachable: boolean; reason?: string | null; version?: string | null } | null>(null);

  // Hydrate form fields when config first arrives (and again if it resets).
  $effect(() => {
    const data = $configQuery.data;
    if (!data) return;
    if (!initialized) {
      url = data.url ?? "";
      email = data.email ?? "";
      intervalMinutes = data.sync_interval_minutes || 15;
      initialized = true;
    }
  });

  const cfg = $derived($configQuery.data);

  function errorMessage(err: unknown): string {
    if (err instanceof ApiError) return err.message;
    if (err instanceof Error) return err.message;
    return "Unexpected error";
  }

  const saveMutation = createMutation({
    mutationFn: (payload: JoplinConfigPayload) => joplinApi.saveConfig(payload),
    onSuccess: (data) => {
      password = ""; // never re-display
      qc.setQueryData(integrationKeys.joplinConfig, data);
      void qc.invalidateQueries({ queryKey: integrationKeys.joplinConfig });
      if (data.initial_sync) lastSync = data.initial_sync;
      toast.success("Joplin configuration saved");
    },
    onError: (err) => {
      toast.error("Save failed", { description: errorMessage(err) });
    },
  });

  const testMutation = createMutation({
    mutationFn: () => joplinApi.test(),
    onSuccess: (data: JoplinTestResult) => {
      qc.setQueryData(integrationKeys.joplinConfig, data);
      lastTest = { reachable: data.reachable, reason: data.reason, version: data.version };
      if (data.reachable) {
        toast.success("Joplin reachable", {
          description: data.version ? `Server version ${data.version}` : undefined,
        });
      } else {
        toast.error("Joplin unreachable", { description: data.reason ?? undefined });
      }
    },
    onError: (err) => {
      toast.error("Test failed", { description: errorMessage(err) });
    },
  });

  const syncMutation = createMutation({
    mutationFn: () => joplinApi.sync(),
    onSuccess: (data: JoplinSyncState) => {
      qc.setQueryData(integrationKeys.joplinConfig, data);
      if (data.sync) {
        lastSync = data.sync;
        toast.success("Sync complete", {
          description: `${data.sync.synced} notes · ${data.sync.notebooks} notebooks${data.sync.errors ? ` · ${data.sync.errors} errors` : ""}`,
        });
      } else {
        toast.success("Sync complete");
      }
    },
    onError: (err) => {
      toast.error("Sync failed", { description: errorMessage(err) });
    },
  });

  function onSave(event: SubmitEvent) {
    event.preventDefault();
    const payload: JoplinConfigPayload = {
      url: url.trim(),
      email: email.trim(),
      sync_interval_minutes: Number(intervalMinutes) || 15,
    };
    if (password.length > 0) payload.password = password;
    $saveMutation.mutate(payload);
  }

  function onTest() {
    $testMutation.mutate();
  }

  function onSync() {
    $syncMutation.mutate();
  }

  function onToggleEnabled(next: boolean) {
    $saveMutation.mutate({ enabled: next });
  }

  const canTest = $derived(!!cfg && cfg.config_complete && !$testMutation.isPending);
  const canSync = $derived(!!cfg && cfg.enabled && cfg.verified_connection && !$syncMutation.isPending);
  const canToggleEnabled = $derived(!!cfg && cfg.can_activate && !$saveMutation.isPending);
</script>

<div class="mb-2">
  <a
    href={`${base}/integrations`}
    class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
  >
    <ArrowLeft class="h-3.5 w-3.5" />
    All integrations
  </a>
</div>

<PageHeader
  title="Joplin sync"
  subtitle="Mirror notes from Joplin into the orchestrator's memory tier"
>
  {#snippet actions()}
    {#if cfg}
      <Badge variant={cfg.enabled ? "success" : cfg.config_complete ? "secondary" : "outline"}>
        {cfg.enabled ? "Enabled" : cfg.config_complete ? "Configured" : "Not configured"}
      </Badge>
    {/if}
  {/snippet}
</PageHeader>

{#if $configQuery.isLoading}
  <div class="space-y-4">
    <div class="h-64 w-full animate-pulse rounded-lg bg-muted"></div>
    <div class="h-32 w-full animate-pulse rounded-lg bg-muted"></div>
  </div>
{:else if $configQuery.isError}
  <Alert variant="destructive">
    <AlertCircle class="h-4 w-4" />
    <AlertTitle>Could not load Joplin configuration</AlertTitle>
    <AlertDescription>{errorMessage($configQuery.error)}</AlertDescription>
  </Alert>
{:else if cfg}
  <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
    <!-- LEFT: Configuration form (2/3) -->
    <div class="lg:col-span-2">
      <Card>
        <CardHeader>
          <div class="flex items-start justify-between gap-3">
            <div class="flex items-start gap-3">
              <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                <NotebookText class="h-5 w-5" />
              </div>
              <div>
                <CardTitle>Configuration</CardTitle>
                <CardDescription>Credentials for the Joplin Server account used to fetch notes.</CardDescription>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs text-muted-foreground">Enabled</span>
              <Switch
                checked={cfg.enabled}
                disabled={!canToggleEnabled && !cfg.enabled}
                onCheckedChange={(v) => onToggleEnabled(v)}
                aria-label="Enable Joplin sync"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form class="space-y-4" onsubmit={onSave}>
            <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div class="space-y-1.5 sm:col-span-2">
                <Label for="joplin-url">Server URL</Label>
                <Input
                  id="joplin-url"
                  type="url"
                  placeholder="https://joplin.example.com"
                  bind:value={url}
                  autocomplete="off"
                  required
                />
                <p class="text-xs text-muted-foreground">Full URL including scheme. No trailing slash.</p>
              </div>
              <div class="space-y-1.5">
                <Label for="joplin-email">Email</Label>
                <Input
                  id="joplin-email"
                  type="email"
                  placeholder="you@example.com"
                  bind:value={email}
                  autocomplete="username"
                  required
                />
              </div>
              <div class="space-y-1.5">
                <Label for="joplin-password">Password</Label>
                <Input
                  id="joplin-password"
                  type="password"
                  placeholder={cfg.password_set ? "•••••••• (set)" : "Account password"}
                  bind:value={password}
                  autocomplete="new-password"
                />
                <p class="text-xs text-muted-foreground">
                  Leave blank to keep the existing password.
                </p>
              </div>
              <div class="space-y-1.5">
                <Label for="joplin-interval">Sync interval (minutes)</Label>
                <Input
                  id="joplin-interval"
                  type="number"
                  min="1"
                  max="1440"
                  bind:value={intervalMinutes}
                />
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-2 border-t pt-4">
              <Button type="submit" disabled={$saveMutation.isPending}>
                {#if $saveMutation.isPending}
                  <Loader2 class="h-4 w-4 animate-spin" />
                {:else}
                  <Save class="h-4 w-4" />
                {/if}
                Save configuration
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!canTest}
                onclick={onTest}
              >
                {#if $testMutation.isPending}
                  <Loader2 class="h-4 w-4 animate-spin" />
                {:else}
                  <PlugZap class="h-4 w-4" />
                {/if}
                Test connection
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={!canSync}
                onclick={onSync}
              >
                {#if $syncMutation.isPending}
                  <Loader2 class="h-4 w-4 animate-spin" />
                {:else}
                  <Play class="h-4 w-4" />
                {/if}
                Sync now
              </Button>
            </div>

            {#if !cfg.can_activate && cfg.activation_reason !== "ready"}
              <p class="text-xs text-amber-600 dark:text-amber-400">
                {joplinActivationLabel(cfg.activation_reason)}
              </p>
            {/if}
          </form>
        </CardContent>
      </Card>
    </div>

    <!-- RIGHT: Status / activity (1/3) -->
    <div class="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle class="text-base">Status</CardTitle>
          <CardDescription>Connection &amp; sync state</CardDescription>
        </CardHeader>
        <CardContent class="space-y-3 text-sm">
          <div class="flex items-center justify-between">
            <span class="text-muted-foreground">Connection</span>
            {#if cfg.verified_connection}
              <span class="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 class="h-4 w-4" /> Verified
              </span>
            {:else}
              <span class="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <AlertCircle class="h-4 w-4" /> Not verified
              </span>
            {/if}
          </div>
          <div class="flex items-center justify-between">
            <span class="text-muted-foreground">Verified at</span>
            <span class="text-right">
              {cfg.verified_at ? relativeTime(cfg.verified_at) : "Never"}
            </span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-muted-foreground">Sync interval</span>
            <span>{cfg.sync_interval_minutes} min</span>
          </div>
          {#if lastTest}
            <div class="rounded-md border bg-muted/30 px-3 py-2 text-xs">
              <div class="font-medium">Last test</div>
              <div class="text-muted-foreground">
                {lastTest.reachable ? "Reachable" : "Unreachable"}
                {#if lastTest.version}· v{lastTest.version}{/if}
                {#if !lastTest.reachable && lastTest.reason}· {lastTest.reason}{/if}
              </div>
            </div>
          {/if}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="text-base">Last sync</CardTitle>
          <CardDescription>Most recent mirror result</CardDescription>
        </CardHeader>
        <CardContent class="space-y-2 text-sm">
          {#if lastSync}
            <div class="flex items-center justify-between">
              <span class="text-muted-foreground">Notes synced</span>
              <span class="font-medium">{lastSync.synced}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-muted-foreground">Notebooks</span>
              <span class="font-medium">{lastSync.notebooks}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-muted-foreground">Errors</span>
              <span class={lastSync.errors > 0 ? "font-medium text-amber-600 dark:text-amber-400" : "font-medium"}>
                {lastSync.errors}
              </span>
            </div>
            {#if lastSync.errors > 0}
              <Alert variant="warning" class="mt-2">
                <AlertCircle class="h-4 w-4" />
                <AlertTitle>Partial sync</AlertTitle>
                <AlertDescription>
                  {lastSync.errors} item(s) failed to mirror. Run a connection test or check the logs.
                </AlertDescription>
              </Alert>
            {/if}
          {:else}
            <p class="text-muted-foreground">No sync has run in this session yet.</p>
          {/if}
        </CardContent>
      </Card>
    </div>
  </div>
{/if}
