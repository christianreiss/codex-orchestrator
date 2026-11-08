<script lang="ts">
  /**
   * Module settings behind the gear on the Projects page. The coordination
   * switch lives in the page header; this holds the board switch, which grants
   * agents something coordination alone does not: claiming a card so every
   * other agent sees it held, and the slop-jobs switch for agent UI/UX reviews.
   */
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import * as Sheet from "$lib/components/ui/sheet";
  import { Button } from "$lib/components/ui/button";
  import { Switch } from "$lib/components/ui/switch";
  import { ApiError } from "$lib/api/client";
  import { fetchBoardState, fetchSlopState, projectKeys, setBoardEnabled, setSlopEnabled } from "$lib/api/projects";

  let { open = $bindable() }: { open: boolean } = $props();

  const qc = useQueryClient();
  const boardState = createQuery({ queryKey: projectKeys.boardState, queryFn: fetchBoardState });

  const boardMutation = createMutation({
    mutationFn: (enabled: boolean) => setBoardEnabled(enabled),
    onMutate: async (enabled) => {
      await qc.cancelQueries({ queryKey: projectKeys.boardState });
      const previous = qc.getQueryData(projectKeys.boardState);
      qc.setQueryData(projectKeys.boardState, (prev: unknown) =>
        prev && typeof prev === "object" ? { ...(prev as object), enabled } : { enabled },
      );
      return { previous };
    },
    onError: (err, _v, context) => {
      if (context?.previous !== undefined) qc.setQueryData(projectKeys.boardState, context.previous);
      toast.error(err instanceof ApiError ? err.message : "Could not update the board module");
    },
    onSuccess: () => toast.success("Module state updated"),
    onSettled: () => void qc.invalidateQueries({ queryKey: projectKeys.boardState }),
  });

  const slopState = createQuery({ queryKey: projectKeys.slopState, queryFn: fetchSlopState });
  const slopMutation = createMutation({
    mutationFn: (enabled: boolean) => setSlopEnabled(enabled),
    onMutate: async (enabled) => {
      await qc.cancelQueries({ queryKey: projectKeys.slopState });
      const previous = qc.getQueryData(projectKeys.slopState);
      qc.setQueryData(projectKeys.slopState, (prev: unknown) =>
        prev && typeof prev === "object" ? { ...(prev as object), enabled } : { enabled },
      );
      return { previous };
    },
    onError: (err, _v, context) => {
      if (context?.previous !== undefined) qc.setQueryData(projectKeys.slopState, context.previous);
      toast.error(err instanceof ApiError ? err.message : "Could not update slop jobs");
    },
    onSuccess: () => toast.success("Module state updated"),
    onSettled: () => void qc.invalidateQueries({ queryKey: projectKeys.slopState }),
  });
  const slopEnabled = $derived(($slopState.data?.enabled ?? false) === true);
  const slopJobs = $derived($slopState.data?.jobs ?? 0);

  const enabled = $derived(($boardState.data?.enabled ?? false) === true);
  /** Counts only when there is something to count, so an empty fleet reads cleanly. */
  const summary = $derived.by(() => {
    const cards = $boardState.data?.cards ?? 0;
    const claimed = $boardState.data?.claimed ?? 0;
    if (cards === 0) return "";
    return ` — ${cards} card${cards === 1 ? "" : "s"}, ${claimed} currently held`;
  });
</script>

<Sheet.Root bind:open>
  <Sheet.Content side="right" class="w-full sm:max-w-md">
    <Sheet.Header>
      <Sheet.Title>Project settings</Sheet.Title>
      <Sheet.Description>Modules that apply to every project.</Sheet.Description>
    </Sheet.Header>
    <div class="mt-4 flex items-start justify-between gap-4">
      <div class="min-w-0">
        <label for="project-board-enabled" class="text-body font-medium">Project board</label>
        <p class="mt-0.5 text-body-sm text-muted-foreground">
          {!$boardState.data || $boardState.isError ? "Board module state unavailable. Retry before changing it." : enabled
            ? `Enabled. Agents can claim, move and release cards${summary}.`
            : "Disabled. The board's agent tools are unavailable and its page is read-only. Todos keep working either way; they are a view of the same cards."}
        </p>
      </div>
      <Switch
        id="project-board-enabled"
        checked={enabled}
        disabled={!$boardState.data || $boardState.isError || $boardState.isLoading || $boardMutation.isPending}
        onCheckedChange={(next) => $boardMutation.mutate(next)}
      />
    </div>
    {#if $boardState.isError}<p role="alert" class="text-body-sm text-destructive">{$boardState.error.message}</p><Button size="sm" variant="outline" onclick={() => $boardState.refetch()}>Retry board state</Button>{/if}
    {#if $boardMutation.isError}<p role="alert" class="text-body-sm text-destructive">{$boardMutation.error.message}</p>{/if}
    <div class="mt-6 flex items-start justify-between gap-4">
      <div class="min-w-0">
        <label for="slop-jobs-enabled" class="text-body font-medium">Slop jobs</label>
        <p class="mt-0.5 text-body-sm text-muted-foreground">
          {!$slopState.data || $slopState.isError ? "Slop module state unavailable. Retry before changing it." : slopEnabled
            ? `Enabled. Agents review UI work with the slop_job_* tools and are told to in their instructions${slopJobs ? ` — ${slopJobs} job${slopJobs === 1 ? "" : "s"} open` : ""}.`
            : "Disabled. The slop_job_* tools and their instructions are withheld from agents. Existing jobs stay readable here until they expire."}
        </p>
      </div>
      <Switch
        id="slop-jobs-enabled"
        checked={slopEnabled}
        disabled={!$slopState.data || $slopState.isError || $slopState.isLoading || $slopMutation.isPending}
        onCheckedChange={(next) => $slopMutation.mutate(next)}
      />
    </div>
    {#if $slopState.isError}<p role="alert" class="text-body-sm text-destructive">{$slopState.error.message}</p><Button size="sm" variant="outline" onclick={() => $slopState.refetch()}>Retry slop state</Button>{/if}
    {#if $slopMutation.isError}<p role="alert" class="text-body-sm text-destructive">{$slopMutation.error.message}</p>{/if}
  </Sheet.Content>
</Sheet.Root>
