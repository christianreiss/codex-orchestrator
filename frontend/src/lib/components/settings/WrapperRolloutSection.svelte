<script lang="ts">
  import { toast } from "svelte-sonner";
  import SectionCard from "./SectionCard.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import {
    wrapperRolloutActionMutation,
    wrapperRolloutQuery,
    type RolloutAction,
    type RolloutStatus,
  } from "$lib/api/wrapper-rollout";

  type Props = { headingLevel?: 2 | 3 };
  let { headingLevel = 3 }: Props = $props();

  const query = wrapperRolloutQuery();
  const action = wrapperRolloutActionMutation();

  const rollout = $derived($query.data?.rollout ?? null);
  const live = $derived(rollout?.status === "active" || rollout?.status === "halted");
  const canaries = $derived(($query.data?.hosts ?? []).filter((h) => h.canary && !h.excluded).length);
  const eligible = $derived(($query.data?.hosts ?? []).filter((h) => !h.excluded).length);

  const STATUS_VARIANT: Record<RolloutStatus, "success" | "warning" | "info" | "secondary"> = {
    active: "info",
    halted: "warning",
    complete: "success",
    cancelled: "secondary",
  };

  const LABEL: Record<RolloutAction, string> = {
    halt: "Rollout halted",
    resume: "Rollout resumed",
    promote: "Moved to the next stage",
    complete: "Released to every host",
  };

  async function run(kind: RolloutAction) {
    try {
      await $action.mutateAsync({ action: kind });
      toast.success(LABEL[kind]);
    } catch (error) {
      toast.error((error as Error).message);
    }
  }

  function time(value: string | null): string {
    return value ? new Date(value).toLocaleString() : "—";
  }

  const description = $derived(
    $query.data?.enabled
      ? `A new cxx release goes to canary hosts first, then ${$query.data.settings.stages.filter((s) => s !== "canary").join(" → ")}. Each stage soaks ${$query.data.settings.soak_minutes} min and needs one host on the new build before the next begins. Busy hosts apply when their agents are idle; that delay never blocks a stage.`
      : "Off: every host is offered the newest cxx release at once. Set CXX_WRAPPER_ROLLOUT_ENABLED=true on the API to stage releases.",
  );
</script>

<SectionCard id="wrapper-rollout" title="cxx rollout" {description} {headingLevel}>
  {#if $query.isPending}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $query.isError}
    <p class="text-sm text-destructive">{$query.error.message}</p>
  {:else if $query.data}
    <p class="text-xs text-muted-foreground">
      {canaries} canary {canaries === 1 ? "host" : "hosts"} of {eligible} eligible. Mark canaries on a host's page.
    </p>
    {#if rollout}
      <div class="mt-3 space-y-3 rounded-md border p-3 text-sm">
        <div class="flex flex-wrap items-center gap-2">
          <Badge variant={STATUS_VARIANT[rollout.status]}>{rollout.status}</Badge>
          <span class="font-mono">{rollout.from_version} → {rollout.target_version}</span>
          {#if live}
            <span class="text-muted-foreground">stage <strong>{rollout.stage}</strong>{rollout.next_stage ? `, next ${rollout.next_stage}` : ""}</span>
          {/if}
        </div>
        {#if live}
          <dl class="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
            <div><dt class="text-muted-foreground">Admitted hosts</dt><dd>{rollout.admitted_host_ids.length} of {eligible}</dd></div>
            <div><dt class="text-muted-foreground">Running the new build</dt><dd>{rollout.confirmed_host_ids.length}</dd></div>
            <div><dt class="text-muted-foreground">Soak ends</dt><dd>{rollout.status === "active" ? time(rollout.soak_ends_at) : "paused"}</dd></div>
          </dl>
        {/if}
        {#if rollout.halted_reason}
          <p class="text-xs text-warning-muted-foreground">{rollout.halted_reason}</p>
        {/if}
        {#if live}
          <div class="flex flex-wrap gap-2">
            {#if rollout.status === "active"}
              <Button size="sm" variant="outline" disabled={$action.isPending} onclick={() => run("halt")}>Halt</Button>
            {:else}
              <Button size="sm" variant="outline" disabled={$action.isPending} onclick={() => run("resume")}>Resume</Button>
            {/if}
            <Button size="sm" variant="outline" disabled={$action.isPending} onclick={() => run("promote")}>
              {rollout.next_stage ? `Promote to ${rollout.next_stage}` : "Finish"}
            </Button>
            <Button size="sm" variant="outline" disabled={$action.isPending} onclick={() => run("complete")}>Release to all</Button>
          </div>
          <p class="text-xs text-muted-foreground">Halting stops further waves. Hosts that already updated keep the new build; a rollback is a manifest revert.</p>
        {/if}
      </div>
    {:else}
      <p class="mt-2 text-sm text-muted-foreground">No rollout recorded yet. The next deploy that publishes a newer cxx starts one.</p>
    {/if}
  {/if}
</SectionCard>
