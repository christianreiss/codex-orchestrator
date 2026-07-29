import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CODEX_MODEL_DEFAULT_REASONING_EFFORTS,
  DEFAULT_CODEX_MODEL,
  SUPPORTED_MODELS,
} from '../../../src/services/config-normalizer.js';

/**
 * `wrappers/cdx/internal/codex/lane.go` hardcodes the model a lane preference
 * launches with — spark and normal each return a literal id from `LaneModel` —
 * and `ApplyLanePreference` injects spark's fleet default effort as a literal
 * `--config model_reasoning_effort=...`. All three are duplicates of the server
 * catalog in `config-normalizer.ts`, held together by comments only.
 *
 * The drift is one the fleet has already lived through: `CHANGELOG.md:2079`
 * records a release that dropped `gpt-5.3-codex-spark` from the allowlist. With
 * nothing pinning the wrapper, every `cdx lane spark` launch would have asked
 * for a model the inference gate rejects while the whole gate stayed green —
 * the Go side is not in the api tsconfig, so the ids cannot simply be imported.
 *
 * So the literals are read out of the Go source as text (the way
 * `wrapper-cli-surface.test.ts` reads each wrapper's dispatch switch) and
 * compared against the real API constants. Extraction throws by name when a
 * declaration moves or is renamed, so a restructured lane.go fails loudly here
 * instead of quietly comparing nothing.
 */

const LANE_FILE = 'wrappers/cdx/internal/codex/lane.go';
const LANE_PATH = resolve(import.meta.dirname, '../../../..', LANE_FILE);

const source = readFileSync(LANE_PATH, 'utf8');

/** Body of the brace-delimited block whose opening `{` is at `open`. */
const block = (open: number): string => {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && (depth -= 1) === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces at offset ${open} in ${LANE_FILE}`);
};

/**
 * Body of `func <name>`. Braces are counted literally, which holds because no
 * string or comment in lane.go carries one.
 */
const funcBody = (name: string): string => {
  const declaration = new RegExp(`\\bfunc ${name}\\([^\\n]*\\{`).exec(source);
  if (!declaration) throw new Error(`func ${name} not found in ${LANE_FILE}`);
  return block(declaration.index + declaration[0].length - 1);
};

const LANE_MODEL = funcBody('LaneModel');
const APPLY_LANE_PREFERENCE = funcBody('ApplyLanePreference');

/** The id the `case "<lane>":` arm of the `LaneModel` switch returns. */
const laneModel = (lane: string): string => {
  const arm = new RegExp(`case "${lane}":\\s*return "([^"]*)"`).exec(LANE_MODEL);
  if (!arm) throw new Error(`case "${lane}": return literal not found in LaneModel of ${LANE_FILE}`);
  return arm[1]!;
};

/** The effort `ApplyLanePreference` injects with `--config` on a spark launch. */
const injectedEffort = (): string => {
  const config = /"model_reasoning_effort=([^"]*)"/.exec(APPLY_LANE_PREFERENCE);
  if (!config) {
    throw new Error(`model_reasoning_effort= literal not found in ApplyLanePreference of ${LANE_FILE}`);
  }
  return config[1]!;
};

const SPARK_MODEL = laneModel('spark');
const NORMAL_MODEL = laneModel('normal');
const SPARK_EFFORT = injectedEffort();

describe('cdx lane model parity', () => {
  it('extracts the literals it is meant to compare', () => {
    // Extraction throws on a rename, so this only has to rule out a match that
    // reads as empty — an id of `""` is in no catalog and would fail loudly
    // below, but an empty effort would compare equal to a missing table entry.
    expect(SPARK_MODEL, 'spark lane model').not.toEqual('');
    expect(NORMAL_MODEL, 'normal lane model').not.toEqual('');
    expect(SPARK_EFFORT, 'injected spark effort').not.toEqual('');
  });

  it('launches only models the fleet still supports', () => {
    const violations = (
      [
        ['spark', SPARK_MODEL],
        ['normal', NORMAL_MODEL],
      ] as const
    )
      .filter(([, model]) => !SUPPORTED_MODELS.includes(model))
      .map(([lane, model]) => `LaneModel("${lane}") returns "${model}", absent from SUPPORTED_MODELS`);
    expect(
      violations,
      `${LANE_FILE} hardcodes lane models: an id outside SUPPORTED_MODELS makes every launch on ` +
        'that lane request a model the inference gate rejects',
    ).toEqual([]);
  });

  it('falls back to the fleet default model on the normal lane', () => {
    expect(
      NORMAL_MODEL,
      `LaneModel("normal") in ${LANE_FILE} must be DEFAULT_CODEX_MODEL (config-normalizer.ts)`,
    ).toBe(DEFAULT_CODEX_MODEL);
  });

  it("injects spark's own catalog default reasoning effort", () => {
    expect(
      CODEX_MODEL_DEFAULT_REASONING_EFFORTS[SPARK_MODEL],
      `ApplyLanePreference in ${LANE_FILE} injects model_reasoning_effort=${SPARK_EFFORT} for ` +
        `"${SPARK_MODEL}", which must be that model's CODEX_MODEL_DEFAULT_REASONING_EFFORTS entry`,
    ).toBe(SPARK_EFFORT);
  });
});
