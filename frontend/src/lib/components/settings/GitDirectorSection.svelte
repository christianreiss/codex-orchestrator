<script lang="ts">
  import { toast } from "svelte-sonner";
  import { authStore } from "$lib/stores/auth";
  import { gitDirectorStateMutation, gitDirectorStateQuery } from "$lib/api/gitDirector";
  import SectionCard from "./SectionCard.svelte";
  import SwitchRow from "./SwitchRow.svelte";

  const query = gitDirectorStateQuery();
  let lastSavedAt = $state<Date | null>(null);

  const mutation = gitDirectorStateMutation({
    onSuccess: (data) => {
      lastSavedAt = new Date();
      toast.success(
        data.enabled
          ? "Git Director enabled; hosts pick up the new instructions on their next launch"
          : "Git Director disabled; registrations are kept, but the git_* tools stop serving",
      );
    },
    onError: (error) => toast.error(error.message),
  });

  const data = $derived($query.data);
  const canMutate = $derived($authStore.can("git_director.manage"));
  const status = $derived.by(() => {
    if ($mutation.isPending) return "saving" as const;
    if ($mutation.isError) return "error" as const;
    if ($mutation.isSuccess) return "saved" as const;
    return "idle" as const;
  });
</script>

<SectionCard
  id="git-director"
  title="Service state"
  description="A registry of which agent is working in which git clone, plus an advisory arbiter over merges into shared branches. The initial default is off."
  {status}
  savedAt={lastSavedAt}
  error={$mutation.error?.message}
>
  <SwitchRow
    id="git-director-toggle"
    label="Enable the Git Director"
    description={$query.isPending
      ? "Loading current state…"
      : data?.enabled
        ? `${data.clones} clones · ${data.worktrees} live worktrees · verdicts judged by ${data.model}`
        : "Registration, discovery, and merge arbitration are disabled."}
    checked={data?.enabled ?? false}
    disabled={!canMutate || $query.isPending || $mutation.isPending}
    onCheckedChange={(next) => $mutation.mutate(next)}
  />

  <p class="text-xs text-muted-foreground">
    Enabling adds a Git Director section to every active host's AGENTS.md / CLAUDE.md, replacing the
    whole file on their next wrapper launch. Disabling stops the <code>git_*</code> tools from serving
    but keeps existing registrations, so turning it back on does not lose the picture.
  </p>

  <p class="text-xs text-muted-foreground">
    Advisory only — the orchestrator has no filesystem access to any host, so every git fact is
    reported by the calling agent and nothing prevents a merge. Uncontended requests are answered
    deterministically without a model; contended ones fall back to a deterministic <em>wait</em>
    whenever no arbiter is reachable, so an inference outage never blocks a merge.
  </p>
</SectionCard>
