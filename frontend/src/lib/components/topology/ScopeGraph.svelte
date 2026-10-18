<script lang="ts">
  import type { AgentsView } from './agents-view.svelte';
  import type { ScopeSnapshot, ScopeRoom } from '$lib/api/coordination';
  import { scopeGroups } from '$lib/topology/scope-groups';
  import { matchesQuery } from '$lib/topology/model';
  let { agents, snapshot, grouping, onroom }: { agents: AgentsView; snapshot: ScopeSnapshot; grouping: 'project' | 'host'; onroom: (room: ScopeRoom) => void } = $props();
  let collapsed = $state(new Set<string>());
  const groups = $derived(scopeGroups(agents.visibleModel.agents.map(a => a.node).filter(a => matchesQuery(a, agents.search)), snapshot.rooms, snapshot.claims, grouping));
  const placed = $derived.by(() => { let y = 12; return groups.map(g => { const height = collapsed.has(g.id) ? 56 : 76 + Math.ceil(g.agents.length / 3) * 90; const p = { ...g, y, height }; y += height + 16; return p; }); });
  const height = $derived(placed.length ? placed.at(-1)!.y + placed.at(-1)!.height + 12 : 100);
  function toggle(id: string) { const next = new Set(collapsed); if (next.has(id)) next.delete(id); else next.add(id); collapsed = next; }
</script>
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div role="region" tabindex="0" class="h-full overflow-auto" aria-label={`Agents grouped by ${grouping}`}>
  {#if agents.layout === 'list'}
    {#each groups as group (group.id)}
      <section class="mb-3 rounded-md border p-3">
        <div class="flex items-center gap-3"><button class="font-medium" onclick={() => toggle(group.id)} aria-expanded={!collapsed.has(group.id)}>{group.title} · {group.agents.length}</button>
          {#if group.conflicts}<span class="text-warning">{group.conflicts} conflicts</span>{/if}
          {#if group.room}<button class="ml-auto underline" onclick={() => onroom(group.room!)}>Open chat</button>{/if}</div>
        {#if !collapsed.has(group.id)}{#each group.agents as agent (agent.id)}<button class="block w-full rounded p-2 text-left hover:bg-muted" onclick={() => agents.select(agent.id)}>{agent.name} · {agent.engine} · {agent.host}<span class="block text-caption text-muted-foreground">{agent.task_title ?? agent.cwd}</span></button>{/each}{/if}
      </section>
    {/each}
  {:else}
    <svg viewBox={`0 0 900 ${height}`} class="w-full min-w-[40rem]" role="img" aria-label={`Agent graph grouped by ${grouping}`}>
      {#each placed as group (group.id)}
        <g transform={`translate(12 ${group.y})`}>
          <rect width="876" height={group.height} rx="12" class="fill-card stroke-border" />
          <g role="button" tabindex="0" aria-label={`Toggle ${group.title}`} aria-expanded={!collapsed.has(group.id)} onclick={() => toggle(group.id)} onkeydown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(group.id); } }}>
            <text x="18" y="32" class="fill-foreground text-sm">{collapsed.has(group.id) ? '▸' : '▾'} {group.title.length > 62 ? '…' + group.title.slice(-62) : group.title} · {group.agents.length}</text>
          </g>
          {#if group.conflicts}<text x="650" y="32" class="fill-warning text-xs">{group.conflicts} conflicts</text>{/if}
          {#if group.room}<g role="button" tabindex="0" aria-label={`Open ${group.title} chat`} onclick={() => onroom(group.room!)} onkeydown={e => { if (e.key === 'Enter') onroom(group.room!); }}><text x="785" y="32" class="fill-primary text-xs">Chat →</text></g>{/if}
          {#if !collapsed.has(group.id)}
            {#each group.agents as agent, i (agent.id)}
              {@const member = group.room?.members.find(m => m.session_id === agent.id)}
              <g transform={`translate(${18 + (i % 3) * 284} ${58 + Math.floor(i / 3) * 90})`} role="button" tabindex="0" aria-label={`${agent.name}, ${agent.engine}, ${agent.host}, ${agent.presence}`} onclick={() => agents.select(agent.id)} onkeydown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); agents.select(agent.id); } }}>
                <rect width="270" height="76" rx="8" class="fill-background" stroke={agents.selectedId === agent.id ? 'hsl(var(--primary))' : 'hsl(var(--border))'} stroke-width={agents.selectedId === agent.id ? 2 : 1}/>
                <text x="10" y="20" class="fill-foreground text-sm">{agent.name} · {agent.engine}</text>
                <text x="10" y="39" class="fill-muted-foreground text-xs">{(grouping === 'project' ? agent.host : snapshot.rooms.find(r => r.kind === 'project' && r.members.some(m => m.session_id === agent.id))?.title ?? 'Unassigned').slice(-36)}</text>
                <text x="10" y="57" class="fill-muted-foreground text-xs">{(member?.workspace?.git_root ?? agent.cwd).slice(-35)}</text>
                <text x="10" y="70" class="fill-muted-foreground" font-size="9">{agent.presence} · {member?.coordinated ? 'coordinated' : 'limited coordination'} · {snapshot.claims.filter(c => c.session_id === agent.id).length} claims</text>
                <title>{agent.task_title ?? ''} {member?.workspace?.branch ?? ''} {member?.workspace?.head_sha ?? ''}</title>
              </g>
            {/each}
          {/if}
        </g>
      {/each}
    </svg>
  {/if}
  {#if !groups.length}<p class="p-4 text-muted-foreground">No agents match these filters.</p>{/if}
</div>
