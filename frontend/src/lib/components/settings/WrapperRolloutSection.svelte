<script lang="ts">
  import { hasFocus, restoreFocus } from "$lib/utils/restore-focus";
  import { formatDateTime } from "$lib/utils/format";
  import { Section, StateBlock } from "$lib/components/page";
  import { authStore } from "$lib/stores/auth";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Switch } from "$lib/components/ui/switch";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import {
    wrapperRolloutActionMutation,
    wrapperRolloutEnabledMutation,
    wrapperRolloutQuery,
    type RolloutAction,
    type RolloutStatus,
  } from "$lib/api/wrapper-rollout";

  const query = wrapperRolloutQuery();
  const action = wrapperRolloutActionMutation();
  const toggle = wrapperRolloutEnabledMutation();

  const canManage = $derived($authStore.can("hosts.manage"));
  const rollout = $derived($query.data?.rollout ?? null);
  const live = $derived(rollout?.status === "active" || rollout?.status === "halted");
  const canaries = $derived(($query.data?.hosts ?? []).filter((h) => h.canary && !h.excluded).length);
  const eligible = $derived(($query.data?.hosts ?? []).filter((h) => !h.excluded).length);
  const busy = $derived($action.isPending || $toggle.isPending);

  const STATUS_VARIANT: Record<RolloutStatus, "success" | "warning" | "info" | "secondary"> = {
    active: "info",
    halted: "warning",
    complete: "success",
    cancelled: "secondary",
  };

  /** What each action does, said before it is done (INT-4: the button names the action). */
  const COPY: Record<RolloutAction, { title: string; body: string; confirm: string; done: string }> = {
    halt: {
      title: "Halt this rollout?",
      body: "No further hosts are admitted until you resume. Hosts that already updated keep the new build.",
      confirm: "Halt rollout",
      done: "Rollout halted.",
    },
    resume: {
      title: "Resume this rollout?",
      body: "The soak timer restarts and the next wave is admitted once the current stage is confirmed.",
      confirm: "Resume rollout",
      done: "Rollout resumed.",
    },
    promote: {
      title: "Move to the next stage now?",
      body: "The soak time and the per-stage confirmation are skipped for the current stage. The next stage's hosts are offered the new build immediately.",
      confirm: "Promote now",
      done: "Moved to the next stage.",
    },
    complete: {
      title: "Release to every host now?",
      body: "All remaining stages are skipped: every eligible host is offered the new host-agent build at once. This cannot be undone from here; a rollback is a manifest revert.",
      confirm: "Release to all hosts",
      done: "Released to every host.",
    },
  };

  let confirmingOff = $state(false);
  let pending = $state<RolloutAction | null>(null);
  let confirming = $state(false);
  let actionError = $state<string | null>(null);
  let actionDone = $state<string | null>(null);
  let toggleError = $state<string | null>(null);
  let toggleDone = $state(false);

  function ask(kind: RolloutAction) {
    actionError = null;
    actionDone = null;
    pending = kind;
    confirming = true;
  }

  async function run() {
    if (!pending) return;
    const kind = pending;
    try {
      await $action.mutateAsync({ action: kind });
      actionDone = COPY[kind].done;
      confirming = false;
    } catch (error) {
      actionError = (error as Error).message;
    }
  }

  async function setEnabled(enabled: boolean) {
    toggleError = null;
    toggleDone = false;
    const refocus = hasFocus("wrapper-rollout-toggle");
    try {
      await $toggle.mutateAsync(enabled);
      toggleDone = true;
    } catch (error) {
      toggleError = (error as Error).message;
    } finally {
      if (refocus) await restoreFocus("wrapper-rollout-toggle");
    }
  }

  function time(value: string | null): string {
    return value ? formatDateTime(value) : "—";
  }
</script>

<Section id="cxx-rollout" title="Host agent rollout" description="Try new host-agent versions early: a few hosts get each new cxx release first, the rest follow in stages.">
  {#if $query.isPending}
    <StateBlock state="loading" rows={2} />
  {:else if $query.isError}
    <StateBlock state="error" cause={$query.error} message="Could not load the rollout." onRetry={() => void $query.refetch()} />
  {:else if $query.data}
    <div id="wrapper-rollout" class="scroll-mt-24 space-y-3">
      <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-y py-3 sm:flex-nowrap">
        <div class="min-w-0 flex-1 space-y-1">
          <label for="wrapper-rollout-toggle" class="text-body font-medium">Stage new releases</label>
          <p id="wrapper-rollout-help" class="text-body-sm text-muted-foreground">
            {#if $query.data.enabled}
              A new release goes to hosts that try new versions early first, then {$query.data.settings.stages.filter((s) => s !== "canary").join(" → ")}. Each stage soaks {$query.data.settings.soak_minutes} min and needs one of its own hosts on the new build before the next begins. Busy hosts apply when their agents are idle; that delay never blocks a stage.
            {:else}
              Off: every host is offered the newest host-agent release at once.
            {/if}
          </p>
          <p class="text-caption text-muted-foreground">
            {$query.data.enabled_source === "env" ? "Using the server default; the first change here is stored and then wins." : "Set here; takes effect on the next host check-in, no restart."}
          </p>
        </div>
        {#key `${$toggle.status}:${$query.data.enabled}`}
          <Switch
            id="wrapper-rollout-toggle"
            checked={$query.data.enabled}
            disabled={!canManage || busy}
            aria-describedby="wrapper-rollout-help wrapper-rollout-toggle-status"
            onCheckedChange={(enabled) => (!enabled && live ? (confirmingOff = true) : void setEnabled(enabled))}
          />
        {/key}
      </div>
      <div id="wrapper-rollout-toggle-status" role="status" aria-live="polite" class="text-body-sm empty:hidden">
        {#if $toggle.isPending}<span class="text-muted-foreground">Saving…</span>
        {:else if toggleError}<span class="text-destructive">Save failed: {toggleError}. The switch shows the server's current value.</span>
        {:else if toggleDone}<span class="text-muted-foreground">Saved</span>{/if}
      </div>
      {#if !canManage}<p class="text-body-sm text-muted-foreground">Read only: changes require <code class="font-mono">hosts.manage</code>.</p>{/if}

      <p class="text-caption text-muted-foreground">
        {canaries} {canaries === 1 ? "host tries" : "hosts try"} new host-agent versions early, of {eligible} eligible. Choose them on a host's page (canary hosts).
      </p>

      {#if rollout}
        <div class="space-y-3 border-y py-3 text-body-sm">
          <div class="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_VARIANT[rollout.status]}>{rollout.status}</Badge>
            <span class="font-mono">{rollout.from_version} → {rollout.target_version}</span>
            {#if live}
              <span class="text-muted-foreground">stage <strong>{rollout.stage}</strong>{rollout.next_stage ? `, next ${rollout.next_stage}` : ""}</span>
            {/if}
          </div>
          {#if live}
            <dl class="grid grid-cols-1 gap-x-6 gap-y-1 text-caption sm:grid-cols-3">
              <div><dt class="text-muted-foreground">Admitted hosts</dt><dd>{rollout.admitted_host_ids.length} of {eligible}</dd></div>
              <div><dt class="text-muted-foreground">Running the new build</dt><dd>{rollout.confirmed_host_ids.length}</dd></div>
              <div><dt class="text-muted-foreground">Soak ends</dt><dd>{rollout.status === "active" ? time(rollout.soak_ends_at) : "paused"}</dd></div>
            </dl>
          {/if}
          {#if rollout.halted_reason}
            <p class="text-caption text-warning-muted-foreground">{rollout.halted_reason}</p>
          {/if}
          {#if live}
            <div class="flex flex-wrap gap-2">
              {#if rollout.status === "active"}
                <Button size="sm" variant="outline" disabled={!canManage || busy} onclick={() => ask("halt")}>Halt</Button>
              {:else}
                <Button size="sm" variant="outline" disabled={!canManage || busy} onclick={() => ask("resume")}>Resume</Button>
              {/if}
              <Button size="sm" variant="outline" disabled={!canManage || busy} onclick={() => ask("promote")}>
                {rollout.next_stage ? `Promote to ${rollout.next_stage}` : "Finish"}
              </Button>
              <Button size="sm" variant="outline" disabled={!canManage || busy} onclick={() => ask("complete")}>Release to all</Button>
            </div>
            <p class="text-caption text-muted-foreground">Halting stops further waves. Hosts that already updated keep the new build; a rollback is a manifest revert.</p>
          {/if}
          <div role="status" aria-live="polite" class="empty:hidden">
            {#if actionDone}<p class="text-body-sm text-muted-foreground">{actionDone}</p>{/if}
          </div>
        </div>
      {:else}
        <p class="text-body-sm text-muted-foreground">No rollout recorded yet. The next deploy that publishes a newer cxx starts one.</p>
      {/if}
    </div>
  {/if}
</Section>

<ConfirmDialog
  bind:open={confirmingOff}
  title="Stop staging new releases?"
  description="A rollout is in progress. With staging off, every host is offered the newest host-agent release at once; the remaining stages and soak times no longer apply."
  confirmLabel="Turn staging off"
  destructive
  busy={$toggle.isPending}
  error={toggleError}
  onConfirm={async () => { await setEnabled(false); if (!toggleError) confirmingOff = false; }}
/>

{#if pending}
  <ConfirmDialog
    bind:open={confirming}
    title={COPY[pending].title}
    description={COPY[pending].body}
    confirmLabel={COPY[pending].confirm}
    busyLabel="Working…"
    destructive={pending === "complete"}
    busy={$action.isPending}
    error={actionError}
    onConfirm={run}
    onClose={() => { pending = null; }}
  />
{/if}
