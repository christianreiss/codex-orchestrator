<script lang="ts">
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { Button } from '$lib/components/ui/button';
  import { FormField } from '$lib/components/ui/form-field';
  import { StateBlock } from '$lib/components/page';
  import { feedbackApi, feedbackKeys, type FeedbackConfiguration } from '$lib/api/feedback';
  import { controlClass } from './report-model';

  let { canManage, reportingEnabled }: { canManage: boolean; reportingEnabled: boolean } = $props();
  const client = useQueryClient();
  const query = createQuery({ queryKey: feedbackKeys.configuration, queryFn: feedbackApi.configuration });
  let draft = $state<FeedbackConfiguration | null>(null);
  let dirty = $state(false);
  let token = $state('');
  let disconnect = $state(false);
  let saved = $state(false);
  $effect(() => { if ($query.data?.revision && !dirty) draft = { ...$query.data }; });
  const mutation = createMutation({
    mutationFn: feedbackApi.saveConfiguration,
    onSuccess: (result) => {
      client.setQueryData(feedbackKeys.configuration, result);
      draft = { ...result }; token = ''; disconnect = false; dirty = false; saved = true;
      void client.invalidateQueries({ queryKey: ['agents'] });
      void client.invalidateQueries({ queryKey: feedbackKeys.all });
    },
  });
  function save() {
    if (!draft) return;
    const { mode, auto_publish, runner_enabled, engine, model } = draft;
    saved = false;
    $mutation.mutate({ expected_revision: draft.revision, config: { mode, auto_publish, runner_enabled, engine, model },
      ...(token.trim() ? { token: token.trim() } : {}), ...(disconnect ? { disconnect: true } : {}) });
  }
</script>

<details class="mb-5 border-b pb-4">
  <summary class="cursor-pointer text-body font-semibold">Feedback destination and automatic checks</summary>
  {#if $query.isError}
    <StateBlock state="error" message={$query.error.message} onRetry={() => void $query.refetch()} />
  {:else if !draft}
    <StateBlock state="loading" rows={2} />
  {:else}
    <form class="mt-4 grid max-w-2xl gap-4" onsubmit={(e) => { e.preventDefault(); save(); }} oninput={() => { dirty = true; saved = false; }} onchange={() => { dirty = true; saved = false; }}>
      <fieldset class="grid gap-4" disabled={!canManage || $mutation.isPending}>
        <FormField id="feedback-mode" label="Feedback mode">
          <select id="feedback-mode" class={controlClass} bind:value={draft.mode}>
            <option value="source_developer">Source Developer — local developer inbox</option>
            <option value="user">User — local reports with GitHub checks</option>
          </select>
        </FormField>
        {#if draft.mode === 'user'}
          <p class="break-words text-body-sm">Public destination: <a class="underline" href="https://github.com/christianreiss/codex-orchestrator/issues" target="_blank" rel="noreferrer">christianreiss/codex-orchestrator</a>. Every report is retained locally first.</p>
          <label class="flex min-h-11 items-center gap-3 text-body-sm"><input type="checkbox" bind:checked={draft.runner_enabled} /> Enable server checks and API retests</label>
          {#if draft.runner_enabled && !reportingEnabled}<p role="status" class="text-body-sm text-muted-foreground">Server checks are paused while Agent reports is off. Enable Agent reports above to process the queue.</p>{/if}
          <div class="grid gap-3 sm:grid-cols-2">
            <FormField id="feedback-engine" label="Review engine">
              <select id="feedback-engine" class={controlClass} bind:value={draft.engine}>
                <option value={null}>Select engine</option><option value="codex">Codex</option><option value="claude">Claude</option><option value="grok">Grok</option>
              </select>
            </FormField>
            <FormField id="feedback-model" label="Review model">
              <input id="feedback-model" class={controlClass} value={draft.model ?? ''} oninput={(e) => { if (draft) draft.model = e.currentTarget.value.trim() || null; }} required={draft.runner_enabled} placeholder="An enabled model from this engine" />
            </FormField>
          </div>
          <p class="text-body-sm text-muted-foreground">Uses your configured provider account and quota. One check at a time; up to five minutes per attempt. UI and host-specific retests stay open when the server cannot reproduce them.</p>
          <FormField id="feedback-github-token" label="GitHub token" hint="A classic personal access token with public_repo. This scope also grants write access to public repository code; the feedback service uses it only for issues and comments.">
            <input id="feedback-github-token" type="password" class={controlClass} bind:value={token} autocomplete="new-password" placeholder={draft.token_configured ? 'Token stored — leave empty to keep it' : 'Paste a classic GitHub PAT'} />
          </FormField>
          <p class="text-body-sm">GitHub connection: {draft.token_configured ? 'Token stored; access is checked on use' : 'Not connected'}</p>
          {#if draft.token_configured}<label class="flex min-h-11 items-center gap-3 text-body-sm"><input type="checkbox" bind:checked={disconnect} /> Remove stored GitHub token</label>{/if}
          <label class="flex min-h-11 items-start gap-3 py-2 text-body-sm"><input class="mt-1" type="checkbox" bind:checked={draft.auto_publish} /> Allow automatic publication of checked reports and useful comments to this public GitHub repository</label>
          <p class="text-body-sm text-muted-foreground">Old versions wait for an update and retest. Incomplete checks stay local. Turning this off stops new publications; confirmed GitHub posts remain public.</p>
        {/if}
      </fieldset>
      {#if $mutation.isError}
        <p role="alert" class="text-body-sm text-destructive">{$mutation.error.message} Your draft is retained.</p>
        <Button type="button" variant="outline" onclick={() => { dirty = false; token = ''; disconnect = false; void $query.refetch(); }}>Reload saved feedback settings</Button>
      {/if}
      <div class="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!canManage || !dirty || $mutation.isPending}>{$mutation.isPending ? 'Saving…' : 'Save feedback settings'}</Button>
        <span role="status" class="text-body-sm text-muted-foreground">{saved ? 'Saved' : dirty ? 'Unsaved changes' : ''}</span>
      </div>
    </form>
  {/if}
</details>
