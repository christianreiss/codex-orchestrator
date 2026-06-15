export const ENGINE_CODEX = 'codex' as const;
export const ENGINE_CLAUDE = 'claude' as const;
export type Engine = typeof ENGINE_CODEX | typeof ENGINE_CLAUDE;
export const ENGINES: readonly Engine[] = [ENGINE_CODEX, ENGINE_CLAUDE];

export function isEngine(x: unknown): x is Engine {
  return x === ENGINE_CODEX || x === ENGINE_CLAUDE;
}

export function parseEngine(x: unknown, fallback: Engine = ENGINE_CODEX): Engine {
  return isEngine(x) ? x : fallback;
}

