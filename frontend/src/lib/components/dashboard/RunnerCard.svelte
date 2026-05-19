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
    type RunnerStatus,
  } from "$lib/api/runner";
  import { toast } from "svelte-sonner";
  import { relativeTime } from "$lib/utils/format";

  const state = createRunnerStateQuery();
  const runCodex = createRunCodexRunnerMutation();
  const runClaude = createRunClaudeRunnerMutation();

  const runner = $derived<RunnerStatus | null>($state.data?.runner ?? null);

  /** Normalised state token: "idle" | "running" | "ok" | "fail" | "unconfigured". */
  const stateToken = $derived.by<string>(() => {
    if (!runner) return "idle";
    if (!runner.configured) return "unconfigured";
    const raw = (runner.state ?? "").toLowerCase();
    if (raw === "running" || raw === "ok" || raw === "fail" || raw === "idle") {
      return raw;
    }
    // No legacy state field — derive a coarse signal from the proxy probe.
    return runner.ready ? "idle" : "fail";
  });

  const isRunning = $derived(stateToken === "running");

  type BadgeVariant = "default" | "secondary" | "success" | "warning" | "destructive";
  const stateVariant = $derived<BadgeVariant>(
    stateToken === "ok"
      ? "success"
      : stateToken === "running"
        ? "secondary"
        : stateToken === "fail" || stateToken === "unconfigured"
          ? "destructive"
          : "secondary",
  );

  const stateLabel = $derived(
    stateToken === "unconfigured" ? "not configured" : stateToken,
  );

  const lastResultPreview = $derived.by<string | null>(() => {
    const lr = runner?.last_result;
    if (lr === null || lr === undefined) return null;
    if (typeof lr === "string") return lr;
    try {
      return JSON.stringify(lr);
    } catch {
      return null;
    }
  });

  function truncate(value: string, max = 240): string {
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  function handleRunCodex() {
    $runCodex.mutate(undefined, {
      onSuccess: (data) => {
        if (data.status === "ok") {
          toast.success("Codex runner verification ok");
        } else {
          toast.error(
            data.reason || data.detail || "Codex runner verification failed",
          );
        }
      },
      onError: (err) => toast.error(err.message || "Codex runner trigger failed"),
    });
  }

  function handleRunClaude() {
    $runClaude.mutate(undefined, {
      onSuccess: (data) => {
        if (data.status === "ok") {
          toast.success("Claude runner verification ok");
        } else {
          toast.error(
            data.reason || data.detail || "Claude runner verification failed",
          );
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
      {#if isRunning}
        <Badge variant={stateVariant} class="inline-flex items-center gap-1">
          <Loader2 class="h-3 w-3 animate-spin" />
          running
        </Badge>
      {:else}
        <Badge variant={stateVariant}>{stateLabel}</Badge>
      {/if}
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

        <dt class="text-muted-foreground">Last run</dt>
        <dd class="min-w-0">
          {#if runner.last_run}
            <span title={runner.last_run}>{relativeTime(runner.last_run)}</span>
          {:else}
            <span class="text-muted-foreground">never</span>
          {/if}
        </dd>
      </dl>

      {#if runner.last_error}
        <Alert variant="destructive">
          <AlertTriangle class="h-4 w-4" />
          <AlertTitle>Last error</AlertTitle>
          <AlertDescription class="break-words">
            {truncate(runner.last_error)}
          </AlertDescription>
        </Alert>
      {/if}

      {#if lastResultPreview}
        <div class="rounded-md border bg-muted/30 p-3 text-xs">
          <div class="mb-1 text-muted-foreground">Last result</div>
          <pre class="whitespace-pre-wrap break-words font-mono">{truncate(
              lastResultPreview,
            )}</pre>
        </div>
      {/if}
    {/if}

    <div class="mt-auto flex flex-wrap gap-2 pt-2">
      <Button
        size="sm"
        onclick={handleRunCodex}
        disabled={$runCodex.isPending || isRunning}
      >
        {#if $runCodex.isPending}
          <Loader2 class="h-4 w-4 animate-spin" />
        {:else}
          <PlayCircle class="h-4 w-4" />
        {/if}
        <span>Run Codex runner</span>
      </Button>
      <Button
        size="sm"
        variant="outline"
        onclick={handleRunClaude}
        disabled={$runClaude.isPending || isRunning}
      >
        {#if $runClaude.isPending}
          <Loader2 class="h-4 w-4 animate-spin" />
        {:else}
          <ShieldCheck class="h-4 w-4" />
        {/if}
        <span>Verify Claude</span>
      </Button>
    </div>
  </CardContent>
</Card>
