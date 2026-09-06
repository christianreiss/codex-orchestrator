<script lang="ts">
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import * as Select from "$lib/components/ui/select";
  import RepeatableList from "./RepeatableList.svelte";
  import { HOOK_EVENTS } from "$lib/constants/models";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";

  /**
   * Wire shape, exactly as claude-cli accepts it:
   *
   *   matcher: s().optional().describe('String pattern to match ...'),
   *   hooks:   k(Et()).describe("List of hooks to execute when the matcher matches")
   *
   * This editor used to store `{ matcher, commands: string[] }`, which the CLI
   * has no key for. It matters more than a dropped field: the settings key is
   * declared `hooks: DG().optional()` with NO `.catch(void 0)` (unlike, say,
   * `effortLevel`), so a malformed entry does not degrade to "no hooks" — it
   * fails the parse of the whole settings object. Every fleet hook authored here
   * was inert, and could take the rest of settings.json down with it.
   *
   * The editor still presents one row as "a matcher plus N commands"; the
   * conversion to and from the wire shape happens at the edges below.
   */
  export type HookCommand = { type: "command"; command: string; timeout?: number };
  export type HookEntry = { matcher?: string; hooks: HookCommand[] };
  export type HooksMap = Record<string, HookEntry[]>;

  /** Editor-internal row: flattened for the UI, never stored in this shape. */
  export type HookRow = { matcher: string; commands: string[]; timeout?: number };

  type Props = {
    hooks: HooksMap;
    disabled?: boolean;
  };
  let { hooks = $bindable({}), disabled = false }: Props = $props();

  // Internal flat representation so each event group is independently editable.
  type Group = { event: string; rows: HookRow[] };

  /**
   * Wire -> editor. Also understands the pre-fix `{ matcher, commands }` rows so
   * a fleet that saved hooks under the old code still loads them here (and is
   * migrated to the correct shape the next time the form is saved).
   */
  function toGroups(map: HooksMap): Group[] {
    return Object.entries(map ?? {}).map(([event, rows]) => ({
      event,
      rows: (rows ?? []).map((r) => {
        const legacy = (r as unknown as { commands?: string[] }).commands;
        const commands = Array.isArray(r?.hooks)
          ? r.hooks.filter((h) => h?.type === "command" && typeof h.command === "string").map((h) => h.command)
          : Array.isArray(legacy)
            ? [...legacy]
            : [];
        const timeout = Array.isArray(r?.hooks)
          ? r.hooks.find((h) => typeof h?.timeout === "number")?.timeout
          : undefined;
        return { matcher: r?.matcher ?? "", commands, ...(timeout === undefined ? {} : { timeout }) };
      }),
    }));
  }

  /**
   * Editor -> wire. `matcher` is omitted rather than sent empty: it is optional
   * upstream, and events like Stop or UserPromptSubmit have no tool name to
   * match, so an empty string would be a pattern that matches nothing.
   */
  function commit(groups: Group[]) {
    const next: HooksMap = {};
    for (const g of groups) {
      if (!g.event) continue;
      next[g.event] = g.rows.map((r) => {
        const matcher = r.matcher?.trim() ?? "";
        return {
          ...(matcher === "" ? {} : { matcher }),
          hooks: r.commands.map((command) => ({
            type: "command" as const,
            command,
            ...(r.timeout === undefined ? {} : { timeout: r.timeout }),
          })),
        };
      });
    }
    hooks = next;
  }

  function addEvent() {
    const groups = toGroups(hooks);
    const unused = HOOK_EVENTS.find((e) => !groups.some((g) => g.event === e));
    if (!unused) return;
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
  <div class="divide-y border-y border-border">
    {#each groups as group, gi (gi)}
      <section class="py-4" aria-label={`Hook event ${group.event}`}>
        <div class="flex flex-wrap items-center gap-2">
        <Select.Root
          type="single"
          value={group.event}
          onValueChange={(v) => v && setEvent(gi, v)}
          {disabled}
        >
          <Select.Trigger class="w-full sm:w-[220px]" aria-label="Hook event">
            <Select.Value placeholder="Event">{group.event}</Select.Value>
          </Select.Trigger>
          <Select.Content>
            {#each HOOK_EVENTS as event (event)}
              <Select.Item
                value={event}
                label={event}
                disabled={event !== group.event && groups.some((g) => g.event === event)}
              >
                {event}
              </Select.Item>
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

        <div class="mt-3 divide-y border-t">
          {#each group.rows as row, ri (ri)}
            <div class="space-y-2 py-3">
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
        </div>
        <Button type="button" variant="outline" size="sm" class="mt-3" {disabled} onclick={() => addRow(gi)}>
          <Plus class="h-4 w-4" />
          Add matcher
        </Button>
      </section>
    {/each}
  </div>
  <Button
    type="button"
    variant="outline"
    size="sm"
    disabled={disabled || groups.length >= HOOK_EVENTS.length}
    onclick={addEvent}
  >
    <Plus class="h-4 w-4" />
    Add event
  </Button>
</div>
