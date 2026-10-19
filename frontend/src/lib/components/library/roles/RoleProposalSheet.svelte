<script lang="ts">
  /**
   * One agent proposal: what it changes (current next to proposed), how the
   * pipeline judged it, and the operator's steering actions — publish or
   * reject a held/open proposal, veto (revert) a published one.
   */
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { ApiError } from "$lib/api/client";
  import { rolesApi, rolesKeys } from "$lib/api/roles";
  import { StateBlock } from "$lib/components/page";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { FormField } from "$lib/components/ui/form-field";
  import { Textarea } from "$lib/components/ui/textarea";
  import * as Sheet from "$lib/components/ui/sheet";
  import { actorLabel, exactTime, PROPOSAL_STATUS, RISK_LABEL } from "./role-model";

  let { open = $bindable(), proposalId }: { open: boolean; proposalId: string | null } = $props();

  const qc = useQueryClient();
  const query = createQuery(
    reactiveOptions(() => ({
      queryKey: [...rolesKeys.proposal(proposalId ?? "none")],
      queryFn: () => rolesApi.proposal(proposalId!),
      enabled: open && !!proposalId,
    })),
  );
  const detail = $derived($query.data);
  const proposal = $derived(detail?.proposal);
  const isOpen = $derived(proposal && ["checking", "in_review", "held"].includes(proposal.status));
  let reason = $state("");
  let reasonError = $state<string | null>(null);

  const decide = createMutation({
    mutationFn: (verdict: "accept" | "reject") => rolesApi.decide(proposal!.id, { verdict, reason: reason.trim(), expected_version: proposal!.version }),
    onSuccess: (_data, verdict) => {
      toast.success(proposal?.status === "applied" ? "Vetoed: the earlier version is published again" : verdict === "accept" ? "Published" : "Rejected");
      reason = "";
      void qc.invalidateQueries({ queryKey: [...rolesKeys.all] });
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "The decision was not recorded"),
  });
  function run(verdict: "accept" | "reject") {
    reasonError = reason.trim() ? null : "Say why; the author and the trail keep it.";
    if (!reasonError) $decide.mutate(verdict);
  }
</script>

<Sheet.Root bind:open>
  <Sheet.Content side="right" class="w-full overflow-y-auto sm:max-w-3xl">
    <Sheet.Header>
      <Sheet.Title>{proposal?.title ?? "Proposal"}</Sheet.Title>
      <Sheet.Description>A change an agent proposed to this role. Unreviewed content is not part of the role.</Sheet.Description>
    </Sheet.Header>
    <div class="mt-4 space-y-5">
      {#if $query.isLoading}
        <StateBlock state="loading" />
      {:else if $query.isError || !detail || !proposal}
        <StateBlock state="error" message={$query.error instanceof Error ? $query.error.message : "Could not load the proposal"} onRetry={() => void $query.refetch()} />
      {:else}
        <dl class="grid gap-x-4 gap-y-2 text-body-sm sm:grid-cols-2">
          <div><dt class="text-muted-foreground">Status</dt><dd><Badge variant={PROPOSAL_STATUS[proposal.status].variant}>{PROPOSAL_STATUS[proposal.status].label}</Badge></dd></div>
          <div><dt class="text-muted-foreground">Risk (computed by the server)</dt><dd>{RISK_LABEL[proposal.risk]}</dd></div>
          <div><dt class="text-muted-foreground">Author</dt><dd class="font-mono">{proposal.author.engine ?? "?"} · {String(proposal.author.address_id ?? "").slice(0, 8)} · based on v{proposal.author.role_version ?? "?"}</dd></div>
          <div><dt class="text-muted-foreground">Proposed</dt><dd>{exactTime(proposal.created_at)}</dd></div>
          {#if proposal.decision_note}<div class="sm:col-span-2"><dt class="text-muted-foreground">Outcome</dt><dd>{proposal.decision_note}</dd></div>{/if}
        </dl>

        <section class="space-y-1">
          <h3 class="text-body font-semibold">Rationale (author-supplied)</h3>
          <p class="whitespace-pre-wrap text-body-sm">{proposal.rationale}</p>
        </section>

        <section class="space-y-2">
          <h3 class="text-body font-semibold">Changes</h3>
          {#each proposal.ops as op (op.path)}
            {@const before = detail.current.find((entry) => entry.path === op.path)}
            {@const after = detail.proposed.find((entry) => entry.path === op.path)}
            <div class="rounded-md border">
              <div class="border-b px-3 py-2 font-mono text-body-sm">
                {op.revert_to_version ? `revert to version ${op.revert_to_version}` : `${op.op === "delete" ? "delete" : before?.text != null ? "change" : "add"} ${op.path}`}
              </div>
              {#if !op.revert_to_version}
                <div class="grid gap-0 md:grid-cols-2">
                  <div class="min-w-0 border-b p-3 md:border-b-0 md:border-r">
                    <div class="mb-1 text-caption text-muted-foreground">Current</div>
                    <pre class="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-caption">{before?.text ?? "(not present)"}</pre>
                  </div>
                  <div class="min-w-0 p-3">
                    <div class="mb-1 text-caption text-muted-foreground">Proposed</div>
                    <pre class="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-caption">{op.op === "delete" ? "(deleted)" : after?.binary ? "(binary file)" : after?.text ?? ""}</pre>
                  </div>
                </div>
              {/if}
            </div>
          {/each}
        </section>

        <section class="space-y-2">
          <h3 class="text-body font-semibold">Pipeline</h3>
          {#if proposal.gate_results}
            <ul class="space-y-1 text-body-sm">
              {#each proposal.gate_results.checks as check (check.gate)}
                <li>{check.ok ? "Passed" : "Failed"}: {check.gate.replaceAll("_", " ")}{check.detail ? ` — ${check.detail}` : ""}</li>
              {/each}
            </ul>
          {:else}
            <p class="text-body-sm text-muted-foreground">Checks have not run yet.</p>
          {/if}
          {#if proposal.judge}
            <p class="text-body-sm"><span class="font-medium">Judge ({proposal.judge.model}{proposal.judge.strict ? ", strict pass" : ""}):</span> {proposal.judge.verdict} — {proposal.judge.reason}</p>
          {:else if proposal.status === "checking"}
            <p class="text-body-sm text-muted-foreground">Waiting for the judge. Without a verdict nothing is published.</p>
          {/if}
          {#each proposal.reviews as review (review.at)}
            <p class="text-body-sm"><span class="font-medium">Review by {review.engine} agent {review.reviewer_address_id.slice(0, 8)}:</span> {review.verdict} — {review.reason}</p>
          {/each}
          <details class="rounded-md border">
            <summary class="cursor-pointer select-none px-3 py-2 text-body-sm font-medium">Event trail ({detail.events.length})</summary>
            <ol class="space-y-1 border-t p-3 text-body-sm">
              {#each detail.events as event (event.seq)}
                <li><time datetime={event.at} title={exactTime(event.at)}>{exactTime(event.at)}</time> · {actorLabel(event.actor)} · {event.action.replaceAll("_", " ")}</li>
              {/each}
            </ol>
          </details>
        </section>

        {#if isOpen || proposal.status === "applied"}
          <section class="space-y-3 border-t pt-4">
            <h3 class="text-body font-semibold">{proposal.status === "applied" ? "Veto" : "Steer"}</h3>
            <p class="text-body-sm text-muted-foreground">
              {proposal.status === "applied"
                ? "A veto publishes the version that was current before this change as a new version. Agents on it are told."
                : "Publishing now skips the remaining judge, review, budget and policy steps. Rejecting closes the proposal and tells its author."}
            </p>
            <FormField id="role-decision-reason" label="Reason" error={reasonError ?? undefined}>
              <Textarea id="role-decision-reason" rows={2} bind:value={reason} aria-invalid={!!reasonError} />
            </FormField>
            <div class="flex flex-wrap gap-2">
              {#if proposal.status === "applied"}
                <Button variant="destructive" disabled={$decide.isPending} onclick={() => run("reject")}>Veto and revert</Button>
              {:else}
                <Button variant="outline" disabled={$decide.isPending} onclick={() => run("reject")}>Reject proposal</Button>
                <Button disabled={$decide.isPending} onclick={() => run("accept")}>Publish now</Button>
              {/if}
            </div>
            {#if $decide.isError}<StateBlock state="error" message={$decide.error instanceof ApiError ? $decide.error.message : "The decision was not recorded"} />{/if}
          </section>
        {/if}
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>
