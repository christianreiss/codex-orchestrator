<script lang="ts">
  /**
   * Dashboard "Runner state" card — restores the legacy admin surface that
   * lets the operator inspect the verification runner and manually trigger
   * Codex / Claude verification cycles.
   *
   * The backend currently does not emit WebSocket events for runner state
   * changes (see `api/src/services/runner-proxy.ts` + grep over `api/src`
   * for `runner.` publish calls); the underlying query polls every 15 s
   * via `createRunnerStateQuery`. After a manual trigger we explicitly
   * invalidate to reflect the new state immediately.
   */
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CardDescription,
  } from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { Alert, AlertTitle, AlertDescription } from "$lib/components/ui/alert";
  import Loader2 from "@lucide/svelte/icons/loader-2";
  import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
  import PlayCircle from "@lucide/svelte/icons/play-circle";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import {
    createRunnerStateQuery,
    createRunCodexRunnerMutation,
    createRunClaudeRunnerMutation,
    type RunnerEngineStatus,
    type RunnerStatus,
  } from "$lib/api/runner";
  import { toast } from "svelte-sonner";
  import { relativeTime } from "$lib/utils/format";

  const state = createRunnerStateQuery();
  const runCodex = createRunCodexRunnerMutation();
  const runClaude = createRunClaudeRunnerMutation();

  const runner = $derived<RunnerStatus | null>($state.data?.runner ?? null);

  type EngineKey = "codex" | "claude";
  type BadgeVariant = "default" | "secondary" | "success" | "warning" | "destructive";

  interface EngineRow {
    engine: EngineKey;
    label: string;
    actionLabel: string;
    status: RunnerEngineStatus | null;
    token: string;
    variant: BadgeVariant;
    lastRun: string | null;
    lastOk: string | null;
    lastFail: string | null;
    lastError: string | null;
  }

  const sharedToken = $derived.by<string>(() => {
    if (!runner) return "idle";
    if (!runner.configured) return "unconfigured";
    return runner.ready ? "ready" : "fail";
  });

  const sharedVariant = $derived<BadgeVariant>(
    sharedToken === "ready" ? "success" : sharedToken === "fail" || sharedToken === "unconfigured" ? "destructive" : "secondary",
  );

  const sharedLabel = $derived(sharedToken === "unconfigured" ? "not configured" : sharedToken);

  const engineRows = $derived.by<EngineRow[]>(() => [
    buildEngineRow("codex", "Codex", "Run Codex runner"),
    buildEngineRow("claude", "Claude", "Verify Claude"),
  ]);

  const anyEngineRunning = $derived(engineRows.some((row) => row.token === "running"));

  function buildEngineRow(engine: EngineKey, label: string, actionLabel: string): EngineRow {
    const status = engineStatus(engine);
    const token = engineToken(status);
    return {
      engine,
      label,
      actionLabel,
      status,
      token,
      variant: badgeVariant(token),
      lastRun: status?.last_run ?? status?.last_check ?? null,
      lastOk: status?.last_ok ?? null,
      lastFail: status?.last_fail ?? null,
      lastError: status?.last_error ?? null,
    };
  }

  function engineStatus(engine: EngineKey): RunnerEngineStatus | null {
    const direct = runner?.engines?.[engine];
    if (direct) return direct;
    const legacy = runner?.last_result;
    if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
      const candidate = legacy[engine];
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        return candidate as RunnerEngineStatus;
      }
    }
    return null;
  }

  function engineToken(status: RunnerEngineStatus | null): string {
    if (!runner) return "idle";
    if (!runner.configured) return "unconfigured";
    const raw = (status?.state ?? "").toLowerCase();
    if (raw === "running" || raw === "ok" || raw === "fail" || raw === "idle") return raw;
    return runner.ready ? "idle" : "fail";
  }

  function badgeVariant(token: string): BadgeVariant {
    if (token === "ok") return "success";
    if (token === "running") return "secondary";
    if (token === "fail" || token === "unconfigured") return "destructive";
    return "secondary";
  }

  function pending(engine: EngineKey): boolean {
    return engine === "codex" ? $runCodex.isPending : $runClaude.isPending;
  }

  function lastLine(row: EngineRow): string {
    if (row.lastRun) return relativeTime(row.lastRun);
    return "never";
  }

  function titleTime(value: string | null): string | undefined {
    return value ?? undefined;
  }

  function actionFor(engine: EngineKey) {
    return engine === "codex" ? handleRunCodex : handleRunClaude;
  }

  function actionDisabled(row: EngineRow): boolean {
    return pending(row.engine) || anyEngineRunning || !runner?.ready;
  }

  function successLine(row: EngineRow): string | null {
    if (!row.lastOk) return null;
    return `OK ${relativeTime(row.lastOk)}`;
  }

  function failureLine(row: EngineRow): string | null {
    if (!row.lastFail) return null;
    return `Fail ${relativeTime(row.lastFail)}`;
  }

  function tokenLabel(token: string): string {
    return token === "unconfigured" ? "not configured" : token;
  }

  function truncate(value: string, max = 180): string {
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  function resultIsOk(data: { status?: string }): boolean {
    return data.status === "ok";
  }

  function resultMessage(data: { reason?: string; detail?: string }, fallback: string): string {
    return data.reason || data.detail || fallback;
  }

  function handleRunCodex() {
    $runCodex.mutate(undefined, {
      onSuccess: (data) => {
        if (resultIsOk(data)) {
          toast.success("Codex runner verification ok");
        } else {
          toast.error(resultMessage(data, "Codex runner verification failed"));
        }
      },
      onError: (err) => toast.error(err.message || "Codex runner trigger failed"),
    });
  }

  function handleRunClaude() {
    $runClaude.mutate(undefined, {
      onSuccess: (data) => {
        if (resultIsOk(data)) {
          toast.success("Claude runner verification ok");
        } else {
          toast.error(resultMessage(data, "Claude runner verification failed"));
        }
      },
      onError: (err) => toast.error(err.message || "Claude runner trigger failed"),
    });
  }
</script>

<Card class="flex flex-col">
  <CardHeader class="flex flex-row items-start justify-between gap-3 space-y-0">
    <div class="min-w-0">
      <CardTitle>Runner state</CardTitle>
      <CardDescription>
        {#if runner?.url}
          <span class="font-mono text-xs break-all">{runner.url}</span>
        {:else}
          Verification sidecar status
        {/if}
      </CardDescription>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <Badge variant={sharedVariant}>{sharedLabel}</Badge>
    </div>
  </CardHeader>
  <CardContent class="flex flex-1 flex-col gap-4">
    {#if $state.isPending}
      <div class="space-y-3">
        <Skeleton class="h-3 w-1/3" />
        <Skeleton class="h-3 w-2/3" />
        <Skeleton class="h-10 w-full" />
      </div>
    {:else if $state.isError && !runner}
      <Alert variant="destructive">
        <AlertTriangle class="h-4 w-4" />
        <AlertTitle>Could not load runner state</AlertTitle>
        <AlertDescription>{$state.error?.message ?? "Unknown error"}</AlertDescription>
      </Alert>
    {:else if !runner}
      <div class="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
        No runner status reported.
      </div>
    {:else}
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt class="text-muted-foreground">Detail</dt>
        <dd class="min-w-0 break-words">{runner.detail || "—"}</dd>
      </dl>

      <div class="grid gap-3 md:grid-cols-2">
        {#each engineRows as row (row.engine)}
          <div class="rounded-md border bg-muted/20 p-3">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="text-sm font-medium">{row.label}</div>
                <div class="mt-1 text-xs text-muted-foreground">
                  <span title={titleTime(row.lastRun)}>{lastLine(row)}</span>
                  {#if successLine(row)}
                    <span class="mx-1">·</span>
                    <span title={titleTime(row.lastOk)}>{successLine(row)}</span>
                  {/if}
                  {#if failureLine(row)}
                    <span class="mx-1">·</span>
                    <span title={titleTime(row.lastFail)}>{failureLine(row)}</span>
                  {/if}
                </div>
              </div>
              <Badge variant={row.variant} class="shrink-0">
                {#if row.token === "running"}
                  <Loader2 class="mr-1 h-3 w-3 animate-spin" />
                {/if}
                {tokenLabel(row.token)}
              </Badge>
            </div>

            {#if row.lastError}
              <div class="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
                {truncate(row.lastError)}
              </div>
            {/if}

            <Button
              class="mt-3 w-full justify-center"
              size="sm"
              variant={row.engine === "codex" ? "default" : "outline"}
              onclick={actionFor(row.engine)}
              disabled={actionDisabled(row)}
            >
              {#if pending(row.engine)}
                <Loader2 class="h-4 w-4 animate-spin" />
              {:else if row.engine === "codex"}
                <PlayCircle class="h-4 w-4" />
              {:else}
                <ShieldCheck class="h-4 w-4" />
              {/if}
              <span>{row.actionLabel}</span>
            </Button>
          </div>
        {/each}
      </div>
    {/if}
  </CardContent>
</Card>
