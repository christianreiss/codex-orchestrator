<script lang="ts">
 import { page } from '$app/state';
 import { goto } from '$app/navigation';
 import { useQueryClient } from '@tanstack/svelte-query';
 import { toast } from 'svelte-sonner';
 import PageHeader from '$lib/components/layout/PageHeader.svelte';
 import GitDirectorSection from '$lib/components/settings/GitDirectorSection.svelte';
 import GitCommitSettingsSection from '$lib/components/settings/GitCommitSettingsSection.svelte';
 import { Button } from '$lib/components/ui/button';
 import { Badge } from '$lib/components/ui/badge';
 import { Input } from '$lib/components/ui/input';
 import * as Tabs from '$lib/components/ui/tabs';
 import * as Sheet from '$lib/components/ui/sheet';
 import { authStore } from '$lib/stores/auth';
 import { relativeTime } from '$lib/utils/format';
 import { gitDirectorClonesQuery, gitDirectorStateQuery, gitDirectorDecideMutation, gitDirectorEvictMutation, gitDirectorKeys } from '$lib/api/gitDirector';
 const stateQuery=gitDirectorStateQuery(), clones=gitDirectorClonesQuery();
 const client=useQueryClient();
 const canMutate=$derived($authStore.can('git_director.manage'));
 const tabs=['settings','activity','merges','history'];
 const tab=$derived(tabs.includes(page.url.searchParams.get('tab') ?? '') ? page.url.searchParams.get('tab')! : 'settings');
 function switchTab(value: string) { const url=new URL(page.url); url.searchParams.set('tab',value); void goto(url,{keepFocus:true,noScroll:true}); }
 let search=$state(''), open=$state(false);
 let selection=$state<{cloneId:string;kind:'worktree'|'lease'|'recent'|'stale';id:string}|null>(null);
 const rows=$derived($clones.data?.clones ?? []);
 const chosenClone=$derived(rows.find(c=>c.clone_id===selection?.cloneId));
 const worktree=$derived(chosenClone?.worktrees.find(w=>selection?.kind==='worktree' && w.worktree_id===selection.id));
 const lease=$derived(chosenClone?.leases.find(l=>selection?.kind==='lease' && l.request_id===selection.id));
 const recent=$derived(chosenClone?.recent.find(l=>selection?.kind==='recent' && l.request_id===selection.id));
 const stale=$derived(chosenClone?.stale.find(w=>selection?.kind==='stale' && w.worktree_id===selection.id));
 const request=$derived(lease ?? recent);
 function show(cloneId:string,kind:NonNullable<typeof selection>['kind'],id:string) { selection={cloneId,kind,id};open=true; }
 function matches(...values: (string|null|undefined)[]) { return values.join(' ').toLowerCase().includes(search.trim().toLowerCase()); }
 function repoName(path:string) { return path.split('/').filter(Boolean).at(-1) ?? path; }
 const groups=$derived.by(()=> {
  const map=new Map<string,typeof rows>();
  for(const c of rows) { const key=c.remote_key ?? c.clone_id; map.set(key,[...(map.get(key) ?? []),c]); }
  return [...map.values()].map(cs=>({key:cs[0].remote_key ?? cs[0].clone_id,name:repoName(cs[0].repo_root),clones:cs}));
 });
 const visible=$derived(groups.map(g=>({...g,clones:g.clones.map(c=>({...c,
  worktrees:c.worktrees.filter(w=>matches(c.repo_root,c.remote_url,c.fqdn,w.username,w.task,w.branch,w.target_branch,w.worktree_path)),
  leases:c.leases.filter(l=>{const w=c.worktrees.find(w=>w.worktree_id===l.worktree_id);return matches(c.repo_root,c.remote_url,c.fqdn,l.target_branch,l.reason,w?.username,w?.task,w?.branch,w?.worktree_path);}),
  recent:c.recent.filter(l=>{const w=c.worktrees.find(w=>w.worktree_id===l.worktree_id);return matches(c.repo_root,c.remote_url,c.fqdn,l.target_branch,l.reason,w?.username,w?.task,w?.branch,w?.worktree_path);}),
  stale:c.stale.filter(w=>matches(c.repo_root,c.remote_url,c.fqdn,w.username,w.task,w.branch,w.worktree_path)),
 })).filter(c=>tab==='activity' ? c.worktrees.length : tab==='merges' ? c.leases.length : c.recent.length+c.stale.length)})).filter(g=>g.clones.length));
 const decide=gitDirectorDecideMutation({onSuccess:()=>{open=false;toast.success('Decision saved');},onError:e=>toast.error(e.message)});
 const evict=gitDirectorEvictMutation({onSuccess:()=>{open=false;toast.success('Registration released');},onError:e=>toast.error(e.message)});
 const variant=(verdict:string)=>verdict==='allow' ? 'success' as const : verdict==='wait' ? 'warning' as const : verdict==='deny' ? 'destructive' as const : 'secondary' as const;
</script>

<PageHeader title="Git Director" subtitle="Fleet Git preferences and coordination">
 {#snippet actions()}
  <Badge variant={$stateQuery.data?.enabled ? 'success' : 'secondary'}>{$stateQuery.isPending ? 'Loading…' : $stateQuery.error ? 'Status unavailable' : $stateQuery.data?.enabled ? 'Enabled' : 'Disabled'}</Badge>
  <Button variant="outline" onclick={()=>{void client.invalidateQueries({queryKey:gitDirectorKeys.all});void client.invalidateQueries({queryKey:['settings','git-commit']});}}>Refresh</Button>
 {/snippet}
</PageHeader>
<Tabs.Root value={tab} onValueChange={switchTab}>
 <Tabs.List class="h-auto max-w-full flex-wrap justify-start" aria-label="Git Director sections">
  <Tabs.Trigger value="settings">Settings</Tabs.Trigger>
  <Tabs.Trigger value="activity">Activity</Tabs.Trigger>
  <Tabs.Trigger value="merges">Merge requests</Tabs.Trigger>
  <Tabs.Trigger value="history">History</Tabs.Trigger>
 </Tabs.List>
 <Tabs.Content value="settings">
  <div class="grid items-start gap-6 lg:grid-cols-2"><GitDirectorSection/><GitCommitSettingsSection/></div>
 </Tabs.Content>
 {#each ['activity','merges','history'] as section}
  <Tabs.Content value={section}>
   {#if tab===section}
   <div class="mb-4 flex flex-wrap items-center gap-3">
    <Input aria-label="Search Git Director" bind:value={search} placeholder="Search repository, host, user, task or branch…" class="w-full sm:max-w-md"/>
    <p class="text-xs text-muted-foreground">{section==='activity' ? 'Active worktrees' : section==='merges' ? 'Current leases and waiting requests' : 'Past decisions and released registrations'}</p>
   </div>
   {#if $clones.error}<p role="alert" class="text-sm text-destructive">{$clones.error.message}</p>{/if}
   {#if $clones.isPending}<p class="text-sm text-muted-foreground">Loading registry…</p>
   {:else if !visible.length && !$clones.error}<p class="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">{search ? 'No matching results.' : section==='activity' ? 'No active worktrees.' : section==='merges' ? 'No current merge requests.' : 'No history yet.'}</p>
   {/if}
   <div class="space-y-5">
    {#each visible as group (group.key)}
     <section class="space-y-2">
      <h2 class="text-sm font-semibold">{group.name}</h2>
      {#each group.clones as clone (clone.clone_id)}
       <div class="overflow-hidden rounded-lg border">
        <header class="bg-muted/30 px-4 py-2 text-xs text-muted-foreground"><span class="font-medium text-foreground">{clone.fqdn ?? `Host ${clone.host_id}`}</span><span class="ml-2 break-all">{clone.repo_root}</span></header>
        <div class="divide-y">
         {#if section==='activity'}
          {#each clone.worktrees as w (w.worktree_id)}
           <button class="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted/30 focus-visible:outline focus-visible:outline-ring" onclick={()=>show(clone.clone_id,'worktree',w.worktree_id)}>
            <span class="min-w-0 flex-1"><span class="block text-sm font-medium">{w.username}{w.engine ? ` · ${w.engine}` : ''}</span><span class="mt-1 block break-words text-sm text-muted-foreground">{w.task ?? 'No task declared'}</span></span>
            <span class="text-xs">{w.branch ?? 'Detached'}{w.target_branch ? ` → ${w.target_branch}` : ''}</span>
           </button>
          {/each}
         {:else if section==='merges'}
          {#each clone.leases as l (l.request_id)}
           <button class="flex w-full flex-wrap items-start gap-3 px-4 py-3 text-left hover:bg-muted/30 focus-visible:outline focus-visible:outline-ring" onclick={()=>show(clone.clone_id,'lease',l.request_id)}>
            <Badge variant={variant(l.verdict)}>{l.verdict}</Badge><span class="min-w-0 flex-1"><span class="block text-sm font-medium">{l.target_branch}</span><span class="mt-1 block text-xs text-muted-foreground">{l.reason ?? 'No reason recorded'}</span></span>
           </button>
          {/each}
         {:else}
          {#each clone.recent as r (r.request_id)}
           <button class="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 focus-visible:outline focus-visible:outline-ring" onclick={()=>show(clone.clone_id,'recent',r.request_id)}><Badge variant={variant(r.verdict)}>{r.verdict}</Badge><span class="flex-1 text-sm">{r.target_branch}</span><span class="text-xs text-muted-foreground">{relativeTime(r.requested_at)}</span></button>
          {/each}
          {#each clone.stale as w (w.worktree_id)}
           <button class="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 focus-visible:outline focus-visible:outline-ring" onclick={()=>show(clone.clone_id,'stale',w.worktree_id)}><Badge variant="secondary">{w.status==='superseded' ? 'Reassigned' : w.status==='abandoned' ? 'Session ended' : 'Went quiet'}</Badge><span class="min-w-0 flex-1 text-sm">{w.username} · {w.task ?? repoName(w.worktree_path)}</span><span class="text-xs text-muted-foreground">{relativeTime(w.last_seen_at)}</span></button>
          {/each}
         {/if}
        </div>
       </div>
      {/each}
     </section>
    {/each}
   </div>
   {/if}
  </Tabs.Content>
 {/each}
</Tabs.Root>
<Sheet.Root bind:open>
 <Sheet.Content class="w-full overflow-y-auto sm:max-w-[560px]">
  <Sheet.Header class="pr-8"><Sheet.Title>{worktree ? 'Worktree details' : request ? 'Merge decision' : stale ? 'Released registration' : 'Details unavailable'}</Sheet.Title><Sheet.Description>{chosenClone ? `${repoName(chosenClone.repo_root)} · ${chosenClone.fqdn ?? chosenClone.host_id}` : 'This record may have expired or been released.'}</Sheet.Description></Sheet.Header>
  <div class="mt-5 space-y-4 text-sm">
   {#if chosenClone}<p class="break-all text-xs text-muted-foreground">{chosenClone.remote_url ?? 'No remote'}<br/>{chosenClone.repo_root}</p>{/if}
   {#if worktree}
    <p class="font-medium">{worktree.username} · {worktree.engine ?? 'Unknown engine'}</p><p>{worktree.task ?? 'No task declared'}</p>
    <p>{worktree.branch ?? 'Detached'} → {worktree.target_branch ?? 'No target branch'}</p>
    <p class="break-all font-mono text-xs">{worktree.worktree_path}<br/>{worktree.head_sha}</p>
    <div><h3 class="font-medium">Declared paths</h3>{#each worktree.declared_paths as path}<p class="break-all font-mono text-xs">{path}</p>{:else}<p class="text-muted-foreground">None declared.</p>{/each}</div>
    <p class="text-xs text-muted-foreground">Heartbeat {relativeTime(worktree.heartbeat_at)} · expires {relativeTime(worktree.expires_at)} · {worktree.agent_address_bound ? 'Addressable' : 'No agent address bound'}</p>
    {#if canMutate}<Button variant="outline" disabled={$evict.isPending} onclick={()=>$evict.mutate(worktree.worktree_id)}>Release registration</Button><p class="text-xs text-muted-foreground">Also frees its held leases.</p>{/if}
   {:else if request}
    <Badge variant={variant(request.verdict)}>{request.verdict}</Badge><h3 class="font-medium">{request.target_branch}</h3><p>{request.reason ?? 'No reason recorded'}</p>
    <p class="break-all font-mono text-xs">{chosenClone?.worktrees.find(w=>w.worktree_id===request.worktree_id)?.worktree_path ?? request.worktree_id}</p>
    <div><h3 class="font-medium">Overlapping paths</h3>{#each request.overlap as path}<p class="break-all font-mono text-xs">{path}</p>{:else}<p class="text-muted-foreground">No overlap recorded.</p>{/each}</div>
    <p class="text-xs text-muted-foreground">Decided by {request.decided_by==='llm' ? 'arbiter' : request.decided_by} · requested {relativeTime(request.requested_at)}{recent?.model ? ` · ${recent.model}` : ''}</p>
    {#if request.lease_expires_at}<p class="text-xs text-muted-foreground">Lease expires {relativeTime(request.lease_expires_at)}</p>{/if}
    {#if lease && canMutate}<div class="flex gap-2"><Button variant="outline" disabled={$decide.isPending} onclick={()=>$decide.mutate({id:lease.request_id,verdict:'allow'})}>Force allow</Button><Button variant="destructive" disabled={$decide.isPending} onclick={()=>$decide.mutate({id:lease.request_id,verdict:'deny'})}>Deny</Button></div>{/if}
   {:else if stale}
    <p>{stale.username} · {stale.engine ?? 'Unknown engine'} · {stale.status}</p><p>{stale.task ?? 'No task declared'}</p><p class="break-all font-mono text-xs">{stale.worktree_path}</p><p>{stale.branch ?? 'Detached'}</p><p class="text-xs text-muted-foreground">Last seen {relativeTime(stale.last_seen_at)}{stale.released_at ? ` · released ${relativeTime(stale.released_at)}` : ''}</p>
   {/if}
  </div>
 </Sheet.Content>
</Sheet.Root>
