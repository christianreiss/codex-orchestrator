<script lang="ts">
  import ModuleOffNotice from "$lib/components/feedback/ModuleOffNotice.svelte";
  import type { Snapshot } from "./$types";
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import GitMerge from "@lucide/svelte/icons/git-merge";
  import { DataTable, ListDetail, PageShell, StatStrip, Toolbar } from "$lib/components/page";
  import SegmentedControl from "$lib/components/page/SegmentedControl.svelte";
  import GitCommitSettingsSection from "$lib/components/settings/GitCommitSettingsSection.svelte";
  import GitDetail from "$lib/components/git-director/GitDetail.svelte";
  import { buildGitRows, parseGitView, repoName, selectionTitle, staleLabel, verdictVariant, type GitSelection, type GitView } from "$lib/components/git-director/git-rows";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Table from "$lib/components/ui/table";
  import { authStore } from "$lib/stores/auth";
  import {
    gitDirectorClonesQuery,
    gitDirectorDecideMutation,
    gitDirectorEvictMutation,
    gitDirectorKeys,
    gitDirectorStateMutation,
    gitDirectorStateQuery,
  } from "$lib/api/gitDirector";

  const stateQuery = gitDirectorStateQuery();
  const clones = gitDirectorClonesQuery();
  const client = useQueryClient();
  const canMutate = $derived($authStore.can("git_director.manage"));

  const view = $derived<GitView>(parseGitView(page.url.searchParams.get("view"), page.url.searchParams.get("tab")));
  function setView(next: string) {
    const url = new URL(page.url);
    url.searchParams.delete("tab");
    url.searchParams.set("view", next);
    void goto(url, { keepFocus: true, noScroll: true });
  }

  let search = $state("");
  let open = $state(false);
  let selection = $state<GitSelection | null>(null);
  const cloneRows = $derived($clones.data?.clones ?? []);
  const rows = $derived($clones.data ? buildGitRows(cloneRows, view, search) : undefined);
  const chosen = $derived(cloneRows.find((c) => c.clone_id === selection?.cloneId));
  const heading = $derived(selectionTitle(chosen, selection));
  const mergeCount = $derived(cloneRows.reduce((n, c) => n + c.leases.length, 0));
  const worktreeCount = $derived(cloneRows.reduce((n, c) => n + c.worktrees.length, 0));
  const stats = $derived([
    { label: "open merge requests", value: mergeCount, tone: mergeCount > 0 ? ("warning" as const) : ("default" as const) },
    { label: "active worktrees", value: worktreeCount },
    { label: "clones", value: cloneRows.length },
  ]);

  const toggleMutation = gitDirectorStateMutation({
    onSuccess: (data) =>
      toast.success(data.enabled ? "Git merges enabled; hosts pick up the new instructions on their next launch" : "Git merges disabled; registrations are kept, but the git_* tools stop serving"),
    onError: (error) => toast.error(error.message),
  });
  const decide = gitDirectorDecideMutation({ onSuccess: () => { open = false; toast.success("Decision saved"); }, onError: (e) => toast.error(e.message) });
  const evict = gitDirectorEvictMutation({ onSuccess: () => { open = false; toast.success("Registration released"); }, onError: (e) => toast.error(e.message) });

  function show(row: { clone: { clone_id: string }; kind: GitSelection["kind"]; id: string }) {
    selection = { cloneId: row.clone.clone_id, kind: row.kind, id: row.id };
    open = true;
  }
  const emptyTitle = $derived(view === "worktrees" ? "No active worktrees" : view === "merges" ? "No open merge requests" : "No history yet");
  const status = $derived($stateQuery.data);
  export const snapshot: Snapshot<{ search: typeof search }> = {
    capture: () => ({ search }),
    restore: (value) => { search = value.search; },
  };
</script>

{#snippet tabs()}
  <SegmentedControl
    label="Git merges view"
    value={view}
    onChange={setView}
    options={[
      { value: "merges", label: "Merge requests", hint: "Current leases and waiting requests" },
      { value: "worktrees", label: "Worktrees", hint: "Active worktrees" },
      { value: "history", label: "History", hint: "Past decisions and released registrations" },
      { value: "settings", label: "Settings", hint: "How agents write commit messages" },
    ]}
  />
{/snippet}

<PageShell
  title="Git merges"
  description="Merge requests from agents sharing a repository, and the worktrees they work in (git director)."
  toggle={{
    label: "Enable git merges",
    checked: status?.enabled ?? false,
    disabled: !canMutate || $stateQuery.isPending || !status || $toggleMutation.isPending,
    onChange: (next) => $toggleMutation.mutate(next),
  }}
>
  {#snippet actions()}
    <Button variant="outline" size="sm" onclick={() => { void client.invalidateQueries({ queryKey: gitDirectorKeys.all }); void client.invalidateQueries({ queryKey: ["settings", "git-commit"] }); }}>
      <RefreshCw class="h-4 w-4" /> Refresh
    </Button>
  {/snippet}

  {#if status && !status.enabled}
    <ModuleOffNotice>Git merges are off: registration, discovery and merge arbitration are disabled. Existing registrations are kept.</ModuleOffNotice>
  {/if}


  {#if view === "settings"}
    {@render tabs()}
    <GitCommitSettingsSection />
  {:else}
  {#if $clones.data}<StatStrip items={stats} />{/if}

  <Toolbar bind:search searchPlaceholder="Search repository, host, user, task or branch…">
    {#snippet filters()}{@render tabs()}{/snippet}
  </Toolbar>

  <ListDetail bind:open title={heading.title} description={heading.subtitle}>
    {#snippet list()}
      <DataTable
        items={rows}
        loading={$clones.isPending}
        error={$clones.error?.message ?? null}
        onRetry={() => $clones.refetch()}
        key={(row) => `${row.kind}:${row.id}`}
        {emptyTitle}
        emptyIcon={GitMerge}
        filtered={search.trim() !== ""}
      onClearFilters={() => { search = ""; }}
        caption="Git merges"
      >
        {#snippet head()}
          <Table.Head>{view === "worktrees" ? "Worktree" : view === "merges" ? "Request" : "Entry"}</Table.Head>
          <Table.Head>Branch</Table.Head>
          <Table.Head>Repository</Table.Head>
          <Table.Head>When</Table.Head>
        {/snippet}
        {#snippet row(item)}
          <!-- The first-cell button stays the keyboard path; a click anywhere else on the row opens the same detail. -->
          <Table.Row class="cursor-pointer" onclick={(event: MouseEvent) => { if (!(event.target as HTMLElement).closest("a,button")) show(item); }}>
            <Table.Cell class="max-w-[28rem]">
              <button type="button" class="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onclick={() => show(item)}>
                {#if item.kind === "worktree"}
                  <span class="block font-medium">{item.worktree.username}{item.worktree.engine ? ` · ${item.worktree.engine}` : ""}</span>
                  <span class="line-clamp-2 break-words text-body-sm text-muted-foreground" title={item.worktree.task ?? undefined}>{item.worktree.task ?? "No task declared"}</span>
                {:else if item.kind === "lease"}
                  <span class="flex items-center gap-2"><Badge variant={verdictVariant(item.lease.verdict)}>{item.lease.verdict}</Badge> <span class="font-medium">{item.lease.target_branch}</span></span>
                  <span class="line-clamp-2 break-words text-body-sm text-muted-foreground" title={item.lease.reason ?? undefined}>{item.lease.reason ?? "No reason recorded"}</span>
                {:else if item.kind === "recent"}
                  <span class="flex items-center gap-2"><Badge variant={verdictVariant(item.request.verdict)}>{item.request.verdict}</Badge> <span class="font-medium">{item.request.target_branch}</span></span>
                  <span class="line-clamp-2 break-words text-body-sm text-muted-foreground" title={item.request.reason ?? undefined}>{item.request.reason ?? "No reason recorded"}</span>
                {:else}
                  <span class="flex items-center gap-2"><Badge variant="secondary">{staleLabel(item.stale.status)}</Badge> <span class="font-medium">{item.stale.username} · {item.stale.task ?? repoName(item.stale.worktree_path)}</span></span>
                {/if}
              </button>
            </Table.Cell>
            <Table.Cell class="whitespace-nowrap text-body-sm">
              {#if item.kind === "worktree"}{item.worktree.branch ?? "Detached"}{item.worktree.target_branch ? ` → ${item.worktree.target_branch}` : ""}
              {:else if item.kind === "stale"}{item.stale.branch ?? "Detached"}
              {:else}<span class="text-muted-foreground" title="The target branch is shown in the first column">–</span>{/if}
            </Table.Cell>
            <Table.Cell class="max-w-[16rem]">
              <span class="block truncate font-medium">{repoName(item.clone.repo_root)}</span>
              <span class="block truncate text-caption text-muted-foreground" title={item.clone.repo_root}>{item.clone.fqdn ?? `Host ${item.clone.host_id}`}</span>
            </Table.Cell>
            <Table.Cell class="whitespace-nowrap text-body-sm text-muted-foreground">
              {#if item.kind === "worktree"}<Timestamp value={item.worktree.heartbeat_at} />
              {:else if item.kind === "stale"}<Timestamp value={item.stale.last_seen_at} />
              {:else if item.kind === "lease"}<Timestamp value={item.lease.requested_at} />
              {:else}<Timestamp value={item.request.requested_at} />{/if}
            </Table.Cell>
          </Table.Row>
        {/snippet}
      </DataTable>
    {/snippet}
    {#snippet detail()}
      <GitDetail
        clone={chosen}
        {selection}
        {canMutate}
        busy={$decide.isPending || $evict.isPending}
        onDecide={(id, verdict) => $decide.mutate({ id, verdict })}
        onRelease={(id) => $evict.mutate(id)}
      />
    {/snippet}
  </ListDetail>

  {/if}
</PageShell>
