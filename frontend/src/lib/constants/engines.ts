/** Engine identity shared by the admin console and the operator portal. */
export const ENGINES = ["codex", "claude", "grok", "kimi"] as const;
export type Engine = (typeof ENGINES)[number];

export const ENGINE_META = {
  codex: { label: "Codex", command: "cdx", avatar: "CX", color: "bg-persona-codex" },
  claude: { label: "Claude", command: "clx", avatar: "CL", color: "bg-persona-claude" },
  grok: { label: "Grok", command: "cgx", avatar: "GX", color: "bg-persona-grok" },
  kimi: { label: "Kimi Code", command: "ckx", avatar: "KM", color: "bg-persona-kimi" },
} satisfies Record<Engine, { label: string; command: string; avatar: string; color: string }>;

export function isEngine(value: string): value is Engine {
  return ENGINES.some((engine) => engine === value);
}

export function engineLabel(value: string): string {
  return isEngine(value) ? ENGINE_META[value].label : value;
}
