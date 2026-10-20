<script lang="ts">
  import { createInfiniteQuery } from "@tanstack/svelte-query";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { workflowsApi, workflowRunKeys } from "$lib/api/workflows";
  import { StateBlock, Timestamp } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import WorkflowMarkdown from "./WorkflowMarkdown.svelte";
  import WorkflowFacts from "./WorkflowFacts.svelte";
  import WorkflowStatus from "./WorkflowStatus.svelte";
  import { safeWorkflowUrl, displayValue } from "./helpers";
  let { runId, taskId }: { runId: string; taskId: string } = $props();
  const detail = createInfiniteQuery(reactiveOptions(() => ({ queryKey: workflowRunKeys.task(runId,taskId), queryFn: ({ pageParam }: { pageParam: string | undefined }) => workflowsApi.task(runId,taskId,pageParam), initialPageParam: undefined as string | undefined, getNextPageParam: (last: { next_cursor: string | number | null }) => last.next_cursor == null ? undefined : String(last.next_cursor) })));
  const task = $derived($detail.data?.pages[0]?.task);
</script>
{#if $detail.isPending}<StateBlock state="loading" rows={2} />{/if}{#if $detail.isError}<StateBlock state="error" message="Could not load task evidence. Previously loaded details may be stale." onRetry={() => $detail.refetch()} />{/if}
{#if task?.summary}<WorkflowMarkdown text={task.summary} />{/if}
{#if task?.outputs && Object.keys(task.outputs).length}<WorkflowFacts values={task.outputs} label="Task outputs" />{/if}
<ol class="space-y-4">{#each $detail.data?.pages.flatMap(p => p.attempts) ?? [] as attempt (attempt.attempt_no)}<li class="min-w-0 border-l-2 pl-3"><div class="flex flex-wrap items-center gap-2"><h4 class="text-body font-semibold">Attempt {attempt.attempt_no}</h4><WorkflowStatus value={attempt.status} /><span class="text-body-sm text-muted-foreground">Host {attempt.execution_host ?? "not recorded"}</span></div><p class="mt-1 text-caption text-muted-foreground">Started <Timestamp value={attempt.started_at} /> · Ended <Timestamp value={attempt.ended_at} fallback="Not ended" /></p>{#if attempt.summary}<div class="mt-2"><WorkflowMarkdown text={attempt.summary} /></div>{/if}{#if attempt.error}<pre class="mt-2 whitespace-pre-wrap break-words text-body-sm text-destructive">{displayValue(attempt.error)}</pre>{/if}{#if attempt.outputs && Object.keys(attempt.outputs).length}<WorkflowFacts values={attempt.outputs} label={`Attempt ${attempt.attempt_no} outputs`} />{/if}{#if attempt.evidence?.length}<ul class="mt-2 space-y-2">{#each attempt.evidence as item}<li class="text-body-sm"><p>{item.description}</p>{#if item.uri}{#if safeWorkflowUrl(item.uri)}<a class="break-all underline" href={safeWorkflowUrl(item.uri)!} target="_blank" rel="noopener noreferrer">Open evidence</a>{:else}<code class="break-all">{item.uri}</code>{/if}{/if}{#if item.hash}<p class="break-all font-mono text-caption">Hash {item.hash}</p>{/if}{#if item.expires_at}<p class="text-caption text-muted-foreground">Link expires <Timestamp value={item.expires_at} /></p>{/if}<p class="text-caption text-muted-foreground">{item.type ?? "Evidence"} · Host {item.execution_host ?? "not recorded"}{#if item.time} · <Timestamp value={item.time} />{/if}</p></li>{/each}</ul>{/if}</li>{/each}</ol>
{#if $detail.hasNextPage}<Button variant="outline" class="mt-3" disabled={$detail.isFetchingNextPage} onclick={() => $detail.fetchNextPage()}>More attempts</Button>{/if}
