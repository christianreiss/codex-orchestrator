<script lang="ts">
  /**
   * Module settings behind the gear on the Projects page. The coordination
   * switch lives in the page header; this holds the board switch, which grants
   * agents something coordination alone does not: claiming a card so every
   * other agent sees it held.
   */
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import * as Sheet from "$lib/components/ui/sheet";
  import { Switch } from "$lib/components/ui/switch";
  import { ApiError } from "$lib/api/client";
  import { fetchBoardState, projectKeys, setBoardEnabled } from "$lib/api/projects";

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
          {enabled
            ? `Enabled. Agents can claim, move and release cards${summary}.`
            : "Disabled. The board's agent tools are unavailable and its page is read-only. Todos keep working either way; they are a view of the same cards."}
        </p>
      </div>
      <Switch
        id="project-board-enabled"
        checked={enabled}
        disabled={$boardState.isLoading || $boardMutation.isPending}
        onCheckedChange={(next) => $boardMutation.mutate(next)}
      />
    </div>
  </Sheet.Content>
</Sheet.Root>
