<script lang="ts">
  import { ENGINES, engineLabel } from '$lib/constants/engines';
  import { Button } from '$lib/components/ui/button';
  import { toStore } from 'svelte/store';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { authStore } from '$lib/stores/auth';
  import { api } from '$lib/api/client';
  import { Section } from '$lib/components/page';
  interface Settings { enabled: boolean; engine_order: string[]; concurrency: number; queue_limit: number; steps: number; timeout_seconds: number }
  const qc = useQueryClient();
  const settings = createQuery(toStore(() => ({ queryKey: ['chatty', 'settings'], queryFn: () => api.get<Settings>('/admin/chatty/settings'), enabled: $authStore.can('chatty.manage') })));
  let busy = $state(false); let error = $state('');
  async function update(patch: Partial<Settings>) {
    if (!$settings.data) return;
    busy = true; error = '';
    try { await api.put('/admin/chatty/settings', { ...$settings.data, ...patch }); await qc.invalidateQueries({ queryKey: ['chatty'] }); }
    catch (e) { error = e instanceof Error ? e.message : 'Saving failed'; }
    finally { busy = false; }
  }
  const order = $derived([...($settings.data?.engine_order ?? []), ...ENGINES.filter(engine => !$settings.data?.engine_order.includes(engine))]);
  function move(index: number, offset: number) {
    const next = [...order];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    void update({ engine_order: next });
  }
</script>
{#if $authStore.can('chatty.manage')}
  <Section id="chatty" title="Chatty" description="Personal product assistant for owners and admins. Uses verified accounts of the enabled engines.">
    {#if $settings.data}
      <div class="flex flex-wrap items-end gap-4 p-4">
        <label class="flex items-center gap-2"><input type="checkbox" checked={$settings.data.enabled} disabled={busy} onchange={(e) => void update({ enabled: e.currentTarget.checked })}/> Enable Chatty</label>
        <div class="space-y-1" role="group" aria-label="Automatic priority">
          <p class="text-body">Automatic priority</p>
          <ol class="space-y-1">
            {#each order as engine, index (engine)}
              <li class="flex items-center gap-2"><span class="min-w-24">{index + 1}. {engineLabel(engine)}</span>
                <Button size="sm" variant="outline" disabled={busy || index === 0} aria-label={`Move ${engineLabel(engine)} up`} onclick={() => move(index, -1)}>Up</Button>
                <Button size="sm" variant="outline" disabled={busy || index === order.length - 1} aria-label={`Move ${engineLabel(engine)} down`} onclick={() => move(index, 1)}>Down</Button>
              </li>
            {/each}
          </ol>
        </div>
        <label class="text-body">Parallel requests<input aria-label="Parallel Chatty requests" class="ml-2 w-16 rounded-md border bg-background p-2" type="number" min="1" max="2" value={$settings.data.concurrency} disabled={busy} onchange={(e) => void update({ concurrency: Number(e.currentTarget.value) })}/></label>
      </div>
      <p class="px-4 pb-4 text-body-sm text-muted-foreground">Disabling stops requests in progress. Conversations are kept and changes already made stay in place.</p>
    {/if}
    {#if error}<p role="alert" class="p-4 text-destructive">{error}</p>{/if}
  </Section>
{/if}
