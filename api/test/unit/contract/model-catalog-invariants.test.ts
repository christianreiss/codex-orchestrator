import { describe, it, expect } from 'vitest';
import {
  CLAUDE_LEGACY_MODEL_UPGRADES as CLAUDE_GATE_LEGACY_MODEL_UPGRADES,
  CLAUDE_SUPPORTED_MODELS,
} from '../../../src/services/claude-models.js';
import {
  CLAUDE_LEGACY_MODEL_UPGRADES,
  CLAUDE_MODEL_DEFAULT_REASONING_EFFORTS,
  CLAUDE_MODEL_REASONING_EFFORTS,
  CODEX_MODEL_DEFAULT_REASONING_EFFORTS,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  FORCE_UPGRADE_MODEL,
  FORCE_UPGRADE_REASONING_EFFORT,
  LEGACY_MODEL_UPGRADES,
  MODEL_REASONING_EFFORTS,
  REASONING_EFFORTS,
  SUPPORTED_MODELS,
} from '../../../src/services/config-normalizer.js';

/**
 * The model catalog is spread over two files that reference each other in
 * comments only: `config-normalizer.ts` declares its stored-override upgrade
 * map "MUST be valid gate models" from `claude-models.ts`, and both files key
 * effort tables on a model list they do not import. Nothing enforced that —
 * the per-table unit tests pin each map with a literal snapshot, which an
 * editor adding or renaming a model updates wholesale.
 *
 * The consequence is silent: an upgrade whose target left the catalog pins a
 * host to a config model the inference gate then rejects (the failure the
 * `claude-opus-4-6` / `claude-haiku-4-5` healing entries were added for), and
 * an effort table that misses a model drops its picker options and its default.
 *
 * Every relation below holds today, so this locks in current truth. Each
 * failure names the offending id: the point is to say which entry broke, not
 * that "the table changed".
 */

/** The `as const` tuple, widened so ids can be looked up by plain string. */
const CLAUDE_MODELS: readonly string[] = CLAUDE_SUPPORTED_MODELS;

/** An upgrade map, with the catalog both its keys and its values answer to. */
interface UpgradeMap {
  /** Map under test, named in the failure message. */
  map: string;
  entries: Readonly<Record<string, string>>;
  /** The catalog it upgrades onto, named in the failure message. */
  catalog: string;
  supported: readonly string[];
}

const UPGRADE_MAPS: UpgradeMap[] = [
  {
    map: 'LEGACY_MODEL_UPGRADES (config-normalizer.ts)',
    entries: LEGACY_MODEL_UPGRADES,
    catalog: 'SUPPORTED_MODELS',
    supported: SUPPORTED_MODELS,
  },
  {
    map: 'CLAUDE_LEGACY_MODEL_UPGRADES (config-normalizer.ts)',
    entries: CLAUDE_LEGACY_MODEL_UPGRADES,
    catalog: 'CLAUDE_SUPPORTED_MODELS',
    supported: CLAUDE_MODELS,
  },
  {
    map: 'CLAUDE_LEGACY_MODEL_UPGRADES (claude-models.ts)',
    entries: CLAUDE_GATE_LEGACY_MODEL_UPGRADES,
    catalog: 'CLAUDE_SUPPORTED_MODELS',
    supported: CLAUDE_MODELS,
  },
];

/** An effort table, with the catalog its key set must reproduce exactly. */
interface EffortTable {
  /** Table under test, named in the failure message. */
  table: string;
  keys: string[];
  catalog: string;
  supported: readonly string[];
}

const EFFORT_TABLES: EffortTable[] = [
  {
    table: 'MODEL_REASONING_EFFORTS',
    keys: Object.keys(MODEL_REASONING_EFFORTS),
    catalog: 'SUPPORTED_MODELS',
    supported: SUPPORTED_MODELS,
  },
  {
    table: 'CODEX_MODEL_DEFAULT_REASONING_EFFORTS',
    keys: Object.keys(CODEX_MODEL_DEFAULT_REASONING_EFFORTS),
    catalog: 'SUPPORTED_MODELS',
    supported: SUPPORTED_MODELS,
  },
  {
    table: 'CLAUDE_MODEL_REASONING_EFFORTS',
    keys: Object.keys(CLAUDE_MODEL_REASONING_EFFORTS),
    catalog: 'CLAUDE_SUPPORTED_MODELS',
    supported: CLAUDE_MODELS,
  },
  {
    table: 'CLAUDE_MODEL_DEFAULT_REASONING_EFFORTS',
    keys: Object.keys(CLAUDE_MODEL_DEFAULT_REASONING_EFFORTS),
    catalog: 'CLAUDE_SUPPORTED_MODELS',
    supported: CLAUDE_MODELS,
  },
];

/** The per-model allowed lists, paired with the defaults drawn from them. */
interface EffortPairing {
  allowedTable: string;
  allowed: Readonly<Record<string, readonly string[]>>;
  defaultsTable: string;
  defaults: Readonly<Record<string, string | null>>;
}

const EFFORT_PAIRINGS: EffortPairing[] = [
  {
    allowedTable: 'MODEL_REASONING_EFFORTS',
    allowed: MODEL_REASONING_EFFORTS,
    defaultsTable: 'CODEX_MODEL_DEFAULT_REASONING_EFFORTS',
    defaults: CODEX_MODEL_DEFAULT_REASONING_EFFORTS,
  },
  {
    allowedTable: 'CLAUDE_MODEL_REASONING_EFFORTS',
    allowed: CLAUDE_MODEL_REASONING_EFFORTS,
    defaultsTable: 'CLAUDE_MODEL_DEFAULT_REASONING_EFFORTS',
    defaults: CLAUDE_MODEL_DEFAULT_REASONING_EFFORTS,
  },
];

describe('model catalog invariants', () => {
  it('reads the tables it is meant to compare', () => {
    // Every check below is a "no violations" assertion, so a table that reads
    // as empty — after a rename, or an import that stopped resolving — would
    // pass vacuously.
    for (const { map, entries } of UPGRADE_MAPS) expect(Object.keys(entries), map).not.toEqual([]);
    for (const { table, keys } of EFFORT_TABLES) expect(keys, table).not.toEqual([]);
    expect(SUPPORTED_MODELS).toContain(DEFAULT_CODEX_MODEL);
    expect(CLAUDE_MODELS).toContain('claude-sonnet-5');
    expect(REASONING_EFFORTS).toContain(DEFAULT_CODEX_REASONING_EFFORT);
  });

  it('upgrades legacy ids onto a model its catalog still supports', () => {
    const violations = UPGRADE_MAPS.flatMap(({ map, entries, catalog, supported }) =>
      Object.entries(entries)
        .filter(([, target]) => !supported.includes(target))
        .map(([legacy, target]) => `${map} upgrades "${legacy}" to "${target}", absent from ${catalog}`),
    );
    if (!SUPPORTED_MODELS.includes(FORCE_UPGRADE_MODEL)) {
      violations.push(`FORCE_UPGRADE_MODEL is "${FORCE_UPGRADE_MODEL}", absent from SUPPORTED_MODELS`);
    }
    expect(
      violations,
      'an upgrade target outside the catalog pins hosts to a model the inference gate rejects',
    ).toEqual([]);
  });

  it('never shadows a supported id with a legacy upgrade key', () => {
    const violations = UPGRADE_MAPS.flatMap(({ map, entries, catalog, supported }) =>
      Object.keys(entries)
        .filter((legacy) => supported.includes(legacy))
        .map((legacy) => `${map} rewrites "${legacy}", which ${catalog} still lists as supported`),
    );
    expect(violations, 'drop the upgrade entry, or retire the id from the catalog').toEqual([]);
  });

  it('keys every effort table on exactly its model catalog', () => {
    const violations = EFFORT_TABLES.flatMap(({ table, keys, catalog, supported }) => [
      ...keys
        .filter((model) => !supported.includes(model))
        .map((model) => `${table} keys "${model}", which ${catalog} does not list`),
      ...supported
        .filter((model) => !keys.includes(model))
        .map((model) => `${catalog} lists "${model}", which ${table} has no entry for`),
    ]);
    expect(violations, 'add or remove the effort entry alongside the model itself').toEqual([]);
  });

  it('draws every effort from the shared tier list', () => {
    const violations = EFFORT_PAIRINGS.flatMap(({ allowedTable, allowed }) =>
      Object.entries(allowed).flatMap(([model, efforts]) =>
        efforts
          .filter((effort) => !REASONING_EFFORTS.includes(effort))
          .map((effort) => `${allowedTable} allows "${effort}" for "${model}", absent from REASONING_EFFORTS`),
      ),
    );
    expect(violations, 'an effort outside REASONING_EFFORTS is dropped on normalize').toEqual([]);
  });

  it('defaults each model to an effort that model allows', () => {
    const violations = EFFORT_PAIRINGS.flatMap(({ allowedTable, allowed, defaultsTable, defaults }) =>
      Object.entries(defaults).flatMap(([model, effort]) => {
        const efforts = allowed[model] ?? [];
        // A null default means "this model takes no effort at all", which only
        // holds if its allowed list is empty too (claude-haiku-4-5-20251001).
        if (effort === null) {
          return efforts.length === 0
            ? []
            : [`${defaultsTable} defaults "${model}" to null, but ${allowedTable} allows ${efforts.join(', ')}`];
        }
        return efforts.includes(effort)
          ? []
          : [`${defaultsTable} defaults "${model}" to "${effort}", which ${allowedTable} does not allow for it`];
      }),
    );
    expect(violations, 'a default outside the allowed list normalizes away to null').toEqual([]);
  });

  it('pins the fleet and force-upgrade efforts to their own model', () => {
    const violations: string[] = [];
    const codexDefaults = MODEL_REASONING_EFFORTS[DEFAULT_CODEX_MODEL] ?? [];
    if (!codexDefaults.includes(DEFAULT_CODEX_REASONING_EFFORT)) {
      violations.push(
        `DEFAULT_CODEX_REASONING_EFFORT is "${DEFAULT_CODEX_REASONING_EFFORT}", which MODEL_REASONING_EFFORTS does not allow for DEFAULT_CODEX_MODEL "${DEFAULT_CODEX_MODEL}"`,
      );
    }
    const forceUpgradeEfforts = MODEL_REASONING_EFFORTS[FORCE_UPGRADE_MODEL] ?? [];
    if (!forceUpgradeEfforts.includes(FORCE_UPGRADE_REASONING_EFFORT)) {
      violations.push(
        `FORCE_UPGRADE_REASONING_EFFORT is "${FORCE_UPGRADE_REASONING_EFFORT}", which MODEL_REASONING_EFFORTS does not allow for FORCE_UPGRADE_MODEL "${FORCE_UPGRADE_MODEL}"`,
      );
    }
    expect(violations, 'the force-upgrade path writes this effort verbatim, bypassing normalize').toEqual([]);
  });
});
