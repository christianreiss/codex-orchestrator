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
  import { cn } from "$lib/utils/cn";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { Alert, AlertTitle, AlertDescription } from "$lib/components/ui/alert";
  import Loader2 from "@lucide/svelte/icons/loader-2";
  import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
  import PlayCircle from "@lucide/svelte/icons/play-circle";
  import {
    createRunnerStateQuery,
    createRunCodexRunnerMutation,
    createRunClaudeRunnerMutation,
    type RunnerEngineStatus,
    type RunnerStatus,
  } from "$lib/api/runner";
  import { toast } from "svelte-sonner";

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
    token: string;
    variant: BadgeVariant;
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
    buildEngineRow("codex", "Codex"),
    buildEngineRow("claude", "Claude"),
  ]);

  // Note: the backend only ever persists `state: 'idle' | 'ok' | 'fail'` for
  // runner engines (see `RunnerProxyService.run`), so `row.token === "running"`
  // never actually occurs — /admin/runner/run(-claude) are synchronous calls
  // that resolve only once the sidecar verification finishes. Gate on the
  // client-side mutation pending flags instead so triggering one engine's
  // verification also disables the other engine's button while in flight.
  const anyEngineRunning = $derived(pending("codex") || pending("claude"));

  function buildEngineRow(engine: EngineKey, label: string): EngineRow {
    const status = engineStatus(engine);
    const token = engineToken(status);
    return {
      engine,
      label,
      actionLabel: "Run verification",
      token,
      variant: badgeVariant(token),
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

  const ACCENT_EDGE: Record<EngineKey, string> = {
    codex: "bg-persona-codex",
    claude: "bg-persona-claude",
  };

  function pending(engine: EngineKey): boolean {
    return engine === "codex" ? $runCodex.isPending : $runClaude.isPending;
  }

  function actionFor(engine: EngineKey) {
    return engine === "codex" ? handleRunCodex : handleRunClaude;
  }

  function actionDisabled(row: EngineRow): boolean {
    return pending(row.engine) || anyEngineRunning || !runner?.ready;
  }

  function tokenLabel(token: string): string {
    if (token === "unconfigured") return "not configured";
    return token === "ok" ? "OK" : token;
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
      {#if $state.isError && runner}
        <Badge variant="warning" title={$state.error?.message ?? "Runner status may be stale"}>
          <AlertTriangle class="mr-1 h-3 w-3" />
          stale
        </Badge>
      {/if}
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
          <div class="relative overflow-hidden rounded-md border bg-muted/20 p-3">
            <span
              class={cn("absolute inset-y-0 left-0 w-0.5", ACCENT_EDGE[row.engine])}
              aria-hidden="true"
            ></span>
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="text-sm font-medium">{row.label}</div>
              </div>
              <Badge variant={row.variant} class="shrink-0">
                {#if row.token === "running"}
                  <Loader2 class="mr-1 h-3 w-3 animate-spin" />
                {/if}
                {tokenLabel(row.token)}
              </Badge>
            </div>

            <Button
              class="mt-3 w-full justify-center"
              size="sm"
              variant="outline"
              onclick={actionFor(row.engine)}
              disabled={actionDisabled(row)}
              aria-label={`Run ${row.label} runner verification`}
            >
              {#if pending(row.engine)}
                <Loader2 class="h-4 w-4 animate-spin" />
              {:else}
                <PlayCircle class="h-4 w-4" />
              {/if}
              <span>{row.actionLabel}</span>
            </Button>
          </div>
        {/each}
      </div>
    {/if}
  </CardContent>
</Card>
