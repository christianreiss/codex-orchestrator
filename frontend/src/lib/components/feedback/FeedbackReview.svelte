<script lang="ts">
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { Button } from '$lib/components/ui/button';
  import Timestamp from '$lib/components/page/Timestamp.svelte';
  import { feedbackApi, feedbackKeys, type FeedbackItem } from '$lib/api/feedback';
  import { humanize } from './report-model';
  let { item, canManage }: { item: FeedbackItem; canManage: boolean } = $props();
  const client = useQueryClient();
  const configuration = createQuery({ queryKey: feedbackKeys.configuration, queryFn: feedbackApi.configuration });
  const mutation = createMutation({ mutationFn: () => feedbackApi.recheck(item.id, item.version),
    onSuccess: () => { void client.invalidateQueries({ queryKey: feedbackKeys.all }); } });
  const check = $derived(item.pipeline);
</script>

{#if check}
  <section aria-label="GitHub review" class="space-y-2 border-y py-4">
    <h4 class="text-body font-semibold">GitHub review</h4>
    <p class="text-body-sm">Version: {check.version_state} · Review: {humanize(check.review_state)} · Delivery: {humanize(check.delivery_state)}</p>
    {#if check.reason}<p class="whitespace-pre-wrap break-words text-body-sm">{check.reason}</p>{/if}
    {#if check.github_url}<a class="break-all text-body-sm underline" href={check.github_url} target="_blank" rel="noreferrer">{check.delivery_state === 'sent' ? 'Confirmed publication' : 'Related issue'}: {check.github_url}</a>{/if}
    {#if check.checked_at}<p class="text-body-sm">AI review <Timestamp value={check.checked_at} /></p>{/if}
    <details>
      <summary class="cursor-pointer text-body-sm">Version and retest evidence</summary>
      <dl class="mt-2 grid gap-2 break-all text-body-sm">
        <div><dt>Reported build</dt><dd class="font-mono">{check.created_commit ?? 'Unknown'}</dd></div>
        <div><dt>Checked build</dt><dd class="font-mono">{check.tested_commit ?? 'Not checked'}</dd></div>
        <div><dt>Upstream main</dt><dd class="font-mono">{check.upstream_commit ?? 'Not checked'}</dd></div>
      </dl>
      {#if check.retest}<p class="mt-2 text-body-sm">API assertion: {check.retest.passed ? 'passed' : 'failed'} · <Timestamp value={check.retest.at} /></p>{/if}
      {#each check.evidence_urls as url (url)}<p><a class="break-all text-body-sm underline" href={url} target="_blank" rel="noreferrer">{url}</a></p>{/each}
    </details>
    {#if check.next_attempt_at}<p class="text-body-sm">Next check <Timestamp value={check.next_attempt_at} /></p>{/if}
    {#if canManage && check.delivery_state !== 'sent'}
      <Button variant="outline" disabled={$mutation.isPending} onclick={() => $mutation.mutate()}>{$mutation.isPending ? 'Queuing…' : check.delivery_state === 'uncertain' ? 'Reconcile publication' : 'Check again'}</Button>
    {/if}
    {#if $mutation.isError}<p role="alert" class="text-body-sm text-destructive">{$mutation.error.message}</p>{/if}
    {#if $mutation.isSuccess}<p role="status" class="text-body-sm">Check queued. The server runner processes it when enabled.</p>{/if}
  </section>
{:else if $configuration.data?.mode === 'user' && canManage}
  <section aria-label="GitHub review" class="space-y-2 border-y py-4">
    <p class="text-body-sm">This existing local report has not been selected for GitHub checks.</p>
    <Button variant="outline" disabled={$mutation.isPending} onclick={() => $mutation.mutate()}>Queue GitHub check</Button>
    {#if $mutation.isError}<p role="alert" class="text-body-sm text-destructive">{$mutation.error.message}</p>{/if}
    {#if $mutation.isSuccess}<p role="status" class="text-body-sm">Check queued.</p>{/if}
  </section>
{/if}
