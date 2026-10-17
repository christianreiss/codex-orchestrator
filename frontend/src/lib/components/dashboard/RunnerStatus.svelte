<script lang="ts">
  /**
   * The verification runner (the sidecar that checks provider logins before
   * they are stored), one row per engine, each with a manual "Run verification".
   *
   * The backend emits no WebSocket events for runner state; the query polls
   * every 15 s and a manual run invalidates it.
   */
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { StateBlock } from "$lib/components/page";
  import Loader2 from "@lucide/svelte/icons/loader-circle";
  import PlayCircle from "@lucide/svelte/icons/circle-play";
  import {
    createRunnerStateQuery,
    createRunCodexRunnerMutation,
    createRunClaudeRunnerMutation,
    createRunGrokRunnerMutation,
    type RunnerEngineStatus,
    type RunnerRunResult,
    type RunnerStatus,
  } from "$lib/api/runner";
  import { ENGINES, ENGINE_META, type Engine } from "$lib/constants/engines";
  import { relativeTime } from "$lib/utils/format";
  import { useFleetEngines, fleetDisabledTitle } from "$lib/engines/fleet-engines";
  import { cn } from "$lib/utils/cn";

  type BadgeVariant = "success" | "destructive" | "secondary";

  const state = createRunnerStateQuery();
  const runCodex = createRunCodexRunnerMutation();
  const runClaude = createRunClaudeRunnerMutation();
  const runGrok = createRunGrokRunnerMutation();
  // The server refuses runner verification for a fleet-disabled engine (409).
  const fleet = useFleetEngines();

  const runner = $derived<RunnerStatus | null>($state.data?.runner ?? null);
  const anyRunning = $derived(ENGINES.some((engine) => pending(engine)));

  const overall = $derived.by<{ label: string; variant: BadgeVariant }>(() => {
    if (!runner) return { label: "idle", variant: "secondary" };
    if (!runner.configured) return { label: "not configured", variant: "destructive" };
    return runner.ready ? { label: "ready", variant: "success" } : { label: "fail", variant: "destructive" };
  });

  function mutationFor(engine: Engine) {
    return engine === "codex" ? $runCodex : engine === "claude" ? $runClaude : $runGrok;
  }
  const pending = (engine: Engine): boolean => mutationFor(engine).isPending;

  function statusOf(engine: Engine): RunnerEngineStatus | null {
    const direct = runner?.engines?.[engine];
    if (direct) return direct;
    const legacy = runner?.last_result;
    if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
      const candidate = legacy[engine];
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate as RunnerEngineStatus;
    }
    return null;
  }

  function tokenFor(engine: Engine): string {
    if (pending(engine)) return "running";
    if (!$fleet.isEnabled(engine)) return "disabled";
    if (!runner) return "idle";
    if (!runner.configured) return "unconfigured";
    const raw = (statusOf(engine)?.state ?? "").toLowerCase();
    if (raw === "running" || raw === "ok" || raw === "fail" || raw === "idle") return raw;
    return runner.ready ? "idle" : "fail";
  }

  const TOKENS: Record<string, { label: string; variant: BadgeVariant }> = {
    ok: { label: "OK", variant: "success" },
    fail: { label: "fail", variant: "destructive" },
    unconfigured: { label: "not configured", variant: "destructive" },
    running: { label: "running", variant: "secondary" },
    disabled: { label: "disabled fleet-wide", variant: "secondary" },
    idle: { label: "not checked", variant: "secondary" },
  };

  function run(engine: Engine) {
    const label = ENGINE_META[engine].label;
    mutationFor(engine).mutate(undefined, {
      onSuccess: (data: RunnerRunResult) =>
        data.status === "ok"
          ? toast.success(`${label} runner verification ok`)
          : toast.error(data.reason || data.detail || `${label} runner verification failed`),
      onError: (err: Error) => toast.error(err.message || `${label} runner trigger failed`),
    });
  }

  const disabledRun = (engine: Engine) =>
    anyRunning || !runner?.ready || $state.isError || $state.isPending || !$fleet.isEnabled(engine);
</script>

{#if $state.isPending}
  <StateBlock state="loading" rows={3} />
{:else if $state.isError && !runner}
  <StateBlock state="error" message={`Could not load runner state: ${$state.error?.message ?? "unknown error"}`} onRetry={() => $state.refetch()} />
{:else if !runner}
  <StateBlock state="empty" message="No runner status reported" />
{:else}
  <div class="rounded-md border">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2">
      <Badge variant={overall.variant}>{overall.label}</Badge>
      {#if $state.isError}
        <Badge variant="warning" title={$state.error?.message ?? "Runner status may be stale"}>stale</Badge>
      {/if}
      <span class="min-w-0 flex-1 truncate text-body-sm text-muted-foreground" title={runner.url ?? runner.detail}>
        {runner.detail || runner.url || "Verification sidecar"}
      </span>
      {#if $state.isError}
        <Button size="sm" variant="outline" onclick={() => $state.refetch()} disabled={$state.isFetching}>Retry runner state</Button>
      {/if}
    </div>
    <ul class="divide-y" aria-label="Verification by engine">
      {#each ENGINES as engine (engine)}
        {@const status = statusOf(engine)}
        {@const token = tokenFor(engine)}
        {@const view = TOKENS[token]}
        {@const expiry = engine === "claude" ? status?.login_expiry : undefined}
        <li class={cn("flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2", token === "disabled" && "opacity-70")}>
          <span class="flex w-24 items-center gap-2 font-medium">
            <span class="h-2 w-2 rounded-full {ENGINE_META[engine].color}" aria-hidden="true"></span>{ENGINE_META[engine].label}
          </span>
          <Badge variant={view.variant}>
            {#if token === "running"}<Loader2 class="mr-1 h-3 w-3 animate-spin" />{/if}{view.label}
          </Badge>
          <span class="min-w-0 flex-1 text-body-sm text-muted-foreground">
            Last check
            <span title={status?.last_check ?? status?.last_run ?? undefined}>{status?.last_check || status?.last_run ? relativeTime(status.last_check ?? status.last_run) : "none recorded"}</span>
            · last success
            <span title={status?.last_ok ?? undefined}>{status?.last_ok ? relativeTime(status.last_ok) : "none recorded"}</span>
          </span>
          <Button
            size="sm"
            variant="outline"
            onclick={() => run(engine)}
            disabled={disabledRun(engine)}
            title={token === "disabled" ? fleetDisabledTitle(ENGINE_META[engine].label) : undefined}
            aria-label={`Run ${ENGINE_META[engine].label} runner verification`}
          >
            {#if pending(engine)}<Loader2 class="h-4 w-4 animate-spin" />{:else}<PlayCircle class="h-4 w-4" />{/if}
            {pending(engine) ? "Verifying…" : "Run verification"}
          </Button>
          {#if status?.last_error && token === "fail"}
            <p class="w-full break-words text-body-sm text-destructive">{status.last_error}</p>
          {/if}
          {#if expiry?.state === "expired" || expiry?.state === "expiring"}
            <p class={cn("w-full text-body-sm", expiry.state === "expired" ? "text-destructive" : "text-warning")}>
              {expiry.state === "expired" ? "Claude login expired" : `Claude login expires in ${expiry.days_remaining} ${expiry.days_remaining === 1 ? "day" : "days"}`}
              {#if expiry.expires_at}(<time datetime={expiry.expires_at}>{expiry.expires_at}</time>){/if}.
              Run <code>/login</code> in Claude launched through <code>clx</code>.
            </p>
          {:else if expiry?.state === "unknown"}
            <p class="w-full text-body-sm text-muted-foreground">Claude login expiry unknown.</p>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{/if}
