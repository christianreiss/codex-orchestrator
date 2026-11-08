/** Preserve each command object while editing surrounding hook configuration. */
export type HookCommand = { type: "command"; command: string; timeout?: number };
export type HookEntry = { matcher?: string; hooks: HookCommand[] };
export type HooksMap = Record<string, HookEntry[]>;
export type HookGroup = { event: string; rows: { matcher: string; commands: HookCommand[] }[] };
export function hookGroups(map: HooksMap): HookGroup[] {
  return Object.entries(map ?? {}).map(([event, rows]) => ({ event, rows: (rows ?? []).map(row => {
    const legacy = (row as unknown as { commands?: string[] }).commands;
    return { matcher: row.matcher ?? "", commands: Array.isArray(row.hooks)
      ? row.hooks.filter(command => command?.type === "command" && typeof command.command === "string").map(command => ({ ...command }))
      : (legacy ?? []).map(command => ({ type: "command" as const, command })) };
  }) }));
}
export function hooksFromGroups(groups: HookGroup[]): HooksMap {
  return Object.fromEntries(groups.filter(group => group.event).map(group => [group.event, group.rows.map(row => ({
    ...(row.matcher.trim() ? { matcher: row.matcher.trim() } : {}), hooks: row.commands.map(command => ({ ...command })),
  }))]));
}
