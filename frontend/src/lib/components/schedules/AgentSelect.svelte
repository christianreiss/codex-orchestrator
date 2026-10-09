<script lang="ts">
 import * as Popover from '$lib/components/ui/popover';
 import * as Command from '$lib/components/ui/command';
 import type { AgentAddress } from '$lib/api/agentMessaging';
 import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
 import Check from '@lucide/svelte/icons/check';
 let { value = $bindable(''), agents }: { value: string; agents: AgentAddress[] } = $props();
 let open = $state(false);
 const selected = $derived(agents.find(agent => agent.address === value));
 const label = (agent: AgentAddress) => agent.name || agent.alias || agent.username;
</script>

<Popover.Root bind:open>
 <Popover.Trigger aria-label="Target agent" role="combobox" aria-expanded={open} class="flex min-h-11 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-left text-sm">
  <span class="min-w-0"><span class="block truncate">{selected ? label(selected) : value || 'Choose an agent'}</span>{#if selected}<span class="block truncate text-xs text-muted-foreground">{selected.engine} · {selected.fqdn ?? selected.host_id}</span>{/if}</span>
  <ChevronsUpDown class="h-4 w-4 shrink-0 text-muted-foreground"/>
 </Popover.Trigger>
 <Popover.Content class="w-[var(--bits-popover-anchor-width)] max-w-[calc(100vw-3rem)] p-0">
  <Command.Root>
   <Command.Input placeholder="Search name, alias or host…" aria-label="Search agents"/>
   <Command.List class="max-h-64 overflow-y-auto p-1">
    <Command.Empty>No matching agents.</Command.Empty>
    {#each agents as agent (agent.address)}
     <Command.Item value={agent.address} keywords={[label(agent), agent.alias ?? '', agent.username, agent.fqdn ?? '', agent.engine]} onSelect={()=>{value=agent.address; open=false;}}>
      <span class="min-w-0 flex-1"><span class="block truncate font-medium">{label(agent)}</span><span class="block truncate text-xs text-muted-foreground">{agent.engine} · {agent.fqdn ?? agent.host_id}</span></span>
      {#if value===agent.address}<Check class="h-4 w-4"/>{/if}
     </Command.Item>
    {/each}
   </Command.List>
  </Command.Root>
 </Popover.Content>
</Popover.Root>
