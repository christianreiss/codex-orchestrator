/**
 * Progress state for the first-run setup wizard.
 *
 * This exists because `setup_complete` cannot express it. That flag is
 * `criticalComplete && ownerCreated` (`setup-status.ts`), so it flips true the
 * moment the owner row lands — which is step 2 of nine. Using it to decide
 * whether the wizard is finished would dismiss the wizard before the operator
 * had answered a single question.
 *
 * `next_actions` cannot express it either. Half the wizard is opt-ins, and
 * "no, I do not want the agent portal" is a *complete* answer; a `next_action`
 * can only ever be complete-when-done, so an operator who declined every module
 * would stare at a permanently unfinished checklist.
 *
 * So: one JSON blob in the `versions` K/V table. No new table, no migration —
 * `versions.version` is `longtext`, so the blob cannot truncate. Progress
 * writes pass `publish: false` because step position is not a setting anyone
 * needs to react to, and the default `settings.changed` event fans out to
 * `[["settings"], ["skills","source"]]` in every connected admin browser.
 */

import type { Database } from '../db/client.js';
import { SettingsService } from './settings.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../util/engine.js';
import { nowIso } from '../util/timestamp.js';

export const SETUP_WIZARD_STATE_KEY = 'setup_wizard_state';

/**
 * Step ids, in order. The wizard renders these as its rail and syncs the
 * current one to `?step=`; the server only ever stores and echoes the string,
 * so adding a step here does not require a server change beyond this list.
 */
export const SETUP_WIZARD_STEPS = [
  'infrastructure',
  'owner',
  'engines',
  'auth',
  'defaults',
  'policy',
  'modules',
  'collaboration',
  'host',
] as const;

export type SetupWizardStep = (typeof SETUP_WIZARD_STEPS)[number];

export function isSetupWizardStep(value: unknown): value is SetupWizardStep {
  return typeof value === 'string' && (SETUP_WIZARD_STEPS as readonly string[]).includes(value);
}

export interface SetupWizardState {
  /** Set once the operator reaches the end. Hides the resume card for good. */
  completed_at: string | null;
  /** Set when the operator explicitly dismisses. Also hides the card. */
  dismissed_at: string | null;
  /** Where to resume. Null until the wizard has been used at all. */
  last_step: SetupWizardStep | null;
  /**
   * Which engines the operator said they run. Deliberately not
   * `DEFAULT_HOST_ENGINES` — that is env-only and needs a restart, while this
   * is a wizard answer that drives which auth panels render. An empty array is
   * a real answer ("none"), distinct from `null` ("not asked yet").
   */
  engines: Engine[] | null;
}

export interface SetupWizardUpdate {
  last_step?: SetupWizardStep;
  engines?: Engine[];
  completed?: boolean;
  dismissed?: boolean;
}

const EMPTY: SetupWizardState = {
  completed_at: null,
  dismissed_at: null,
  last_step: null,
  engines: null,
};

function parseEngines(raw: unknown): Engine[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Engine[] = [];
  for (const entry of raw) {
    if (entry !== ENGINE_CODEX && entry !== ENGINE_CLAUDE) continue;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

function parseIso(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

export class SetupWizardService {
  private readonly settings: SettingsService;

  constructor(db: Database) {
    this.settings = new SettingsService(db);
  }

  async get(): Promise<SetupWizardState> {
    const raw = await this.settings.getString(SETUP_WIZARD_STATE_KEY);
    if (raw === null || raw.trim() === '') return { ...EMPTY };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A hand-edited or truncated row must not break the console. Losing
      // wizard position is recoverable; a 500 on /admin/setup/status is not.
      return { ...EMPTY };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...EMPTY };

    const obj = parsed as Record<string, unknown>;
    return {
      completed_at: parseIso(obj.completed_at),
      dismissed_at: parseIso(obj.dismissed_at),
      last_step: isSetupWizardStep(obj.last_step) ? obj.last_step : null,
      engines: parseEngines(obj.engines),
    };
  }

  /**
   * Merge-in-place. Every field is optional so a step can record its position
   * without clobbering the engine answer three steps back.
   *
   * `completed`/`dismissed` are booleans on the way in and timestamps on the
   * way out: the wizard only needs "is it done", but an operator reading the
   * row later wants to know when.
   */
  async update(input: SetupWizardUpdate): Promise<SetupWizardState> {
    const current = await this.get();
    const next: SetupWizardState = {
      ...current,
      ...(input.last_step !== undefined ? { last_step: input.last_step } : {}),
      ...(input.engines !== undefined ? { engines: parseEngines(input.engines) ?? [] } : {}),
    };

    if (input.completed !== undefined) {
      next.completed_at = input.completed ? (current.completed_at ?? nowIso()) : null;
    }
    if (input.dismissed !== undefined) {
      next.dismissed_at = input.dismissed ? (current.dismissed_at ?? nowIso()) : null;
    }

    await this.settings.set(SETUP_WIZARD_STATE_KEY, JSON.stringify(next), { publish: false });
    return next;
  }
}

export function createSetupWizardService(db: Database): SetupWizardService {
  return new SetupWizardService(db);
}
