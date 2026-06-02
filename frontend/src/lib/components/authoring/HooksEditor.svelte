<script lang="ts">
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import * as Select from "$lib/components/ui/select";
  import RepeatableList from "./RepeatableList.svelte";
  import { HOOK_EVENTS } from "$lib/constants/models";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";

  export type HookRow = { matcher: string; commands: string[] };
  export type HooksMap = Record<string, HookRow[]>;

  type Props = {
    hooks: HooksMap;
    disabled?: boolean;
  };
  let { hooks = $bindable({}), disabled = false }: Props = $props();

  // Internal flat representation so each event group is independently editable.
  type Group = { event: string; rows: HookRow[] };

  function toGroups(map: HooksMap): Group[] {
    return Object.entries(map).map(([event, rows]) => ({
      event,
      rows: rows.map((r) => ({ matcher: r.matcher ?? "", commands: [...(r.commands ?? [])] })),
    }));
  }

  function commit(groups: Group[]) {
    const next: HooksMap = {};
    for (const g of groups) {
      if (!g.event) continue;
      next[g.event] = g.rows.map((r) => ({ matcher: r.matcher, commands: [...r.commands] }));
    }
    hooks = next;
  }

  function addEvent() {
    const groups = toGroups(hooks);
    const unused = HOOK_EVENTS.find((e) => !groups.some((g) => g.event === e)) ?? HOOK_EVENTS[0];
    groups.push({ event: unused, rows: [{ matcher: "", commands: [] }] });
    commit(groups);
  }
  function removeEvent(index: number) {
    const groups = toGroups(hooks);
    groups.splice(index, 1);
    commit(groups);
  }
  function setEvent(index: number, event: string) {
    const groups = toGroups(hooks);
    groups[index].event = event;
    commit(groups);
  }
  function addRow(groupIndex: number) {
    const groups = toGroups(hooks);
    groups[groupIndex].rows.push({ matcher: "", commands: [] });
    commit(groups);
  }
  function removeRow(groupIndex: number, rowIndex: number) {
    const groups = toGroups(hooks);
    groups[groupIndex].rows.splice(rowIndex, 1);
    commit(groups);
  }
  function setMatcher(groupIndex: number, rowIndex: number, matcher: string) {
    const groups = toGroups(hooks);
    groups[groupIndex].rows[rowIndex].matcher = matcher;
    commit(groups);
  }
  function setCommands(groupIndex: number, rowIndex: number, commands: string[]) {
    const groups = toGroups(hooks);
    groups[groupIndex].rows[rowIndex].commands = commands;
    commit(groups);
  }

  const groups = $derived(toGroups(hooks));
</script>

<div class="space-y-4">
  {#each groups as group, gi (gi)}
    <div class="rounded-md border bg-muted/30 p-3">
      <div class="mb-3 flex items-center gap-2">
        <Select.Root
          type="single"
          value={group.event}
          onValueChange={(v) => v && setEvent(gi, v)}
          {disabled}
        >
          <Select.Trigger class="w-[220px]" aria-label="Hook event">
            <Select.Value placeholder="Event">{group.event}</Select.Value>
          </Select.Trigger>
          <Select.Content>
            {#each HOOK_EVENTS as event (event)}
              <Select.Item value={event} label={event}>{event}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          {disabled}
          onclick={() => removeEvent(gi)}
          aria-label="Remove event"
        >
          <Trash2 class="h-4 w-4 text-destructive" />
        </Button>
      </div>

      <div class="space-y-3">
        {#each group.rows as row, ri (ri)}
          <div class="space-y-2 rounded-md border bg-background p-2">
            <div class="flex items-center gap-2">
              <Input
                value={row.matcher}
                placeholder="matcher (e.g. Bash, Edit|Write, *)"
                {disabled}
                oninput={(e) => setMatcher(gi, ri, e.currentTarget.value)}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                {disabled}
                onclick={() => removeRow(gi, ri)}
                aria-label="Remove matcher"
              >
                <Trash2 class="h-4 w-4 text-destructive" />
              </Button>
            </div>
            <RepeatableList
              items={row.commands}
              placeholder="command to run"
              addLabel="Add command"
              {disabled}
              onItemsChange={(items) => setCommands(gi, ri, items)}
            />
          </div>
        {/each}
        <Button type="button" variant="outline" size="sm" {disabled} onclick={() => addRow(gi)}>
          <Plus class="h-4 w-4" />
          Add matcher
        </Button>
      </div>
    </div>
  {/each}
  <Button type="button" variant="outline" size="sm" {disabled} onclick={addEvent}>
    <Plus class="h-4 w-4" />
    Add event
  </Button>
</div>
