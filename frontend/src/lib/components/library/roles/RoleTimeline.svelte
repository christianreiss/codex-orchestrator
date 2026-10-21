<script lang="ts">
  /**
   * How a role has changed and who holds it: published versions (revert,
   * withdraw), the changes agents proposed, and the agents holding it now.
   * Agents publish on their own; this is where the operator looks and steers.
   */
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { ApiError } from "$lib/api/client";
  import { rolesApi, rolesKeys, type RoleDetail, type RoleVersion } from "$lib/api/roles";
  import { Section, StateBlock } from "$lib/components/page";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { FormField } from "$lib/components/ui/form-field";
  import { Textarea } from "$lib/components/ui/textarea";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Table from "$lib/components/ui/table";
  import { relativeTime } from "$lib/utils/format";
  import RoleProposalSheet from "./RoleProposalSheet.svelte";
  import { actorLabel, exactTime, PROPOSAL_STATUS, RISK_LABEL } from "./role-model";

  let { slug, detail }: { slug: string; detail: RoleDetail } = $props();

  const qc = useQueryClient();
  const timeline = createQuery(reactiveOptions(() => ({ queryKey: [...rolesKeys.timeline(slug)], queryFn: () => rolesApi.timeline(slug) })));
  const current = $derived(detail.versions.find((version) => version.id === detail.role.current_version_id) ?? null);

  let proposalOpen = $state(false);
  let proposalId = $state<string | null>(null);

  let action = $state<{ kind: "revert" | "withdraw"; version: RoleVersion } | null>(null);
  let actionOpen = $state(false);
  let reason = $state("");
  let reasonError = $state<string | null>(null);
  const run = createMutation({
    mutationFn: () =>
      action!.kind === "revert"
        ? rolesApi.revert(slug, action!.version.version!, reason.trim())
        : rolesApi.withdraw(slug, action!.version.version!, reason.trim()),
    onSuccess: () => {
      toast.success(action?.kind === "revert" ? `Version ${action.version.version} published again as a new version` : `Version ${action?.version.version} withdrawn`);
      actionOpen = false;
      reason = "";
      void qc.invalidateQueries({ queryKey: [...rolesKeys.all] });
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "The change was not made"),
  });
  function open(kind: "revert" | "withdraw", version: RoleVersion) {
    action = { kind, version };
    reason = "";
    reasonError = null;
    actionOpen = true;
  }
  function confirm() {
    reasonError = reason.trim() ? null : "Give a reason; holders and the trail keep it.";
    if (!reasonError) $run.mutate();
  }
</script>

<Section title="Versions" description="Published versions are immutable. A revert publishes an earlier version again as a new one; a withdrawn version accepts no new activations.">
  {#if detail.versions.length}
    <div class="rounded-md border">
      <Table.Root regionLabel="Role versions">
        <Table.Header>
          <Table.Row>
            <Table.Head>Version</Table.Head>
            <Table.Head>Published</Table.Head>
            <Table.Head>By</Table.Head>
            <Table.Head>Changelog</Table.Head>
            <Table.Head><span class="sr-only">Actions</span></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each detail.versions as version (version.id)}
            <Table.Row>
              <Table.Cell class="whitespace-nowrap">
                v{version.version}
                {#if version.id === current?.id}<Badge variant="success" class="ml-1">current</Badge>{/if}
                {#if version.state === "withdrawn"}<Badge variant="destructive" class="ml-1">withdrawn</Badge>{/if}
              </Table.Cell>
              <Table.Cell class="whitespace-nowrap text-body-sm" title={exactTime(version.published_at)}>{version.published_at ? relativeTime(version.published_at) : "—"}</Table.Cell>
              <Table.Cell class="whitespace-nowrap text-body-sm">{actorLabel(version.published_by)}</Table.Cell>
              <Table.Cell class="min-w-56 text-body-sm">{version.changelog ?? "—"}</Table.Cell>
              <Table.Cell class="whitespace-nowrap text-right">
                {#if version.id !== current?.id && version.state === "published"}
                  <Button size="sm" variant="outline" onclick={() => open("revert", version)}>Revert to v{version.version}</Button>
                {/if}
                {#if version.state === "published"}
                  <Button size="sm" variant="ghost" onclick={() => open("withdraw", version)}>Withdraw</Button>
                {/if}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>
  {:else}
    <p class="text-body-sm text-muted-foreground">Not published yet. Agents can activate the role once you publish the draft.</p>
  {/if}
</Section>

<Section title="Changes proposed by agents" description="Holders propose improvements; the server checks and judges them, asks another holder for changes to existing material, and publishes them itself.">
  {#if $timeline.isLoading}
    <StateBlock state="loading" rows={2} />
  {:else if $timeline.isError}
    <StateBlock state="error" message={$timeline.error instanceof Error ? $timeline.error.message : "Could not load proposals"} onRetry={() => void $timeline.refetch()} />
  {:else if !$timeline.data?.proposals.length}
    <p class="text-body-sm text-muted-foreground">No proposals yet.</p>
  {:else}
    <div class="rounded-md border">
      <Table.Root regionLabel="Role proposals">
        <Table.Header>
          <Table.Row>
            <Table.Head>Proposal</Table.Head>
            <Table.Head>Risk</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head>Proposed</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each $timeline.data.proposals as proposal (proposal.id)}
            <Table.Row>
              <Table.Cell class="min-w-56">
                <button type="button" class="text-left font-medium hover:underline" onclick={() => ((proposalId = proposal.id), (proposalOpen = true))}>{proposal.title}</button>
                {#if proposal.decision_note}<div class="truncate text-body-sm text-muted-foreground">{proposal.decision_note}</div>{/if}
              </Table.Cell>
              <Table.Cell class="whitespace-nowrap text-body-sm">{RISK_LABEL[proposal.risk]}</Table.Cell>
              <Table.Cell class="whitespace-nowrap"><Badge variant={PROPOSAL_STATUS[proposal.status].variant}>{PROPOSAL_STATUS[proposal.status].label}</Badge></Table.Cell>
              <Table.Cell class="whitespace-nowrap text-body-sm" title={exactTime(proposal.created_at)}>{relativeTime(proposal.created_at)}</Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>
  {/if}
</Section>

<Section title="Holders" description="Agents holding this role now, each pinned to the version it activated.">
  {#if detail.holders.length}
    <ul class="space-y-1 text-body-sm">
      {#each detail.holders as holder (holder.address_id)}
        {@const version = detail.versions.find((entry) => entry.id === holder.version_id)}
        <li>
          <span class="font-mono">agent:{holder.address_id.slice(0, 8)}</span>
          · v{version?.version ?? "?"}
          · since <time datetime={holder.activated_at} title={exactTime(holder.activated_at)}>{relativeTime(holder.activated_at)}</time>
          · {String(holder.activated_by.kind ?? "").replaceAll("_", " ")}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="text-body-sm text-muted-foreground">No agent holds this role right now.</p>
  {/if}
</Section>

<RoleProposalSheet bind:open={proposalOpen} {proposalId} />

<Dialog.Root bind:open={actionOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>{action?.kind === "revert" ? `Revert ${slug} to version ${action?.version.version}` : `Withdraw ${slug} version ${action?.version.version}`}</Dialog.Title>
      <Dialog.Description>
        {action?.kind === "revert"
          ? "Publishes the content of that version as a new version. Existing holders find the update in role history and switch at their next task boundary."
          : "Blocks new activations of this version. Current live holders are warned it is faulty; the newest remaining version becomes current."}
      </Dialog.Description>
    </Dialog.Header>
    <FormField id="role-version-reason" label="Reason" error={reasonError ?? undefined}>
      <Textarea id="role-version-reason" rows={3} bind:value={reason} aria-invalid={!!reasonError} />
    </FormField>
    <Dialog.Footer class="gap-2">
      <Button variant="outline" onclick={() => (actionOpen = false)}>Cancel</Button>
      <Button variant={action?.kind === "withdraw" ? "destructive" : "default"} disabled={$run.isPending} onclick={confirm}>
        {action?.kind === "revert" ? `Revert to v${action?.version.version}` : `Withdraw v${action?.version.version}`}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
