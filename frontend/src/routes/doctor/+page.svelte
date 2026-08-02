<script lang="ts">
  import { createMutation } from "@tanstack/svelte-query";
  import { base } from "$app/paths";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Badge, type BadgeVariant } from "$lib/components/ui/badge";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import * as Card from "$lib/components/ui/card";
  import * as Tabs from "$lib/components/ui/tabs";
  import * as Select from "$lib/components/ui/select";
  import * as Alert from "$lib/components/ui/alert";
  import { cn } from "$lib/utils/cn";
  import { relativeTime } from "$lib/utils/format";
  import { NAV } from "$lib/nav";
  import { doctorApi, type DoctorReport, type DoctorRow, type DoctorStatus, type DoctorTestKeyResult } from "$lib/api/doctor";
  import { engineLabel } from "$lib/api/keys";
  import type { ApiKeyEngine } from "$lib/api/types";

  let report = $state<DoctorReport | null>(null);
  let activeTab = $state<"encryption" | "test-console">("encryption");

  const statusMut = createMutation<DoctorReport, Error, void>({
    mutationFn: () => doctorApi.status(),
  });

  function runDiagnostics(): void {
    $statusMut.mutate(undefined, {
      onSuccess: (data) => {
        report = data;
      },
    });
  }

  const rows = $derived<DoctorRow[]>(report?.rows ?? []);

  // Backend row ids/labels for the encryption keyring aren't a fixed
  // contract -- match loosely so a re-labeled or re-shaped row still
  // surfaces here instead of silently vanishing from the tab.
  const encryptionRows = $derived(
    rows.filter((row) => /encrypt|keyring|canary|secret.?box/i.test(`${row.id} ${row.label}`)),
  );

  const summaryLine = $derived.by(() => {
    if (!report) return null;
    const { hosts, canonical_auth } = report;
    return (
      `${hosts.synced} of ${hosts.total} hosts synced` +
      ` · Codex auth ${canonical_auth.codex ? "present" : "missing"}` +
      ` · Claude auth ${canonical_auth.claude ? "present" : "missing"}`
    );
  });

  function statusVariant(status: DoctorStatus): BadgeVariant {
    if (status === "ok") return "success";
    if (status === "warn") return "warning";
    return "destructive";
  }

  function ownerLabel(route: string): string {
    return NAV.find((item) => item.route === route)?.label ?? route;
  }

  // ---- Test console ----
  let testEngine = $state<ApiKeyEngine>("openai");
  let testKey = $state("");
  let testResult = $state<DoctorTestKeyResult | null>(null);
  let testFailure = $state<string | null>(null);

  const testMut = createMutation<DoctorTestKeyResult, Error, { engine: ApiKeyEngine; key: string }>({
    mutationFn: (payload) => doctorApi.testKey(payload),
  });

  function runTest(event: SubmitEvent): void {
    event.preventDefault();
    const key = testKey.trim();
    if (!key) return;
    testResult = null;
    testFailure = null;
    $testMut.mutate(
      { engine: testEngine, key },
      {
        onSuccess: (data) => {
          testResult = data;
        },
        onError: (err) => {
          testFailure = err.message || "Test request failed";
        },
      },
    );
  }
</script>

<PageHeader
  title="Doctor"
  subtitle="Server-side self-diagnostic: connectivity, encryption, and proxy checks."
>
  {#snippet actions()}
    <span class="text-xs text-muted-foreground">
      {report ? `Checked ${relativeTime(report.generated_at)}` : "Not run yet"}
    </span>
    <Button onclick={runDiagnostics} disabled={$statusMut.isPending}>
      <RefreshCw class={cn("h-4 w-4", $statusMut.isPending && "animate-spin")} />
      {$statusMut.isPending ? "Running…" : "Run diagnostics"}
    </Button>
  {/snippet}
</PageHeader>

<section class="setting-boundary">
  <div class="setting-boundary__head">
    <h2>Checks</h2>
    <p>
      Database connectivity, migrations, canonical auth, encryption keyring, kill-switches, and
      issued-key state. Every remediation is a link to the page that owns that setting.
    </p>
    {#if summaryLine}
      <p class="mt-1 text-xs text-muted-foreground">{summaryLine}</p>
    {/if}
  </div>

  {#if $statusMut.isPending}
    <div class="space-y-2">
      {#each Array(5) as _, i (i)}
        <Skeleton class="h-12 w-full" />
      {/each}
    </div>
  {:else if !report}
    {#if $statusMut.isError}
      <Alert.Root variant="destructive">
        <Alert.Title>Diagnostics failed</Alert.Title>
        <Alert.Description>{$statusMut.error?.message ?? "Unknown error"}</Alert.Description>
      </Alert.Root>
    {:else}
      <div class="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
        Not run yet — click "Run diagnostics" to check connectivity, migrations, canonical auth,
        encryption, and issued-key state.
      </div>
    {/if}
  {:else}
    {#if $statusMut.isError}
      <Alert.Root variant="warning" class="mb-3">
        <Alert.Title>Last refresh failed</Alert.Title>
        <Alert.Description>
          {$statusMut.error?.message ?? "Unknown error"} — showing the previous report.
        </Alert.Description>
      </Alert.Root>
    {/if}
    <ul class="divide-y divide-border rounded-md border">
      {#each rows as row (row.id)}
        <li class="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
              <span class="text-sm font-medium">{row.label}</span>
            </div>
            <p class="mt-1 min-w-0 break-words text-xs text-muted-foreground">{row.detail}</p>
            {#if row.hint}
              <p class="mt-0.5 min-w-0 break-words text-xs text-muted-foreground">{row.hint}</p>
            {/if}
          </div>
          {#if row.owner_route}
            <Button href={`${base}${row.owner_route}`} variant="ghost" size="sm" class="shrink-0">
              Fix in {ownerLabel(row.owner_route)}
              <ArrowRight class="h-3.5 w-3.5" />
            </Button>
          {/if}
        </li>
      {/each}
      {#if rows.length === 0}
        <li class="px-3 py-4 text-sm text-muted-foreground">This report contained no rows.</li>
      {/if}
    </ul>
  {/if}
</section>

<Tabs.Root class="mt-6" value={activeTab} onValueChange={(v) => (activeTab = (v as typeof activeTab) ?? activeTab)}>
  <Tabs.List>
    <Tabs.Trigger value="encryption">Encryption</Tabs.Trigger>
    <Tabs.Trigger value="test-console">Test console</Tabs.Trigger>
  </Tabs.List>

  <Tabs.Content value="encryption" class="mt-4">
    {#if !report}
      <p class="text-sm text-muted-foreground">Run diagnostics to see encryption status.</p>
    {:else if encryptionRows.length === 0}
      <p class="text-sm text-muted-foreground">This report contained no encryption rows.</p>
    {:else}
      <Card.Root class="max-w-xl">
        <Card.Header>
          <Card.Title>Encryption keyring</Card.Title>
          <Card.Description>
            Active key, configured key count, and canary round-trip result. Read-only — there is
            no rotation control here.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <dl class="divide-y divide-border text-sm">
            {#each encryptionRows as row (row.id)}
              <div class="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
                <div class="min-w-0">
                  <dt class="font-medium">{row.label}</dt>
                  <dd class="min-w-0 break-words text-muted-foreground">{row.detail}</dd>
                </div>
                <Badge variant={statusVariant(row.status)} class="shrink-0">{row.status}</Badge>
              </div>
            {/each}
          </dl>
        </Card.Content>
      </Card.Root>
    {/if}
  </Tabs.Content>

  <Tabs.Content value="test-console" class="mt-4">
    <div class="max-w-lg space-y-4">
      <p class="text-xs text-muted-foreground">
        This fires a real request against the upstream provider using the key you paste below. It
        counts against that key's real rate limit and increments its use count — it is not a free
        or invisible probe. This only ever tests a key you paste in here, never a stored key by
        reference.
      </p>

      <form onsubmit={runTest} class="space-y-4">
        <div class="grid gap-2">
          <Label for="doctor-test-engine">Engine</Label>
          <Select.Root
            type="single"
            value={testEngine}
            onValueChange={(v) => (testEngine = (v as ApiKeyEngine) ?? testEngine)}
          >
            <Select.Trigger id="doctor-test-engine">{engineLabel(testEngine)}</Select.Trigger>
            <Select.Content>
              <Select.Item value="openai" label="OpenAI (Codex)" />
              <Select.Item value="claude" label="Claude (Anthropic)" />
            </Select.Content>
          </Select.Root>
        </div>

        <div class="grid gap-2">
          <Label for="doctor-test-key">API key</Label>
          <Input
            id="doctor-test-key"
            type="password"
            bind:value={testKey}
            autocomplete="new-password"
            placeholder={testEngine === "openai" ? "sk-…" : "sk-ant-…"}
          />
        </div>

        <Button type="submit" disabled={$testMut.isPending || !testKey.trim()}>
          {$testMut.isPending ? "Running…" : "Run test"}
        </Button>
      </form>

      {#if testResult}
        <Alert.Root variant={testResult.ok ? "default" : "destructive"}>
          <Alert.Title>{testResult.ok ? "Key works" : "Key test failed"}</Alert.Title>
          <Alert.Description>
            <dl class="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <dt class="text-muted-foreground">HTTP status</dt>
              <dd>{testResult.status ?? "—"}</dd>
              <dt class="text-muted-foreground">Latency</dt>
              <dd>{testResult.latency_ms} ms</dd>
              {#if testResult.model_count !== undefined}
                <dt class="text-muted-foreground">Models visible</dt>
                <dd>{testResult.model_count}</dd>
              {/if}
              {#if testResult.error}
                <dt class="text-muted-foreground">Error</dt>
                <dd class="min-w-0 break-words">{testResult.error}</dd>
              {/if}
            </dl>
          </Alert.Description>
        </Alert.Root>
      {:else if testFailure}
        <Alert.Root variant="destructive">
          <Alert.Title>Test request failed</Alert.Title>
          <Alert.Description class="min-w-0 break-words">{testFailure}</Alert.Description>
        </Alert.Root>
      {/if}
    </div>
  </Tabs.Content>
</Tabs.Root>
