<script lang="ts">
  import { toStore } from 'svelte/store';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { authStore } from '$lib/stores/auth';
  import { api } from '$lib/api/client';
  interface Settings { enabled: boolean; engine_order: string[]; concurrency: number; queue_limit: number; steps: number; timeout_seconds: number }
  const qc = useQueryClient();
  const settings = createQuery(toStore(() => ({ queryKey: ['chatty', 'settings'], queryFn: () => api.get<Settings>('/admin/chatty/settings'), enabled: $authStore.can('chatty.manage') })));
  let busy = $state(false); let error = $state('');
  async function update(patch: Partial<Settings>) {
    if (!$settings.data) return;
    busy = true; error = '';
    try { await api.put('/admin/chatty/settings', { ...$settings.data, ...patch }); await qc.invalidateQueries({ queryKey: ['chatty'] }); }
    catch (e) { error = e instanceof Error ? e.message : 'Speichern fehlgeschlagen'; }
    finally { busy = false; }
  }
</script>
{#if $authStore.can('chatty.manage')}
  <section id="chatty" class="setting-boundary">
    <div class="setting-boundary__head"><h2>Chatty</h2><p>Persönlicher Produktassistent für Owner und Admin. Nutzt verifizierte Konten der aktivierten Engines.</p></div>
    {#if $settings.data}
      <div class="flex flex-wrap items-end gap-4 p-4">
        <label class="flex items-center gap-2"><input type="checkbox" checked={$settings.data.enabled} disabled={busy} onchange={(e) => void update({ enabled: e.currentTarget.checked })}/> Chatty aktivieren</label>
        <label class="text-sm">Automatische Priorität<select class="ml-2 rounded border bg-background p-2" value={$settings.data.engine_order.join(',')} disabled={busy} onchange={(e) => void update({ engine_order: e.currentTarget.value.split(',') })}>
          {#each ['codex,claude,grok','codex,grok,claude','claude,codex,grok','claude,grok,codex','grok,codex,claude','grok,claude,codex'] as order}<option value={order}>{order.replaceAll(',', ' → ')}</option>{/each}
        </select></label>
        <label class="text-sm">Parallele Anfragen<input aria-label="Parallele Chatty-Anfragen" class="ml-2 w-16 rounded border bg-background p-2" type="number" min="1" max="2" value={$settings.data.concurrency} disabled={busy} onchange={(e) => void update({ concurrency: Number(e.currentTarget.value) })}/></label>
      </div>
      <p class="px-4 pb-4 text-xs text-muted-foreground">Deaktivieren stoppt laufende Anfragen. Gespräche bleiben erhalten, ausgeführte Änderungen bleiben bestehen.</p>
    {/if}
    {#if error}<p role="alert" class="p-4 text-destructive">{error}</p>{/if}
  </section>
{/if}
