/** Engine identity shared by the admin console and the operator portal. */
export const ENGINES = ["codex", "claude", "grok"] as const;
export type Engine = (typeof ENGINES)[number];

export const ENGINE_META = {
  codex: { label: "Codex", account: "ChatGPT", command: "cdx", avatar: "CX", color: "bg-persona-codex" },
  claude: { label: "Claude", account: "Claude", command: "clx", avatar: "CL", color: "bg-persona-claude" },
  grok: { label: "Grok", account: "Grok", command: "cgx", avatar: "GX", color: "bg-persona-grok" },
} satisfies Record<Engine, { label: string; account: string; command: string; avatar: string; color: string }>;

export function isEngine(value: string): value is Engine {
  return ENGINES.some((engine) => engine === value);
}

export function engineLabel(value: string): string {
  return isEngine(value) ? ENGINE_META[value].label : value;
}
