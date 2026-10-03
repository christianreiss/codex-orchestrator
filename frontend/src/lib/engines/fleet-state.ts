/**
 * The console's read of the fleet-wide engine master switches.
 *
 * Pure and import-free at runtime (type imports are erased), so `node --test`
 * can load it without the `$lib` alias or svelte-query. The store that feeds
 * it lives in `fleet-engines.ts`.
 *
 * The one rule that matters: anything short of a well-formed server answer —
 * loading, an error, a viewer without `settings.read`, a stub that returns
 * `{ status: "ok" }` — reads as "every engine enabled". The admin UI must
 * never flicker an engine off, or block an action, on a guess; the server
 * refuses a disabled engine on its own with a 409 / 403.
 */
import type { Engine } from "../constants/engines";
import type { EngineStateRow } from "../api/types";

/** Canonical engine order; mirrors `ENGINES` in `constants/engines.ts`. */
const ORDER: readonly Engine[] = ["codex", "claude", "grok"];

export interface FleetEngineView {
  /** True once the server answered with engine rows. */
  known: boolean;
  /** Enabled engines, canonical order. Every engine while unknown. */
  enabled: Engine[];
  /** Disabled engines, canonical order. Empty while unknown. */
  disabled: Engine[];
  /** The server rows as received (well-formed ones only). */
  rows: EngineStateRow[];
  isEnabled: (engine: string) => boolean;
  row: (engine: string) => EngineStateRow | null;
}

function isRow(value: unknown): value is EngineStateRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.engine === "string" && ORDER.includes(row.engine as Engine) && typeof row.enabled === "boolean";
}

export function fleetEngineView(data: unknown): FleetEngineView {
  const raw = data && typeof data === "object" ? (data as { engines?: unknown }).engines : undefined;
  const rows = Array.isArray(raw) ? raw.filter(isRow) : [];
  const off = new Set<string>(rows.filter((row) => !row.enabled).map((row) => row.engine));
  return {
    known: rows.length > 0,
    enabled: ORDER.filter((engine) => !off.has(engine)),
    disabled: ORDER.filter((engine) => off.has(engine)),
    rows,
    isEnabled: (engine) => !off.has(engine),
    row: (engine) => rows.find((row) => row.engine === engine) ?? null,
  };
}

/** Short tag for a badge or a disabled option. */
export const FLEET_DISABLED_TAG = "Disabled fleet-wide";

/** Tooltip for a control that is off because its engine is. */
export function fleetDisabledTitle(label: string): string {
  return `${label} is disabled fleet-wide. Turn it back on under Engines.`;
}
