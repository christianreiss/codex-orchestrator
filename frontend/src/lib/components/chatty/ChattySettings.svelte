<script lang="ts">
  import { hasFocus, restoreFocus } from '$lib/utils/restore-focus';
  import { toStore } from 'svelte/store';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { authStore } from '$lib/stores/auth';
  import { api } from '$lib/api/client';
  import { Section, StateBlock } from '$lib/components/page';
  import DraftGuard from '$lib/components/page/DraftGuard.svelte';
  import { Switch } from '$lib/components/ui/switch';
  import { Input } from '$lib/components/ui/input';
  import { Button } from '$lib/components/ui/button';
  import { FormField } from '$lib/components/ui/form-field';
  import * as Select from '$lib/components/ui/select';

  interface Settings { enabled: boolean; engine_order: string[]; concurrency: number; queue_limit: number; steps: number; timeout_seconds: number }
  const ORDERS = ['codex,claude,grok', 'codex,grok,claude', 'claude,codex,grok', 'claude,grok,codex', 'grok,codex,claude', 'grok,claude,codex'];
  const arrow = (order: string) => order.replaceAll(',', ' → ');

  const qc = useQueryClient();
  const canManage = $derived($authStore.can('chatty.manage'));
  const settings = createQuery(toStore(() => ({ queryKey: ['chatty', 'settings'], queryFn: () => api.get<Settings>('/admin/chatty/settings'), enabled: canManage })));
  const save = createMutation<unknown, Error, Partial<Settings>>({
    mutationFn: (patch) => api.put('/admin/chatty/settings', { ...$settings.data, ...patch }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['chatty'] }),
  });
  const busy = $derived($save.isPending);
  // Background refreshes do not lock the controls (see TogglePolicy).
  const disabled = $derived(!canManage || busy || !$settings.isSuccess);

  async function toggleEnabled(enabled: boolean) {
    const refocus = hasFocus('chatty-enabled');
    try { await $save.mutateAsync({ enabled }); } catch { /* shown below */ }
    if (refocus) await restoreFocus('chatty-enabled');
  }

  // Parallel requests is typed: it saves on "Save", never half-typed.
  let concurrency = $state<number | undefined>(undefined);
  let adopted: number | undefined;
  $effect(() => {
    const server = $settings.data?.concurrency;
    // Never replace a value the operator is typing; a changed server value shows once the draft is saved or reset.
    if (server !== undefined && server !== adopted && (!concurrencyDirty || concurrency === adopted)) { adopted = server; concurrency = server; }
  });
  const concurrencyError = $derived(Number.isInteger(concurrency) && concurrency! >= 1 && concurrency! <= 2 ? '' : 'Enter 1 or 2.');
  const concurrencyDirty = $derived($settings.data !== undefined && concurrency !== $settings.data.concurrency);
</script>
{#if !canManage}
  <Section id="chatty" title="Chatty" description="Personal product assistant for owners and admins. Uses verified accounts of the enabled engines.">
    <p class="text-body-sm text-muted-foreground">Read only. Chatty settings require <code class="font-mono">chatty.manage</code>.</p>
  </Section>
{:else}
  <DraftGuard dirty={concurrencyDirty} preserveOnSamePath />
  <Section id="chatty" title="Chatty" description="Personal product assistant for owners and admins. Uses verified accounts of the enabled engines.">
    {#if $settings.isPending}
      <StateBlock state="loading" rows={2} />
    {:else if $settings.isError}
      <StateBlock state="error" cause={$settings.error} message="Could not load Chatty settings." onRetry={() => void $settings.refetch()} />
    {:else if $settings.data}
      <div class="divide-y border-y">
        <div class="flex items-start justify-between gap-4 py-3">
          <div class="min-w-0">
            <label for="chatty-enabled" class="text-body font-medium">Enable Chatty</label>
            <p id="chatty-enabled-help" class="text-body-sm text-muted-foreground">Disabling stops requests in progress. Conversations are kept and changes already made stay in place.</p>
          </div>
          {#key `${$save.status}:${$settings.data.enabled}`}
            <Switch id="chatty-enabled" checked={$settings.data.enabled} {disabled} aria-describedby="chatty-enabled-help chatty-status" onCheckedChange={(enabled) => void toggleEnabled(enabled)} />
          {/key}
        </div>
        <div class="space-y-1.5 py-3">
          <label for="chatty-priority" class="text-body font-medium">Automatic priority</label>
          <p id="chatty-priority-help" class="text-body-sm text-muted-foreground">Which engine Chatty tries first when it picks one itself.</p>
          <Select.Root type="single" value={$settings.data.engine_order.join(',')} onValueChange={(v) => { if (v) $save.mutate({ engine_order: v.split(',') }); }} {disabled}>
            <Select.Trigger id="chatty-priority" class="w-72 max-w-full" aria-describedby="chatty-priority-help chatty-status"><span>{arrow($settings.data.engine_order.join(','))}</span></Select.Trigger>
            <Select.Content>{#each ORDERS as order}<Select.Item value={order} label={arrow(order)}>{arrow(order)}</Select.Item>{/each}</Select.Content>
          </Select.Root>
        </div>
        <form class="space-y-2 py-3" onsubmit={(event) => { event.preventDefault(); if (!disabled && concurrencyDirty && !concurrencyError) $save.mutate({ concurrency }); }}>
          <FormField id="chatty-concurrency" label="Parallel requests" hint="How many Chatty requests run at once: 1 or 2." error={concurrencyDirty ? concurrencyError : ''} class="max-w-48">
            {#snippet children(f)}
              <Input id="chatty-concurrency" type="number" min={1} max={2} step={1} bind:value={concurrency} {disabled} aria-label="Parallel Chatty requests" aria-describedby={f.describedBy} aria-invalid={f.invalid} />
            {/snippet}
          </FormField>
          <div class="flex gap-2">
            <Button type="submit" size="sm" disabled={disabled || !concurrencyDirty || !!concurrencyError}>Save changes</Button>
            <Button type="button" size="sm" variant="outline" disabled={busy || !concurrencyDirty} onclick={() => { concurrency = $settings.data?.concurrency; }}>Reset</Button>
          </div>
        </form>
      </div>
      <div id="chatty-status" role="status" aria-live="polite" class="mt-2 text-body-sm empty:hidden">
        {#if busy}<span class="text-muted-foreground">Saving…</span>
        {:else if $save.isError}<span role="alert" class="text-destructive">Save failed: {$save.error.message}</span>
        {:else if $save.isSuccess}<span class="text-muted-foreground">Saved</span>{/if}
      </div>
    {/if}
  </Section>
{/if}
