<script lang="ts">
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  /** Sheet body for one worktree, merge request or released registration. */
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import type { GitCloneRow } from "$lib/api/gitDirector";
  import { repoName, verdictVariant, type GitSelection } from "./git-rows";

  type Props = {
    clone: GitCloneRow | undefined;
    selection: GitSelection | null;
    canMutate: boolean;
    busy: boolean;
    onDecide: (id: string, verdict: "allow" | "deny") => void;
    onRelease: (worktreeId: string) => void;
  };
  let { clone, selection, canMutate, busy, onDecide, onRelease }: Props = $props();

  const worktree = $derived(clone?.worktrees.find((w) => selection?.kind === "worktree" && w.worktree_id === selection.id));
  const lease = $derived(clone?.leases.find((l) => selection?.kind === "lease" && l.request_id === selection.id));
  const recent = $derived(clone?.recent.find((l) => selection?.kind === "recent" && l.request_id === selection.id));
  const stale = $derived(clone?.stale.find((w) => selection?.kind === "stale" && w.worktree_id === selection.id));
  const request = $derived(lease ?? recent);
</script>

<div class="space-y-4 text-body-sm">
  {#if clone}<p class="break-all text-caption text-muted-foreground">{clone.remote_url ?? "No remote"}<br />{clone.repo_root}</p>{/if}
  {#if worktree}
    <p class="font-medium">{worktree.username} · {worktree.engine ?? "Unknown engine"}</p>
    <p>{worktree.task ?? "No task declared"}</p>
    <p>{worktree.branch ?? "Detached"} → {worktree.target_branch ?? "No target branch"}</p>
    <p class="break-all font-mono text-caption">{worktree.worktree_path}<br />{worktree.head_sha}</p>
    <div>
      <h3 class="font-medium">Declared paths</h3>
      {#each worktree.declared_paths as path (path)}<p class="break-all font-mono text-caption">{path}</p>{:else}<p class="text-muted-foreground">None declared.</p>{/each}
    </div>
    <p class="text-caption text-muted-foreground">Heartbeat <Timestamp value={worktree.heartbeat_at} /> · expires <Timestamp value={worktree.expires_at} /> · {worktree.agent_address_bound ? "Addressable" : "No agent address bound"}</p>
    {#if canMutate}
      <Button variant="outline" disabled={busy} onclick={() => onRelease(worktree.worktree_id)}>Release registration</Button>
      <p class="text-caption text-muted-foreground">Also frees its held leases.</p>
    {/if}
  {:else if request}
    <Badge variant={verdictVariant(request.verdict)}>{request.verdict}</Badge>
    <h3 class="font-medium">{request.target_branch}</h3>
    <p>{request.reason ?? "No reason recorded"}</p>
    <p class="break-all font-mono text-caption">{clone?.worktrees.find((w) => w.worktree_id === request.worktree_id)?.worktree_path ?? request.worktree_id}</p>
    <div>
      <h3 class="font-medium">Overlapping paths</h3>
      {#each request.overlap as path (path)}<p class="break-all font-mono text-caption">{path}</p>{:else}<p class="text-muted-foreground">No overlap recorded.</p>{/each}
    </div>
    <p class="text-caption text-muted-foreground">Decided by {request.decided_by === "llm" ? "arbiter" : request.decided_by} · requested <Timestamp value={request.requested_at} />{recent?.model ? ` · ${recent.model}` : ""}</p>
    {#if request.lease_expires_at}<p class="text-caption text-muted-foreground">Lease expires <Timestamp value={request.lease_expires_at} /></p>{/if}
    {#if lease && canMutate}
      <div class="flex gap-2">
        <Button variant="outline" disabled={busy} onclick={() => onDecide(lease.request_id, "allow")}>Force allow</Button>
        <Button variant="destructive" disabled={busy} onclick={() => onDecide(lease.request_id, "deny")}>Deny</Button>
      </div>
    {/if}
  {:else if stale}
    <p>{stale.username} · {stale.engine ?? "Unknown engine"} · {stale.status}</p>
    <p>{stale.task ?? "No task declared"}</p>
    <p class="break-all font-mono text-caption">{stale.worktree_path}</p>
    <p>{stale.branch ?? "Detached"}</p>
    <p class="text-caption text-muted-foreground">Last seen <Timestamp value={stale.last_seen_at} />{stale.released_at ? ` · released $<Timestamp value={stale.released_at} />` : ""}</p>
  {/if}
</div>
