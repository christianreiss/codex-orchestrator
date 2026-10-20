<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { workflowsApi, workflowKeys } from "$lib/api/workflows";
  import { authStore } from "$lib/stores/auth";
  import { StateBlock } from "$lib/components/page";
  import { base } from "$app/paths";
  const availability = createQuery(reactiveOptions(() => ({ queryKey: workflowKeys.state, queryFn: workflowsApi.state, enabled: $authStore.can("workflows.read") })));
</script>
{#if $availability.data?.unavailable_reason}<div role="status" class="rounded-md border border-warning/40 bg-warning-muted p-3 text-body-sm text-warning-muted-foreground"><p>{$availability.data.unavailable_reason}</p>{#if $authStore.can("agent_messaging.read")}<a class="mt-1 inline-flex min-h-9 items-center underline" href={`${base}/agent-messaging`}>Agent Messaging settings</a>{/if}</div>{/if}
{#if $availability.isError}<StateBlock state="error" message="Could not check workflow execution prerequisites." onRetry={() => $availability.refetch()} />{/if}
