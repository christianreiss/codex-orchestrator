<script lang="ts">
  /** One report: status, original evidence, outcome, triage (if allowed) and history. */
  import { createQuery } from "@tanstack/svelte-query";
  import { StateBlock } from "$lib/components/page";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { feedbackApi, feedbackKeys } from "$lib/api/feedback";
  import { relativeTime } from "$lib/utils/format";
  import ReportTriageForm from "./ReportTriageForm.svelte";
  import { actorLabel, humanize } from "./report-model";

  type Props = { id: string; canManage: boolean; onDeleted: () => void };
  let { id, canManage, onDeleted }: Props = $props();

  const detailQuery = createQuery(
    reactiveOptions(() => ({
      queryKey: feedbackKeys.detail(id),
      queryFn: () => feedbackApi.get(id),
      enabled: Boolean(id),
      refetchInterval: 30000,
    })),
  );
  const item = $derived($detailQuery.data?.feedback);
  const events = $derived($detailQuery.data?.events ?? []);
</script>

{#if $detailQuery.isError}
  <StateBlock state="error" message={$detailQuery.error.message} onRetry={() => void $detailQuery.refetch()} />
{:else if !item}
  <StateBlock state="loading" rows={3} />
{:else}
  <div class="space-y-5">
    <div>
      <h3 class="break-words text-h3">{item.title}</h3>
      <p class="mt-1 break-all font-mono text-caption text-muted-foreground">{item.id}</p>
      <p class="mt-2 text-body-sm">{humanize(item.status)} · {actorLabel(item.claim_owner)}</p>
      {#if item.claim_expires_at}<p class="text-caption text-muted-foreground">Claim expires {new Date(item.claim_expires_at).toLocaleString()}</p>{/if}
      <p class="mt-1 text-body-sm">Deployment: {humanize(item.deployment)}{item.deployment_ref ? ` · ${item.deployment_ref}` : ""}</p>
      {#if item.duplicate_of}<p class="break-all text-body-sm">Duplicate of {item.duplicate_of}</p>{/if}
      <p class="mt-1 break-words text-caption text-muted-foreground">Reported by {actorLabel(item.source)}</p>
    </div>

    <div class="space-y-3 border-y py-4">
      <h4 class="text-body font-semibold">Original report</h4>
      {#each Object.entries(item.report ?? {}) as [key, value] (key)}
        <div>
          <h5 class="text-caption font-medium uppercase text-muted-foreground">{key}</h5>
          <p class="whitespace-pre-wrap break-words text-body-sm">{value}</p>
        </div>
      {/each}
    </div>

    {#if item.result}
      <div class="space-y-2">
        <h4 class="text-body font-semibold">Outcome</h4>
        {#each Object.entries(item.result) as [key, value] (key)}
          {#if value}<p class="whitespace-pre-wrap break-words text-body-sm"><strong>{key}:</strong> {value}</p>{/if}
        {/each}
      </div>
    {/if}

    {#if canManage}<ReportTriageForm {item} {onDeleted} />{/if}

    <div class="border-t pt-4">
      <h4 class="mb-2 text-body font-semibold">History</h4>
      {#each events as event (event.id)}
        <details class="mb-2 rounded-md border px-3 py-2">
          <summary class="cursor-pointer text-body-sm">
            v{event.version} · {humanize(event.action)} · {actorLabel(event.actor)}
            <span class="ml-2 text-caption text-muted-foreground">{relativeTime(event.created_at)}</span>
          </summary>
          <pre class="mt-2 whitespace-pre-wrap break-all font-mono text-caption">{JSON.stringify(event.detail, null, 2)}</pre>
        </details>
      {/each}
    </div>
  </div>
{/if}
