/**
 * Response verbosity, projected at serve time like the security posture axes.
 *
 * Level 0 is today's `response_style` module text, unchanged and never
 * injected — it is a pure no-op so an unset fleet keeps byte-identical output.
 * Levels 1-4 replace that module's `## Default Response Shape` section with
 * progressively terser wording, spliced into the policy block the same way
 * `## Standing Authorizations` is.
 *
 * The strip variants below are a CONDITIONAL retirement (only while a
 * non-zero level is active), unlike `agent-policy-legacy.ts`'s permanently
 * retired sentences, so they live here rather than there.
 */

export const RESPONSE_VERBOSITY_LEVELS = [0, 1, 2, 3, 4] as const;
export type ResponseVerbosityLevel = (typeof RESPONSE_VERBOSITY_LEVELS)[number];

export const DEFAULT_RESPONSE_VERBOSITY_LEVEL: ResponseVerbosityLevel = 0;

/** SettingsService key for the fleet-wide level (versions table, like `admin_theme`). */
export const RESPONSE_VERBOSITY_SETTINGS_KEY = 'response_verbosity_level';

/** Claude output-style slug per non-zero level (Component B). Level 0 omits the key entirely. */
export const RESPONSE_VERBOSITY_OUTPUT_STYLE_SLUGS: Partial<Record<ResponseVerbosityLevel, string>> = {
  1: 'verbosity-trimmed',
  2: 'verbosity-concise',
  3: 'verbosity-brief',
  4: 'verbosity-minimal',
};

export function normalizeResponseVerbosityLevel(input: unknown): ResponseVerbosityLevel {
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(n)) return DEFAULT_RESPONSE_VERBOSITY_LEVEL;
  const clamped = Math.max(0, Math.min(4, Math.trunc(n)));
  return clamped as ResponseVerbosityLevel;
}

interface ResponseVerbosityLevelDefinition {
  level: ResponseVerbosityLevel;
  label: string;
  bullets: { success: string; failure: string };
}

/** The exact text of today's `response_style` module, for level 0 and for the strip literal. */
export const RESPONSE_STYLE_MODULE_HEADING = '## Default Response Shape';
const LEVEL_0_MARKDOWN = `${RESPONSE_STYLE_MODULE_HEADING}

- Success: short and concise, with the clear result first. Less is more.
- Failure: explain precisely what failed or blocked progress and what remains.`;

export const RESPONSE_VERBOSITY_LEVEL_DEFINITIONS: readonly ResponseVerbosityLevelDefinition[] = [
  {
    level: 0,
    label: 'Full (today)',
    bullets: {
      success: 'short and concise, with the clear result first. Less is more.',
      failure: 'explain precisely what failed or blocked progress and what remains.',
    },
  },
  {
    level: 1,
    label: 'Trimmed',
    bullets: {
      success:
        'lead with the result immediately. No preamble, no restating the task, no closing summary. Supporting detail only where it changes what the user does next.',
      failure: 'state what failed and what remains, still without preamble.',
    },
  },
  {
    level: 2,
    label: 'Concise',
    bullets: {
      success: 'a short paragraph or up to 4 bullets, result first. Skip anything the user would only skim.',
      failure: 'up to 4 sentences — what failed, the likely cause, what remains.',
    },
  },
  {
    level: 3,
    label: 'Brief',
    bullets: {
      success: 'at most 3 sentences, result first, no elaboration unless it is load-bearing.',
      failure: 'at most 3 sentences — what failed and what remains.',
    },
  },
  {
    level: 4,
    label: 'Minimal',
    bullets: {
      success: 'no more than 2 sentences. One is preferred. No preamble, no summary, no restated task.',
      failure: 'no more than 2 sentences — what failed, what remains.',
    },
  },
] as const;

const LEVEL_DEFINITION_BY_LEVEL = new Map(RESPONSE_VERBOSITY_LEVEL_DEFINITIONS.map((d) => [d.level, d]));

/** Level label for admin UI display; level 0 included for reference. */
export function responseVerbosityLevelLabel(level: ResponseVerbosityLevel): string {
  return LEVEL_DEFINITION_BY_LEVEL.get(level)?.label ?? 'Full (today)';
}

function markdownForLevel(level: ResponseVerbosityLevel): string {
  if (level === 0) return LEVEL_0_MARKDOWN;
  const def = LEVEL_DEFINITION_BY_LEVEL.get(level);
  if (!def) return LEVEL_0_MARKDOWN;
  return `${RESPONSE_STYLE_MODULE_HEADING}\n\n- Success: ${def.bullets.success}\n- Failure: ${def.bullets.failure}`;
}

/** Overridden section markdown to splice into the policy block, or null at level 0 (no-op). */
export function renderResponseStyleOverride(level: ResponseVerbosityLevel): string | null {
  if (level === 0) return null;
  return markdownForLevel(level);
}

/**
 * Plain body text for a level, e.g. for reuse in the Claude output-style
 * documents (Component B) so the two channels never drift apart.
 */
export function responseVerbosityBodyText(level: ResponseVerbosityLevel): string {
  const def = LEVEL_DEFINITION_BY_LEVEL.get(level) ?? LEVEL_DEFINITION_BY_LEVEL.get(0)!;
  return `Keep responses ${def.label.toLowerCase()}.\n\n- Success: ${def.bullets.success}\n- Failure: ${def.bullets.failure}`;
}

/**
 * Frozen variants of the level-0 module text, one per possible neighbor
 * arrangement in `agent-policy-composer.ts`'s `\n\n---\n\n`-joined MODULES
 * list. Tried longest-first so a shorter variant can never eat a prefix of a
 * longer one. Only ever applied when a non-zero level is about to override the
 * section — an operator who disabled the `response_style` module entirely has
 * no text here to strip, and `stripResponseStyleModule` correctly no-ops.
 */
const RESPONSE_STYLE_STRIP_VARIANTS: readonly string[] = [
  // response_style followed by another module (the common case: midnight_rule).
  `${LEVEL_0_MARKDOWN}\n\n---\n\n`,
  // response_style preceded by another module and last in the list (operator
  // disabled midnight_rule).
  `\n\n---\n\n${LEVEL_0_MARKDOWN}`,
  // response_style is the only enabled module.
  LEVEL_0_MARKDOWN,
];

/**
 * Remove the static `response_style` module text from a composed base body.
 * Returns the original body unchanged (and `stripped: false`) if the exact
 * text was not found — e.g. the module is disabled — so callers know not to
 * inject a contradictory override for text that was never there.
 */
export function stripResponseStyleModule(body: string): { body: string; stripped: boolean } {
  for (const variant of RESPONSE_STYLE_STRIP_VARIANTS) {
    if (body.includes(variant)) {
      return { body: body.replace(variant, ''), stripped: true };
    }
  }
  return { body, stripped: false };
}
