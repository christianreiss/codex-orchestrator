<script lang="ts">
  import { authStore } from '$lib/stores/auth';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { hostDaemonQuery, configureDaemon, daemonDefaults } from '$lib/api/hostDaemons';
  import { createEnableInsecureMutation } from '$lib/api/insecure';
  import DaemonIndicator from './DaemonIndicator.svelte';
  import { base } from '$app/paths';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Switch } from '$lib/components/ui/switch';
  let { id }: { id: string | number } = $props();
  // The host page keys this component by host id, retaining it across tab changes.
  // svelte-ignore state_referenced_locally
  const qc = useQueryClient(), query = hostDaemonQuery(id), save = configureDaemon(qc, id), enableAccess = createEnableInsecureMutation(qc);
  let settings = $state({ ...daemonDefaults }), dirty = $state(false);
  $effect(() => {
    if ($query.data && !dirty) {
      const { enabled, resident_enabled, username, default_cwd, max_parallel, idle_minutes, question_minutes, lifetime_minutes, expires_at } = $query.data;
      settings = { enabled, resident_enabled: resident_enabled ?? false, username, default_cwd, max_parallel, idle_minutes, question_minutes, lifetime_minutes, expires_at };
    }
  });
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    try { await $save.mutateAsync(settings); dirty = false; } catch { /* Inline mutation error. */ }
  }
  async function openAccess() {
    try { await $enableAccess.mutateAsync({ id }); await qc.invalidateQueries({ queryKey: ['host-daemons'] }); } catch { /* Inline mutation error. */ }
  }
</script>

<section class="space-y-3 rounded-lg border bg-card p-4" aria-labelledby="host-remote-heading">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h2 id="host-remote-heading" class="text-sm font-semibold">Remote sessions</h2>
    <DaemonIndicator host={$query.data}/>
  </div>
  <p class="text-xs text-muted-foreground">Keep communication and managed sync available through this host's Linux service. Remote agent starts have their own control.</p>
  {#if $query.isPending}<p role="status" class="text-sm text-muted-foreground">Loading remote settings…</p>{/if}
  {#if $query.error}<p role="alert" class="text-sm text-destructive">{$query.error.message}</p>{/if}
  {#if $query.data?.access && !$query.data.access.secure}
    <div class="flex flex-wrap items-center gap-3 rounded-md bg-muted/40 px-3 py-2 text-sm">
      <span>{$query.data.access.allowed ? `Access until ${new Date($query.data.access.enabled_until!).toLocaleString()}` : 'Access window closed'}</span>
      {#if !$query.data.access.allowed && $authStore.can('hosts.activate_insecure')}
        <Button variant="outline" size="sm" disabled={$enableAccess.isPending} onclick={openAccess}>Open access window</Button>
      {/if}
      {#if $enableAccess.error}<p role="alert" class="text-destructive">{$enableAccess.error.message}</p>{/if}
    </div>
  {/if}
  {#if $query.data?.lifetime_minutes}
    <p class="text-sm">Time limited: {$query.data.lifetime_minutes} minutes · {$query.data.expires_at ? new Date($query.data.expires_at).toLocaleString() : 'Starts on first connection'}{$query.data.deadline_expired ? ' · Expired; running work is draining.' : ''}</p>
  {/if}
  <form oninput={() => dirty = true} onsubmit={submit} class="space-y-3">
    <fieldset disabled={!$authStore.can('agent_messaging.manage') || $query.isPending || !!$query.error || $save.isPending} class="space-y-3 disabled:opacity-60">
      <div class="flex items-center justify-between gap-3 border-b pb-3">
        <div><Label for="host-communicator-resident">Keep communicator running</Label><p class="text-xs text-muted-foreground">Stay online for communication and sync without enabling remote starts.</p></div>
        <Switch id="host-communicator-resident" checked={settings.resident_enabled ?? false} onCheckedChange={(value) => { settings.resident_enabled = value; dirty = true; }}/>
      </div>
      {#if $query.data?.resident_enabled && !$query.data.residence?.runtime_enabled}<p role="status" class="text-xs text-muted-foreground">Residence requested; waiting for resident service support.</p>{/if}
      <div class="flex items-center justify-between gap-3 border-b pb-3">
        <Label for="host-daemon-enabled">Enable remote starts</Label>
        <Switch id="host-daemon-enabled" checked={settings.enabled} onCheckedChange={(value) => { settings.enabled = value; dirty = true; }}/>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="space-y-1.5"><Label for="host-daemon-user">Service account</Label><Input id="host-daemon-user" bind:value={settings.username} required /></div>
        <div class="space-y-1.5"><Label for="host-daemon-cwd">Working directory</Label><Input id="host-daemon-cwd" bind:value={settings.default_cwd} placeholder="Service account home directory" /></div>
      </div>
      <details class="border-t pt-3">
        <summary class="cursor-pointer text-sm font-medium">Advanced</summary>
        <div class="mt-3 grid gap-3 sm:grid-cols-3">
          <div class="space-y-1.5"><Label for="host-daemon-slots">Parallel slots</Label><Input id="host-daemon-slots" type="number" min="1" max="64" bind:value={settings.max_parallel}/></div>
          <div class="space-y-1.5"><Label for="host-daemon-idle">Idle timeout (minutes)</Label><Input id="host-daemon-idle" type="number" min="1" max="1440" bind:value={settings.idle_minutes}/></div>
          <div class="space-y-1.5"><Label for="host-daemon-question">Question timeout (minutes)</Label><Input id="host-daemon-question" type="number" min="1" max="10080" bind:value={settings.question_minutes}/></div>
        </div>
      </details>
    </fieldset>
    <div class="flex flex-wrap items-center gap-2">
      <Button type="submit" size="sm" disabled={!$authStore.can('agent_messaging.manage') || !dirty || $save.isPending || $query.isPending || !!$query.error}>{$save.isPending ? 'Saving…' : 'Save settings'}</Button>
      <Button variant="outline" size="sm" href={`${base}/clients?view=remote&host=${id}`}>Open remote sessions</Button>
      {#if $save.isSuccess && !dirty}<span role="status" class="text-xs text-muted-foreground">Settings saved.</span>{/if}
    </div>
    {#if $save.error}<p role="alert" class="text-sm text-destructive">{$save.error.message}</p>{/if}
  </form>
  <details class="border-t pt-3 text-xs text-muted-foreground">
    <summary class="cursor-pointer">Installation & access</summary>
    <p class="mt-2 leading-relaxed">Remote starts require fleet Agent Messaging and host access. Keeping the communicator running alone permits communication and sync. Running and waiting sessions renew an open access window until their deadline. After rollout, a root-run cxx update, wrapper sync or engine start reconciles the service; unprivileged hosts show installation pending. The existing <code>sudo cxx daemon install</code> command remains supported.</p>
    {#if $query.data?.spawn}<p class="mt-2 break-all">Provisioned by VIP host {$query.data.spawn.sourceHostId} · {$query.data.spawn.operationId}</p>{/if}
  </details>
</section>
