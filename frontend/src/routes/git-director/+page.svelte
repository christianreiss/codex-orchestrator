<script lang="ts">
  import { useQueryClient } from "@tanstack/svelte-query";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import GitMerge from "@lucide/svelte/icons/git-merge";
  import { toast } from "svelte-sonner";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import GitDirectorSection from "$lib/components/settings/GitDirectorSection.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { authStore } from "$lib/stores/auth";
  import { relativeTime } from "$lib/utils/format";
  import {
    gitDirectorClonesQuery,
    gitDirectorDecideMutation,
    gitDirectorKeys,
    gitDirectorStateQuery,
    type GitCloneRow,
    type GitDecidedBy,
    type GitLeaseRow,
    type GitVerdict,
  } from "$lib/api/gitDirector";

  const state = gitDirectorStateQuery();
  const clones = gitDirectorClonesQuery();
  const client = useQueryClient();
  const canMutate = $derived($authStore.can("git_director.manage"));

  const decide = gitDirectorDecideMutation({
    onSuccess: (row) => toast.success(`Forced ${row.verdict} on ${row.target_branch}`),
    onError: (error) => toast.error(error.message),
  });

  function refresh() {
    void client.invalidateQueries({ queryKey: gitDirectorKeys.all });
  }

  const rows = $derived($clones.data?.clones ?? []);

  /** Grouped by normalized remote so clones of one repository read together. */
  const groups = $derived.by(() => {
    const byRemote = new Map<string, GitCloneRow[]>();
    for (const clone of rows) {
      const key = clone.remote_key ?? `local:${clone.clone_id}`;
      const bucket = byRemote.get(key);
      if (bucket) bucket.push(clone);
      else byRemote.set(key, [clone]);
    }
    return [...byRemote.entries()].map(([key, list]) => ({
      key,
      remote: list[0]?.remote_url ?? null,
      clones: list,
    }));
  });

  function verdictVariant(verdict: GitVerdict) {
    if (verdict === "allow") return "success" as const;
    if (verdict === "wait") return "warning" as const;
    if (verdict === "deny") return "destructive" as const;
    return "secondary" as const;
  }

  function decidedByLabel(by: GitDecidedBy): string {
    if (by === "policy") return "policy";
    if (by === "llm") return "arbiter";
    return "operator";
  }

  function worktreeLabel(clone: GitCloneRow, worktreeId: string): string {
    const match = clone.worktrees.find((w) => w.worktree_id === worktreeId);
    return match ? match.worktree_path : worktreeId.slice(0, 8);
  }

  const holdsLease = (lease: GitLeaseRow) => lease.verdict === "allow";
</script>

<PageHeader
  title="Git Director"
  subtitle="Which agent is working in which clone, who holds each branch, and why every contended merge was decided the way it was."
>
  {#snippet actions()}
    <Button variant="outline" onclick={refresh}>
      <RefreshCw class="h-4 w-4" /> Refresh
    </Button>
  {/snippet}
</PageHeader>

<div class="space-y-6">
  <GitDirectorSection />

  {#if $clones.isPending}
    <p class="text-sm text-muted-foreground">Loading the registry…</p>
  {:else if !$state.data?.enabled && rows.length === 0}
    <div class="rounded-lg border border-dashed p-8 text-center">
      <GitMerge class="mx-auto h-8 w-8 text-muted-foreground" />
      <p class="mt-3 text-sm font-medium">Nothing registered yet</p>
      <p class="mx-auto mt-1 max-w-prose text-xs text-muted-foreground">
        Turn the Director on above, and agents appear here the first time they call
        <code>git_register</code> from a worktree.
      </p>
    </div>
  {:else if rows.length === 0}
    <div class="rounded-lg border border-dashed p-8 text-center">
      <GitMerge class="mx-auto h-8 w-8 text-muted-foreground" />
      <p class="mt-3 text-sm font-medium">No clones registered</p>
      <p class="mx-auto mt-1 max-w-prose text-xs text-muted-foreground">
        The Director is on. An agent appears here the first time it calls <code>git_register</code>
        from a worktree.
      </p>
    </div>
  {:else}
    {#each groups as group (group.key)}
      <section class="space-y-3">
        <h2 class="text-sm font-semibold tracking-tight">
          {group.remote ?? "No remote"}
          {#if group.clones.length > 1}
            <span class="ml-2 text-xs font-normal text-muted-foreground">
              {group.clones.length} clones across hosts · grouped for visibility, arbitrated separately
            </span>
          {/if}
        </h2>

        {#each group.clones as clone (clone.clone_id)}
          <div class="overflow-hidden rounded-lg border">
            <header class="flex flex-wrap items-baseline justify-between gap-2 border-b bg-muted/30 px-4 py-2">
              <div class="min-w-0">
                <p class="truncate font-mono text-sm">{clone.repo_root}</p>
                <p class="text-xs text-muted-foreground">
                  {clone.fqdn ?? `host ${clone.host_id}`} · seen {relativeTime(clone.last_seen_at)}
                </p>
              </div>
              <Badge variant="outline">{clone.worktrees.length} worktrees</Badge>
            </header>

            <!-- Worktrees -->
            <div class="divide-y">
              {#each clone.worktrees as worktree (worktree.worktree_id)}
                <div class="flex flex-wrap items-start justify-between gap-3 px-4 py-2.5">
                  <div class="min-w-0 flex-1">
                    <p class="truncate font-mono text-xs">{worktree.worktree_path}</p>
                    <p class="mt-0.5 text-xs text-muted-foreground">
                      {worktree.username}{worktree.engine ? ` · ${worktree.engine}` : ""}
                      {worktree.branch ? ` · ${worktree.branch}` : " · detached"}
                      {worktree.target_branch ? ` → ${worktree.target_branch}` : ""}
                    </p>
                    {#if worktree.task}
                      <p class="mt-1 max-w-prose text-xs text-muted-foreground italic">{worktree.task}</p>
                    {/if}
                    {#if worktree.declared_paths.length > 0}
                      <p class="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                        {worktree.declared_paths.slice(0, 4).join(", ")}{worktree.declared_paths.length > 4
                          ? ` +${worktree.declared_paths.length - 4}`
                          : ""}
                      </p>
                    {/if}
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    {#if worktree.agent_address_bound}
                      <Badge variant="info">addressable</Badge>
                    {/if}
                    <span class="text-xs text-muted-foreground">
                      expires {relativeTime(worktree.expires_at)}
                    </span>
                  </div>
                </div>
              {/each}
            </div>

            <!-- Live leases and queue -->
            {#if clone.leases.length > 0}
              <div class="border-t bg-muted/20 px-4 py-3">
                <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Leases and queue
                </p>
                <div class="space-y-2">
                  {#each clone.leases as lease (lease.request_id)}
                    <div class="flex flex-wrap items-start justify-between gap-3 rounded-md border bg-background px-3 py-2">
                      <div class="min-w-0 flex-1">
                        <p class="text-xs">
                          <Badge variant={verdictVariant(lease.verdict)}>{lease.verdict}</Badge>
                          <span class="ml-2 font-medium">{lease.target_branch}</span>
                          <span class="ml-2 font-mono text-muted-foreground">
                            {worktreeLabel(clone, lease.worktree_id)}
                          </span>
                        </p>
                        {#if lease.reason}
                          <p class="mt-1 max-w-prose text-xs text-muted-foreground">{lease.reason}</p>
                        {/if}
                        {#if lease.overlap.length > 0}
                          <p class="mt-1 font-mono text-[11px] text-muted-foreground">
                            overlap: {lease.overlap.slice(0, 5).join(", ")}{lease.overlap.length > 5
                              ? ` +${lease.overlap.length - 5}`
                              : ""}
                          </p>
                        {/if}
                        <p class="mt-1 text-[11px] text-muted-foreground">
                          decided by {decidedByLabel(lease.decided_by)}
                          {#if holdsLease(lease) && lease.lease_expires_at}
                            · lease expires {relativeTime(lease.lease_expires_at)}
                          {/if}
                        </p>
                      </div>
                      {#if canMutate}
                        <div class="flex shrink-0 gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={$decide.isPending}
                            onclick={() => $decide.mutate({ id: lease.request_id, verdict: "allow" })}
                          >
                            Force allow
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={$decide.isPending}
                            onclick={() => $decide.mutate({ id: lease.request_id, verdict: "deny" })}
                          >
                            Deny
                          </Button>
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
            {/if}

            <!-- Recent verdicts. A contended verdict may come from a model and is
                 not reproducible, so the stored reason is the only record of why. -->
            {#if clone.recent.length > 0}
              <details class="border-t px-4 py-2">
                <summary class="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Recent verdicts ({clone.recent.length})
                </summary>
                <div class="mt-2 space-y-1.5">
                  {#each clone.recent as row (row.request_id)}
                    <div class="text-xs">
                      <Badge variant={verdictVariant(row.verdict)}>{row.verdict}</Badge>
                      <span class="ml-2">{row.target_branch}</span>
                      <span class="ml-2 text-muted-foreground">
                        {decidedByLabel(row.decided_by)}{row.model ? ` · ${row.model}` : ""} ·
                        {relativeTime(row.requested_at)}
                      </span>
                      {#if row.reason}
                        <p class="mt-0.5 max-w-prose text-muted-foreground">{row.reason}</p>
                      {/if}
                    </div>
                  {/each}
                </div>
              </details>
            {/if}
          </div>
        {/each}
      </section>
    {/each}
  {/if}
</div>
