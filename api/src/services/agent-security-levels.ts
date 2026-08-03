/**
 * Graduated fleet security posture.
 *
 * The policy document used to be built from booleans: a rule was present or
 * absent, and the three mandatory sections were one frozen template literal
 * that nothing an operator set could reach. This module replaces that with
 * nine 0-4 axes and an operation matrix.
 *
 * The central idea is that a level never changes how an action is *worded* —
 * it changes which of three buckets the action sits in:
 *
 *   forbid -> the safety-floor sentence
 *   ask    -> a Hard Stop Lines bullet
 *   allow  -> a Standing Authorizations bullet
 *
 * Every operation declares exactly one owning axis, so no two axes can speak
 * about the same action. That is what makes the document's old failure mode —
 * forbidding remote mutation in the mandatory prefix while a module discussed
 * permitting it — structurally unrepresentable rather than merely fixed.
 *
 * `gate_ask <= gate_allow` on every row means raising a slider can only ever
 * move an operation rightward (forbid -> ask -> allow), so raising a level can
 * never remove a permission. `policy-topic-ownership.test.ts` and the
 * monotonicity tests pin both properties.
 *
 * Nothing here reads the database or the composition. Posture is resolved per
 * host at serve time and rendered into the managed block, which is regenerated
 * from code on every serve — unlike the canonical base, which is a frozen
 * snapshot in `agents_documents.body` and would never reach an existing fleet.
 */
import { ValidationError } from '../http/errors.js';

export const SECURITY_LEVELS = [0, 1, 2, 3, 4] as const;
export type SecurityLevel = (typeof SECURITY_LEVELS)[number];

export const SECURITY_AXIS_IDS = [
  'autonomy',
  'git_history',
  'remote_hosts',
  'deploy_release',
  'destructive_data',
  'secrets_exposure',
  'security_controls',
  'dependencies',
  'verification_waiver',
] as const;

export type SecurityAxisId = (typeof SECURITY_AXIS_IDS)[number];
export type SecurityLevels = Record<SecurityAxisId, SecurityLevel>;

/**
 * How a level is enforced, if at all. `prose_only` is not a lesser status — it
 * is a promise the UI must keep, because an operator who believes an axis is
 * mechanically enforced when it is not has been lied to.
 */
export type AxisEnforcement = 'mechanical' | 'partial' | 'prose_only';

export interface AxisSpec {
  id: SecurityAxisId;
  label: string;
  description: string;
  enforcement: AxisEnforcement;
  /** What each level means, for the slider's tick labels. Always five. */
  bands: readonly [string, string, string, string, string];
}

/**
 * One band vocabulary for all nine axes, so a level means the same thing
 * wherever the operator reads it.
 *
 * `Announce` is an authorization shape (act without waiting, but say first),
 * not a reporting format. It ungrants nothing, so it is not a floor smuggled
 * back in at level 3.
 */
export const SECURITY_BANDS = ['Refuse', 'Ask', 'On request', 'Announce', 'Proceed'] as const;

export const AXES: readonly AxisSpec[] = [
  {
    id: 'autonomy',
    label: 'Working without asking',
    description: 'How much the agent proceeds on its own when the request is ambiguous.',
    enforcement: 'mechanical',
    bands: [
      'Confirm every step',
      'Ask whenever unsure',
      'Ask only at a Hard Stop',
      'State the assumption and proceed',
      'No check-ins',
    ],
  },
  {
    id: 'git_history',
    label: 'Git and other people’s work',
    description: 'Staging, committing, branching, force-pushing, and preserving concurrent changes.',
    enforcement: 'partial',
    bands: [
      'Read-only, no staging',
      'Stage and commit on task paths',
      'Commit freely',
      'Push non-default branches',
      'Force-push and rewrite history',
    ],
  },
  {
    id: 'remote_hosts',
    label: 'Remote hosts',
    description: 'SSH access, remote mutation, and host-key verification.',
    enforcement: 'partial',
    bands: [
      'No remote access',
      'Connect and diagnose read-only',
      'Task-relevant remote writes',
      'Remote service and config changes',
      'Full remote mutation',
    ],
  },
  {
    id: 'deploy_release',
    label: 'Deploy and release',
    description: 'Deploying, publishing, sending, production restarts and migrations.',
    enforcement: 'partial',
    bands: [
      'Never',
      'Prepare only, never execute',
      'Deploy when the request covers it',
      'Deploy non-production freely',
      'Deploy and migrate production unasked',
    ],
  },
  {
    id: 'destructive_data',
    label: 'Destructive and irreversible',
    description: 'Operations that lose data or cannot be undone.',
    enforcement: 'mechanical',
    bands: [
      'Never',
      'Reversible deletes only',
      'Delete when the request covers it',
      'Delete task-owned data freely',
      'Any destructive operation',
    ],
  },
  {
    id: 'secrets_exposure',
    label: 'Secret values in output',
    description: 'Whether credential values may reach replies, files, logs, or commits.',
    enforcement: 'partial',
    bands: [
      'Never read the store',
      'Use via env or stdin, never write',
      'Store and rotate host-owned secrets',
      'Write values into configs when required',
      'Values may appear anywhere',
    ],
  },
  {
    id: 'security_controls',
    label: 'Weakening security controls',
    description:
      'Changing auth, TLS, authorization, sandboxing, or verification of the system under work. Neither engine exposes a knob for this, so it changes the policy text only.',
    enforcement: 'prose_only',
    bands: [
      'Never weaken anything',
      'Relax in throwaway environments only',
      'Relax non-production for a task',
      'Weaken to unblock, and report it',
      'Reconfigure security freely',
    ],
  },
  {
    id: 'dependencies',
    label: 'Dependencies and network',
    description: 'New network calls, telemetry, unpinned dependencies, and piped installers.',
    enforcement: 'mechanical',
    bands: [
      'No network installs',
      'Pinned, reviewable dependencies',
      'Add dependencies freely, pinned',
      'Unpinned dependencies and arbitrary registries',
      'Piped installers and arbitrary remote code',
    ],
  },
  {
    id: 'verification_waiver',
    label: 'Skipping verification',
    description:
      'How much of the checks, docs, and changelog the agent may skip before claiming done. Named as a waiver so it runs the same direction as every other axis: higher means more latitude, not more rigor.',
    enforcement: 'prose_only',
    bands: [
      'Never skip',
      'Skip only unrelated checks',
      'Skip when told',
      'Skip by default, disclose it',
      'Skip freely',
    ],
  },
] as const;

const AXIS_BY_ID = new Map<SecurityAxisId, AxisSpec>(AXES.map((axis) => [axis.id, axis]));

// ────────────────────────────────────────────────────────────────────────────
// Operation matrix
// ────────────────────────────────────────────────────────────────────────────

export type Stance = 'forbid' | 'ask' | 'allow';

/**
 * `topic` is what the ownership lint keys on: two operations may share a topic
 * only if they share an axis. It is what stops "push" being discussed by both
 * `git_history` and `deploy_release`.
 */
export type TopicId =
  | 'proceed'
  | 'target_identification'
  | 'commit'
  | 'push'
  | 'concurrent_work'
  | 'remote_access'
  | 'remote_mutation'
  | 'host_key'
  | 'deploy'
  | 'production'
  | 'data_loss'
  | 'secret_read'
  | 'secret_write'
  | 'secret_value'
  | 'weaken'
  | 'privilege'
  | 'supply_chain'
  | 'telemetry'
  | 'verification';

/**
 * Some operations are noun fragments that only read correctly when composed
 * into a shared bullet — today's document says "It creates an external side
 * effect ...: push, deploy, publish, send, production restart, production
 * migration, or remote mutation" as ONE bullet spanning three axes. Rendering
 * those fragments as standalone bullets produces a document that says "- push".
 *
 * A group collects them under one lead-in. `rank` fixes the order inside the
 * list independently of registry order, so the sentence reads the way it reads
 * today rather than the way the axes happen to be declared.
 */
export interface OperationGroup {
  id: string;
  lead: string;
  rank: number;
}

export interface PolicyOperation {
  id: string;
  axis: SecurityAxisId;
  topic: TopicId;
  /** Lowest level at which this is ASK rather than FORBID. */
  gate_ask: SecurityLevel;
  /** Lowest level at which this is ALLOW. Must be >= gate_ask. */
  gate_allow: SecurityLevel;
  /** When set, the `ask` phrase is a noun fragment composed into a shared bullet. */
  group?: OperationGroup;
  phrase: Record<Stance, string>;
}

const EXTERNAL_SIDE_EFFECT = (rank: number): OperationGroup => ({
  id: 'external_side_effect',
  lead: 'It creates an external side effect not clearly included in the user’s request:',
  rank,
});

const SECURITY_BYPASS = (rank: number): OperationGroup => ({
  id: 'security_bypass',
  lead: 'It requires',
  rank,
});

/**
 * The Standard preset must reproduce today's document, so the gates below are
 * chosen against it rather than for tidiness. Where today's text stops and
 * asks, the Standard level must land on `ask`; where it says "proceed", on
 * `allow`. The golden render test is what holds this honest.
 */
export const POLICY_OPERATIONS: readonly PolicyOperation[] = [
  // ── autonomy ──────────────────────────────────────────────────────────────
  {
    id: 'autonomy.proceed_on_ambiguity',
    axis: 'autonomy',
    topic: 'proceed',
    gate_ask: 1,
    gate_allow: 3,
    phrase: {
      forbid: 'Confirm each step before acting; do not batch work behind one approval.',
      ask: 'Ask whenever the lowest-risk reading of the request is genuinely unclear.',
      allow: 'State the lowest-risk assumption in one line and proceed.',
    },
  },
  {
    id: 'autonomy.target_identification',
    axis: 'autonomy',
    topic: 'target_identification',
    gate_ask: 0,
    gate_allow: 4,
    phrase: {
      forbid: 'acting on a target that cannot be identified safely',
      ask: 'The target repository, host, environment, account, database, or dataset cannot be identified safely and choosing incorrectly has material blast radius.',
      allow: 'Pick the most likely target when identification is uncertain, and name the one you chose.',
    },
  },
  {
    id: 'autonomy.multiple_outcomes',
    axis: 'autonomy',
    topic: 'proceed',
    gate_ask: 0,
    gate_allow: 4,
    phrase: {
      forbid: 'choosing between materially different product or business outcomes',
      ask: 'Multiple materially different product or business outcomes are valid and no low-risk reversible default exists.',
      allow: 'Choose between valid product outcomes without checking in, and say which you chose.',
    },
  },

  // ── git_history ───────────────────────────────────────────────────────────
  {
    id: 'git.commit',
    axis: 'git_history',
    topic: 'commit',
    gate_ask: 0,
    gate_allow: 2,
    phrase: {
      forbid: 'committing anything',
      ask: 'Committing requires explicit authorization; stage only task-owned paths and never `git add .` or `git add -A`.',
      allow: 'Commit task-owned paths without asking. Never `git add .` or `git add -A`.',
    },
  },
  {
    id: 'git.push',
    axis: 'git_history',
    topic: 'push',
    gate_ask: 1,
    gate_allow: 3,
    group: EXTERNAL_SIDE_EFFECT(0),
    phrase: {
      forbid: 'pushing to any remote',
      ask: 'push',
      allow: 'Push to non-default branches without asking.',
    },
  },
  {
    id: 'git.rewrite_history',
    axis: 'git_history',
    topic: 'push',
    gate_ask: 3,
    gate_allow: 4,
    phrase: {
      forbid: 'force-pushing or rewriting published history',
      ask: 'Force-pushing or rewriting published history needs explicit authorization.',
      allow: 'Force-push and rewrite history when the task calls for it.',
    },
  },
  {
    id: 'git.concurrent_work',
    axis: 'git_history',
    topic: 'concurrent_work',
    gate_ask: 0,
    gate_allow: 4,
    phrase: {
      forbid: 'discarding concurrent changes',
      ask: 'Existing concurrent changes cannot be preserved safely.',
      allow: 'Resolve conflicting concurrent changes as the task requires.',
    },
  },

  // ── remote_hosts ──────────────────────────────────────────────────────────
  {
    id: 'remote.connect',
    axis: 'remote_hosts',
    topic: 'remote_access',
    gate_ask: 0,
    gate_allow: 1,
    phrase: {
      forbid: 'connecting to remote hosts',
      ask: 'Connecting to a remote host needs an explicit target from the user.',
      allow: 'An explicit `ssh user@host` authorizes connecting and task-relevant read-only diagnosis without another confirmation.',
    },
  },
  {
    id: 'remote.mutate',
    axis: 'remote_hosts',
    topic: 'remote_mutation',
    gate_ask: 1,
    gate_allow: 2,
    group: EXTERNAL_SIDE_EFFECT(3),
    phrase: {
      forbid: 'mutating anything on a remote host',
      ask: 'remote mutation',
      allow: 'Make task-relevant changes on an explicitly named remote host, and say what you changed.',
    },
  },
  {
    id: 'remote.host_key',
    axis: 'remote_hosts',
    topic: 'host_key',
    gate_ask: 4,
    gate_allow: 4,
    phrase: {
      forbid: 'disabling SSH host-key verification',
      ask: 'Disabling SSH host-key verification needs explicit authorization.',
      allow: 'Disable SSH host-key verification when a task requires it.',
    },
  },

  // ── deploy_release ────────────────────────────────────────────────────────
  {
    id: 'deploy.release',
    axis: 'deploy_release',
    topic: 'deploy',
    gate_ask: 1,
    gate_allow: 3,
    group: EXTERNAL_SIDE_EFFECT(1),
    phrase: {
      forbid: 'deploying, publishing, or sending anything outward',
      ask: 'deploy, publish, send',
      allow: 'Deploy and publish to non-production targets without asking.',
    },
  },
  {
    id: 'deploy.production',
    axis: 'deploy_release',
    topic: 'production',
    gate_ask: 1,
    gate_allow: 4,
    group: EXTERNAL_SIDE_EFFECT(2),
    phrase: {
      forbid: 'restarting or migrating production',
      ask: 'production restart, production migration',
      allow: 'Restart and migrate production without asking, and report what ran.',
    },
  },

  // ── destructive_data ──────────────────────────────────────────────────────
  {
    id: 'destructive.irreversible',
    axis: 'destructive_data',
    topic: 'data_loss',
    gate_ask: 1,
    gate_allow: 3,
    phrase: {
      forbid: 'destructive or irreversible operations',
      ask: 'The next action is destructive or irreversible, or may lose user, production, or previously existing data.',
      allow: 'Delete or overwrite task-owned data without asking; say what was removed and how to restore it.',
    },
  },

  // ── secrets_exposure ──────────────────────────────────────────────────────
  {
    id: 'secrets.read',
    axis: 'secrets_exposure',
    topic: 'secret_read',
    gate_ask: 0,
    gate_allow: 1,
    phrase: {
      forbid: 'reading the credential store',
      ask: 'Reading a credential from the store needs explicit authorization.',
      allow: 'Read credentials from the store when a task needs them, preferring a tool-native secret parameter, stdin, or a process-scoped environment variable.',
    },
  },
  {
    id: 'secrets.write_store',
    axis: 'secrets_exposure',
    topic: 'secret_write',
    gate_ask: 1,
    gate_allow: 2,
    phrase: {
      forbid: 'creating or rotating credentials',
      ask: 'Creating, rotating, or retiring a credential needs explicit user intent and the supplied value.',
      allow: 'Create, rotate, and retire credentials this host owns when the task requires it.',
    },
  },
  {
    id: 'secrets.emit_in_output',
    axis: 'secrets_exposure',
    topic: 'secret_value',
    gate_ask: 3,
    gate_allow: 4,
    phrase: {
      forbid: 'disclosing credentials',
      ask: 'Writing a secret value into a reply, commit, log, or file needs explicit authorization for that specific destination.',
      allow: 'Write secret values wherever the task requires, including replies, files, logs, and commits.',
    },
  },

  // ── security_controls ─────────────────────────────────────────────────────
  {
    id: 'security.weaken_controls',
    axis: 'security_controls',
    topic: 'weaken',
    gate_ask: 1,
    gate_allow: 3,
    group: SECURITY_BYPASS(0),
    phrase: {
      forbid: 'security weakening',
      ask: 'weakening security, bypassing verification',
      allow: 'Weaken authentication, TLS, authorization, or verification when the task requires it, and say so.',
    },
  },
  {
    id: 'security.escalate_privilege',
    axis: 'security_controls',
    topic: 'privilege',
    gate_ask: 1,
    gate_allow: 4,
    group: SECURITY_BYPASS(1),
    phrase: {
      forbid: 'escalating privileges',
      ask: 'escalating privileges beyond the task’s clear intent',
      allow: 'Escalate privileges as the task requires.',
    },
  },

  // ── dependencies ──────────────────────────────────────────────────────────
  {
    id: 'deps.install',
    axis: 'dependencies',
    topic: 'supply_chain',
    gate_ask: 0,
    gate_allow: 1,
    phrase: {
      forbid: 'installing dependencies or reaching the network',
      ask: 'Adding a dependency needs explicit authorization.',
      allow: 'Prefer pinned, reviewable dependencies. Avoid `curl | sh` installers.',
    },
  },
  {
    id: 'deps.unreviewed_code',
    axis: 'dependencies',
    topic: 'supply_chain',
    gate_ask: 3,
    gate_allow: 4,
    phrase: {
      forbid: 'running unpinned or unreviewed remote code',
      ask: 'Running unpinned or unreviewed remote code needs explicit authorization.',
      allow: 'Run piped installers and unpinned remote code when the task calls for it.',
    },
  },
  {
    id: 'deps.telemetry',
    axis: 'dependencies',
    topic: 'telemetry',
    gate_ask: 2,
    gate_allow: 4,
    phrase: {
      forbid: 'adding telemetry or phone-home behaviour',
      ask: 'Do not add telemetry, new network calls, or phone-home dependencies unless explicitly requested.',
      allow: 'Add telemetry and outbound network calls as the task requires.',
    },
  },

  // ── verification_waiver ───────────────────────────────────────────────────
  {
    id: 'verification.skip_checks',
    axis: 'verification_waiver',
    topic: 'verification',
    gate_ask: 2,
    gate_allow: 3,
    phrase: {
      forbid: 'claiming success without running the canonical repository checks',
      ask: 'Skipping the canonical repository checks needs explicit authorization.',
      allow: 'Skip verification by default; state plainly what was not run.',
    },
  },
] as const;

export function stanceFor(op: PolicyOperation, level: SecurityLevel): Stance {
  if (level >= op.gate_allow) return 'allow';
  if (level >= op.gate_ask) return 'ask';
  return 'forbid';
}

// ────────────────────────────────────────────────────────────────────────────
// Presets
// ────────────────────────────────────────────────────────────────────────────

function vector(values: readonly SecurityLevel[]): SecurityLevels {
  const out = {} as SecurityLevels;
  SECURITY_AXIS_IDS.forEach((id, index) => {
    out[id] = values[index] ?? 0;
  });
  return out;
}

export interface SecurityPreset {
  id: string;
  label: string;
  description: string;
  levels: SecurityLevels;
}

/**
 * Presets are vectors, not a single number: today's policy is permissive on
 * autonomy and strict on deploy, so a row of 2s would be a behavior change
 * wearing the name "Standard".
 *
 * The strictest preset is deliberately NOT called "Locked" — `AGENTS_MODE_LOCKED`
 * already means "pin to a document version", and a console showing both would
 * be genuinely confusing.
 */
export const SECURITY_PRESETS: readonly SecurityPreset[] = [
  {
    id: 'contained',
    label: 'Contained',
    description: 'Refuses every privileged action. Diagnosis and reading only.',
    levels: vector([0, 0, 0, 0, 0, 0, 0, 0, 0]),
  },
  {
    id: 'standard',
    label: 'Standard',
    description: 'Today’s fleet policy: autonomous on reversible work, stops at every external side effect.',
    levels: vector([3, 1, 1, 1, 1, 1, 1, 1, 0]),
  },
  {
    id: 'trusted',
    label: 'Trusted',
    description: 'Commits and pushes freely, makes remote and non-production changes without asking.',
    levels: vector([4, 3, 3, 2, 2, 2, 1, 2, 1]),
  },
  {
    id: 'unrestricted',
    label: 'Unrestricted',
    description:
      'Every axis granted, including production deploys, destructive operations, secret values in output, and reconfiguring security controls.',
    levels: vector([4, 4, 4, 4, 4, 4, 4, 4, 4]),
  },
] as const;

const PRESET_BY_ID = new Map(SECURITY_PRESETS.map((preset) => [preset.id, preset]));

export const DEFAULT_SECURITY_LEVELS: SecurityLevels = PRESET_BY_ID.get('standard')!.levels;

/** The preset this vector matches exactly, or null when it has been nudged. */
export function matchingPreset(levels: SecurityLevels): SecurityPreset | null {
  return (
    SECURITY_PRESETS.find((preset) =>
      SECURITY_AXIS_IDS.every((id) => preset.levels[id] === levels[id]),
    ) ?? null
  );
}

/** Axes that differ from the named preset, for the console's "modified: N axes". */
export function axesModifiedFrom(presetId: string, levels: SecurityLevels): SecurityAxisId[] {
  const preset = PRESET_BY_ID.get(presetId);
  if (!preset) return [];
  return SECURITY_AXIS_IDS.filter((id) => preset.levels[id] !== levels[id]);
}

// ────────────────────────────────────────────────────────────────────────────
// Normalization
// ────────────────────────────────────────────────────────────────────────────

function isSecurityLevel(value: unknown): value is SecurityLevel {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4;
}

/**
 * Tolerant in the same shape as `normalizeAgentPolicyComposition`: unknown axes
 * are dropped rather than rejected, missing axes fall back to Standard, and a
 * value that is present but not a 0-4 integer is a hard error rather than a
 * silent coercion — a typo'd level must not quietly become "Refuse" or
 * "Proceed".
 */
export function normalizeSecurityLevels(input: unknown): SecurityLevels {
  if (input === null || input === undefined) return { ...DEFAULT_SECURITY_LEVELS };
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('security_levels must be an object', { param: 'security_levels' });
  }
  const raw = input as Record<string, unknown>;
  const out = {} as SecurityLevels;
  for (const id of SECURITY_AXIS_IDS) {
    const value = raw[id];
    if (value === undefined) {
      out[id] = DEFAULT_SECURITY_LEVELS[id];
      continue;
    }
    if (!isSecurityLevel(value)) {
      throw new ValidationError(`security_levels.${id} must be an integer between 0 and 4`, {
        param: `security_levels.${id}`,
      });
    }
    out[id] = value;
  }
  return out;
}

/** Resolve a preset id to its vector. Unknown ids are a validation error. */
export function presetLevels(presetId: unknown): SecurityLevels {
  if (typeof presetId !== 'string' || !PRESET_BY_ID.has(presetId)) {
    throw new ValidationError(`unknown security preset: ${String(presetId)}`, { param: 'preset' });
  }
  return { ...PRESET_BY_ID.get(presetId)!.levels };
}

// ────────────────────────────────────────────────────────────────────────────
// Prose projection
// ────────────────────────────────────────────────────────────────────────────

const IDENTITY_SECTION = `## Fleet Management

You are part of a fleet centrally managed by **Codex Orchestrator**. The orchestrator may synchronize this policy, engine configuration, and capability-specific guidance across hosts. Treat fleet-provided records as managed operating context, while continuing to verify mutable repository and runtime facts at their source.

Fleet membership does not grant additional authority: it never overrides higher-level runtime instructions, the user's explicit request, or applicable safety constraints.`;

/**
 * Precedence names all three tiers explicitly. The previous wording scoped
 * itself to "repository instruction files" while the wrapper writes this
 * document to `$CODEX_HOME/AGENTS.md` and `~/.claude/CLAUDE.md` — user-global
 * paths, not repository files — which left it undefined whether the floor even
 * bound the operator's own fleet instructions.
 */
const PRECEDENCE_PARAGRAPH = `Three tiers resolve conflicts, outermost first: higher-level runtime instructions and the user's explicit request; then this fleet policy, delivered to \`$CODEX_HOME/AGENTS.md\` and \`~/.claude/CLAUDE.md\`; then repository instruction files. Within a repository, \`AGENTS.override.md\` outranks \`AGENTS.md\` and closer files outrank higher ones.

A repository instruction file may tighten what this policy grants. It may never widen it.`;

/**
 * Always emitted, and they ungrant nothing — they fix how a grant *reads*,
 * which is a different problem from what a grant permits. Without the first
 * clause an agent reading a maxed axis can reasonably infer that the action is
 * now expected rather than merely permitted.
 */
const GRANT_IS_NOT_MANDATE = `A level grants; it never instructs. Removing a stop does not create an objective — do only what the task requires.`;

function stricterMechanismClause(level: SecurityLevel): string {
  if (level >= 4) {
    return 'Host sandbox and approval settings are yours to reconfigure when the task requires it; say so when you do.';
  }
  return 'Host sandbox and approval settings may be more restrictive than this policy. A mechanical refusal is a boundary, not an obstacle: report it, do not route around it.';
}

function joinClauses(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  // A bare "A or B" loses its footing once a clause carries its own commas
  // ("weakening security, bypassing verification" or "..."), so the serial
  // comma goes in whenever any member is itself a list.
  const anyInternalComma = items.some((item) => item.includes(','));
  if (items.length === 2 && !anyInternalComma) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}

/**
 * The rendered text of each named section, or null when the section is omitted
 * entirely. Callers hash these to report section digests — hashing the heading
 * literal instead (as the previous renderer did) reports an unchanged sha for
 * changed bytes, which is harmless only while the text is a constant.
 */
export interface RenderedPolicySections {
  fleet_identity: string | null;
  safety_floor: string | null;
  hard_stops: string | null;
  standing_authorizations: string | null;
}

export interface RenderedSecurityPolicy {
  markdown: string;
  sections: RenderedPolicySections;
  /** Per-operation stance, for the console and the ownership lint. */
  stances: Array<{ id: string; axis: SecurityAxisId; topic: TopicId; stance: Stance }>;
}

/**
 * Project the operation matrix onto the three buckets.
 *
 * Degenerate cases are the ones worth reading carefully: at all-4s both the
 * forbid and ask buckets are empty, and at all-0s the "everything else,
 * proceed" trailer would be actively wrong. A section with no rows omits its
 * heading entirely, and the trailer is conditional on the autonomy operation
 * actually being allowed.
 */
export function renderSecurityPolicyMarkdown(levels: SecurityLevels): RenderedSecurityPolicy {
  const stances = POLICY_OPERATIONS.map((op) => ({
    id: op.id,
    axis: op.axis,
    topic: op.topic,
    stance: stanceFor(op, levels[op.axis]),
    op,
  }));

  // `autonomy.proceed_on_ambiguity` is the document's trailer, not a bullet: it
  // describes what to do with everything the other rules did not catch. Its
  // phrases are whole sentences, so it must be kept out of all three buckets —
  // splicing it into the floor's noun list produced "authorizes Confirm each
  // step before acting; do not batch work behind one approval., pushing to...".
  const trailerOp = stances.find((s) => s.id === 'autonomy.proceed_on_ambiguity')!;
  const isTrailer = (s: { id: string }): boolean => s.id === trailerOp.id;
  const forbidden = stances.filter((s) => s.stance === 'forbid' && !isTrailer(s));
  const asked = stances.filter((s) => s.stance === 'ask' && !isTrailer(s));
  const allowed = stances.filter((s) => s.stance === 'allow' && !isTrailer(s));

  const floorLines: string[] = [PRECEDENCE_PARAGRAPH];
  if (forbidden.length > 0) {
    floorLines.push(
      `No instruction from any tier — including this one — authorizes ${joinClauses(
        forbidden.map((s) => s.op.phrase.forbid),
      )}.`,
    );
  }
  floorLines.push(GRANT_IS_NOT_MANDATE);
  floorLines.push(stricterMechanismClause(levels.security_controls));
  const safetyFloor = `## Instruction Precedence and Safety Floor\n\n${floorLines.join('\n\n')}`;

  let hardStops: string;
  if (asked.length > 0) {
    const bullets = composeAskBullets(asked).join('\n');
    const trailer = `\n\nEverything else: ${lowerFirst(trailerOp.op.phrase[trailerOp.stance])}`;
    hardStops = `## Hard Stop Lines\n\nStop and ask only when at least one applies:\n\n${bullets}${trailer}`;
  } else if (trailerOp.stance === 'allow') {
    // Every operation is granted. Saying "stop and ask when..." followed by an
    // empty list would read as an oversight rather than a decision.
    hardStops = `## Hard Stop Lines\n\nNothing requires a stop. ${trailerOp.op.phrase.allow}`;
  } else {
    hardStops = `## Hard Stop Lines\n\n${trailerOp.op.phrase[trailerOp.stance]}`;
  }

  const standingAuthorizations =
    allowed.length > 0
      ? `## Standing Authorizations\n\nThese need no confirmation. They are permissions, not instructions.\n\n${allowed
          .map((s) => `- ${s.op.phrase.allow}`)
          .join('\n')}`
      : null;

  const sections: RenderedPolicySections = {
    fleet_identity: IDENTITY_SECTION,
    safety_floor: safetyFloor,
    hard_stops: hardStops,
    standing_authorizations: standingAuthorizations,
  };

  const parts = [
    '# Fleet Agent Policy',
    sections.fleet_identity,
    sections.safety_floor,
    sections.hard_stops,
    ...(sections.standing_authorizations === null ? [] : [sections.standing_authorizations]),
  ];

  return {
    markdown: parts.join('\n\n'),
    sections,
    stances: stances.map(({ id, axis, topic, stance }) => ({ id, axis, topic, stance })),
  };
}

function lowerFirst(value: string): string {
  return value.length === 0 ? value : value[0]!.toLowerCase() + value.slice(1);
}

interface StancedOperation {
  op: PolicyOperation;
}

/**
 * Emit standalone `ask` phrases as their own bullets, and fold grouped noun
 * fragments into one bullet per group. A group whose members have all been
 * granted (or all forbidden) simply does not appear, which is how a rising
 * level shortens the sentence instead of leaving a dangling lead-in.
 *
 * Each group keeps the position of its first member, so the bullet order tracks
 * the operation registry rather than jumping to the end.
 */
function composeAskBullets(asked: readonly StancedOperation[]): string[] {
  const out: string[] = [];
  const groupSlot = new Map<string, number>();
  const groupMembers = new Map<string, PolicyOperation[]>();

  for (const { op } of asked) {
    if (op.group === undefined) {
      out.push(`- ${op.phrase.ask}`);
      continue;
    }
    const key = op.group.id;
    if (!groupSlot.has(key)) {
      groupSlot.set(key, out.length);
      groupMembers.set(key, []);
      out.push('');
    }
    groupMembers.get(key)!.push(op);
  }

  for (const [key, slot] of groupSlot) {
    const members = groupMembers.get(key)!.slice().sort((a, b) => a.group!.rank - b.group!.rank);
    const lead = members[0]!.group!.lead;
    out[slot] = `- ${lead} ${joinClauses(members.map((m) => m.phrase.ask))}.`;
  }

  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Enforcement projection
// ────────────────────────────────────────────────────────────────────────────

/**
 * Codex's own `sandbox_mode` values. The repo never enumerated these — the
 * normalizer accepts any string — so this list is introduced here and validated
 * on write only, leaving already-stored free-form values to normalize with a
 * warning rather than throw. One bad row must not 500 the fleet.
 */
export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

export const CODEX_APPROVAL_POLICIES = ['untrusted', 'on-request', 'on-failure', 'never'] as const;
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];

/**
 * Claude has six modes for five levels. `dontAsk` is the one dropped: it sits
 * between `auto` and `bypassPermissions` and adds no distinct posture here.
 * The ladder is anchored so that Standard's `autonomy = 3` lands on `auto`,
 * which is already `DEFAULT_CLAUDE_PERMISSION_MODE` — Standard must not move a
 * single host's enforcement on the day this deploys.
 */
export const CLAUDE_PERMISSION_MODES_BY_LEVEL = [
  'plan',
  'default',
  'acceptEdits',
  'auto',
  'bypassPermissions',
] as const;

export interface DerivedKnob<T> {
  value: T;
  /** Which axis is currently holding this knob down. A number with no visible cause is worse than no number. */
  governedBy: SecurityAxisId;
  /** `partial` when the neighbouring level would produce the same value, so the operator knows that step is prose-only. */
  coverage: 'full' | 'partial';
}

export interface DerivedEnforcement {
  codex: {
    approval_policy: DerivedKnob<CodexApprovalPolicy>;
    sandbox_mode: DerivedKnob<CodexSandboxMode>;
    network_access: DerivedKnob<boolean>;
    web_search: DerivedKnob<CodexWebSearch>;
    guardian_approval: DerivedKnob<boolean>;
  };
  claude: {
    permission_mode: DerivedKnob<(typeof CLAUDE_PERMISSION_MODES_BY_LEVEL)[number]>;
  };
  /**
   * Keys deliberately NOT derived, with the reason. The console renders these
   * so an operator is never left believing an axis is enforced when it is not.
   */
  not_enforced: Array<{ key: string; reason: string }>;
}

/** The axis holding a min() down, preferring the earliest in registry order for a stable answer. */
function governing(levels: SecurityLevels, subset: readonly SecurityAxisId[]): SecurityAxisId {
  return subset.reduce((lowest, id) => (levels[id] < levels[lowest] ? id : lowest), subset[0]!);
}

function reduced(levels: SecurityLevels, subset: readonly SecurityAxisId[]): SecurityLevel {
  return subset.reduce<SecurityLevel>((min, id) => (levels[id] < min ? levels[id] : min), 4);
}

/**
 * The global escalation cap. Without it `autonomy=4, destructive_data=0` would
 * emit `approval_policy = never` beside prose forbidding destructive work — the
 * exact contradiction this whole change exists to remove. The loosest value is
 * unreachable while any axis is still restrictive.
 */
function escalationCap(levels: SecurityLevels): SecurityLevel {
  return reduced(levels, SECURITY_AXIS_IDS) >= 3 ? 4 : 3;
}

function capped(level: SecurityLevel, cap: SecurityLevel): SecurityLevel {
  return (level > cap ? cap : level) as SecurityLevel;
}

function knob<T>(
  value: T,
  governedBy: SecurityAxisId,
  coverage: DerivedKnob<T>['coverage'] = 'full',
): DerivedKnob<T> {
  return { value, governedBy, coverage };
}

const APPROVAL_BY_LEVEL: readonly CodexApprovalPolicy[] = [
  'untrusted',
  'untrusted',
  'on-request',
  'on-failure',
  'never',
];

const SANDBOX_BY_LEVEL: readonly CodexSandboxMode[] = [
  'read-only',
  'read-only',
  'workspace-write',
  'workspace-write',
  'danger-full-access',
];

/**
 * Codex reads `web_search` as a string enum — `disabled | cached | indexed |
 * live`, verified against codex-cli 0.146.0 — and a boolean makes it reject
 * the *entire* config.toml, not just this key. Posture only chooses between
 * off and on, so it uses the two ends.
 */
export const CODEX_WEB_SEARCH_VALUES = ['disabled', 'cached', 'indexed', 'live'] as const;
export type CodexWebSearch = (typeof CODEX_WEB_SEARCH_VALUES)[number];

/**
 * Every value here lands on a key Codex itself reads. `[security]
 * dangerously_bypass_approvals_and_sandbox` is deliberately absent: the server
 * renders it but no Go code parses it, and the wrapper reads the *signed*
 * `engine_options` variant that the baker never emits. Deriving it would ship a
 * slider position that claims to unlock something and silently does nothing.
 * At all-4s `approval_policy = never` plus `sandbox_mode = danger-full-access`
 * already achieve it through keys that work.
 */
export function securityLevelEnforcement(levels: SecurityLevels): DerivedEnforcement {
  const cap = escalationCap(levels);

  const approvalSubset = ['autonomy', 'git_history'] as const;
  const approvalLevel = capped(reduced(levels, approvalSubset), cap);

  const sandboxSubset = ['destructive_data', 'secrets_exposure', 'remote_hosts'] as const;
  const sandboxLevel = capped(reduced(levels, sandboxSubset), cap);

  const networkSubset = ['dependencies', 'remote_hosts', 'deploy_release'] as const;
  const networkLevel = reduced(levels, networkSubset);

  // `permissions.defaultMode` is an autonomy concept: it governs how tool calls
  // are approved in general. Git, deploy and remote reach are expressed as
  // explicit allow/ask/deny rules instead, so folding them in here would drag
  // the mode down for reasons the mode cannot actually express.
  const claudeSubset = ['autonomy'] as const;
  const claudeLevel = capped(reduced(levels, claudeSubset), cap);

  const actionAxes = [
    'git_history',
    'remote_hosts',
    'deploy_release',
    'destructive_data',
  ] as const;
  const guardianWorthwhile =
    levels.autonomy <= 2 && actionAxes.some((id) => levels[id] >= 2);

  return {
    codex: {
      approval_policy: knob(APPROVAL_BY_LEVEL[approvalLevel]!, governing(levels, approvalSubset),
        approvalLevel <= 1 ? 'partial' : 'full'),
      sandbox_mode: knob(SANDBOX_BY_LEVEL[sandboxLevel]!, governing(levels, sandboxSubset),
        sandboxLevel === 1 || sandboxLevel === 3 ? 'partial' : 'full'),
      network_access: knob(networkLevel >= 3, governing(levels, networkSubset),
        networkLevel >= 3 && networkLevel !== 3 ? 'partial' : 'full'),
      web_search: knob<CodexWebSearch>(
        levels.dependencies >= 1 ? 'live' : 'disabled',
        'dependencies',
        'partial',
      ),
      guardian_approval: knob(guardianWorthwhile, 'autonomy', 'partial'),
    },
    claude: {
      permission_mode: knob(CLAUDE_PERMISSION_MODES_BY_LEVEL[claudeLevel]!, governing(levels, claudeSubset)),
    },
    not_enforced: [
      {
        key: 'security_controls',
        reason:
          'No engine exposes a knob for weakening auth/TLS/authorization. This axis changes the policy text only.',
      },
      {
        key: 'verification_waiver',
        reason: 'Neither engine can enforce verification rigor. This axis changes the policy text only.',
      },
      {
        key: '[shell_environment_policy]',
        reason:
          'Provenance unconfirmed — it may be a wrapper-invented relic like [security]. Not derived until verified against upstream Codex; review it manually.',
      },
      {
        key: '[security].dangerously_bypass_approvals_and_sandbox',
        reason:
          'Dead on both paths: the server renders the TOML key but no Go code parses it, and the wrapper reads a signed engine_options key the baker never emits. approval_policy and sandbox_mode carry the real grant.',
      },
    ],
  };
}

/** Catalog payload for the admin console. Mirrors `agentPolicyCatalog()`'s shape. */
export function securityLevelCatalog(): {
  axes: readonly Omit<AxisSpec, never>[];
  presets: readonly SecurityPreset[];
  bands: readonly string[];
  default_levels: SecurityLevels;
} {
  return {
    axes: AXES,
    presets: SECURITY_PRESETS,
    bands: SECURITY_BANDS,
    default_levels: DEFAULT_SECURITY_LEVELS,
  };
}

export function axisSpec(id: SecurityAxisId): AxisSpec {
  return AXIS_BY_ID.get(id)!;
}
