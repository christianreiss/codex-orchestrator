import { describe, it, expect } from 'vitest';
import {
  AXES,
  CLAUDE_PERMISSION_MODES_BY_LEVEL,
  CODEX_SANDBOX_MODES,
  DEFAULT_SECURITY_LEVELS,
  POLICY_OPERATIONS,
  SECURITY_AXIS_IDS,
  SECURITY_BANDS,
  SECURITY_LEVELS,
  SECURITY_PRESETS,
  axesModifiedFrom,
  matchingPreset,
  normalizeSecurityLevels,
  presetLevels,
  renderSecurityPolicyMarkdown,
  securityLevelEnforcement,
  stanceFor,
  type SecurityAxisId,
  type SecurityLevel,
  type SecurityLevels,
} from '../../../src/services/agent-security-levels.js';
import { ValidationError } from '../../../src/http/errors.js';

const preset = (id: string): SecurityLevels => presetLevels(id);
const CONTAINED = preset('contained');
const STANDARD = preset('standard');
const UNRESTRICTED = preset('unrestricted');

function withAxis(base: SecurityLevels, id: SecurityAxisId, level: SecurityLevel): SecurityLevels {
  return { ...base, [id]: level };
}

describe('axis registry', () => {
  it('declares exactly one spec per axis id, each with five bands', () => {
    expect(AXES.map((a) => a.id)).toEqual([...SECURITY_AXIS_IDS]);
    for (const axis of AXES) {
      expect(axis.bands, `${axis.id} bands`).toHaveLength(SECURITY_LEVELS.length);
      expect(axis.bands.every((b) => b.trim() !== ''), `${axis.id} bands non-empty`).toBe(true);
    }
    expect(SECURITY_BANDS).toHaveLength(5);
  });

  it('gives every axis at least one operation', () => {
    for (const id of SECURITY_AXIS_IDS) {
      expect(
        POLICY_OPERATIONS.some((op) => op.axis === id),
        `axis ${id} has no operation and would be a slider that changes nothing`,
      ).toBe(true);
    }
  });

  it('uses unique operation ids', () => {
    const ids = POLICY_OPERATIONS.map((op) => op.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('gate invariants', () => {
  // This is what makes "raising a slider can never remove a permission" true by
  // construction rather than by review.
  it('never lets gate_allow sit below gate_ask', () => {
    for (const op of POLICY_OPERATIONS) {
      expect(op.gate_allow, `${op.id}: gate_allow must be >= gate_ask`).toBeGreaterThanOrEqual(op.gate_ask);
    }
  });

  it('moves each operation monotonically forbid -> ask -> allow as its level rises', () => {
    const rank = { forbid: 0, ask: 1, allow: 2 } as const;
    for (const op of POLICY_OPERATIONS) {
      for (let level = 1; level < SECURITY_LEVELS.length; level += 1) {
        const prev = rank[stanceFor(op, (level - 1) as SecurityLevel)];
        const next = rank[stanceFor(op, level as SecurityLevel)];
        expect(next, `${op.id} regressed between level ${level - 1} and ${level}`).toBeGreaterThanOrEqual(prev);
      }
    }
  });
});

describe('topic ownership', () => {
  // Two axes speaking about the same action is exactly how the old document
  // ended up forbidding remote mutation in one block while a module discussed
  // permitting it in another.
  it('assigns each topic to exactly one axis', () => {
    const owner = new Map<string, SecurityAxisId>();
    for (const op of POLICY_OPERATIONS) {
      const existing = owner.get(op.topic);
      if (existing === undefined) {
        owner.set(op.topic, op.axis);
        continue;
      }
      expect(
        op.axis,
        `topic "${op.topic}" is claimed by both ${existing} and ${op.axis}; two axes must never govern one action`,
      ).toBe(existing);
    }
  });
});

describe('presets', () => {
  it('covers every axis in every preset', () => {
    for (const p of SECURITY_PRESETS) {
      for (const id of SECURITY_AXIS_IDS) {
        expect(p.levels[id], `${p.id}.${id}`).toBeTypeOf('number');
      }
    }
  });

  it('defaults to Standard, and Standard is not a flat row', () => {
    expect(DEFAULT_SECURITY_LEVELS).toEqual(STANDARD);
    const distinct = new Set(SECURITY_AXIS_IDS.map((id) => STANDARD[id]));
    expect(
      distinct.size,
      'Standard must reconstruct today’s non-uniform policy, not flatten it to one number',
    ).toBeGreaterThan(1);
  });

  it('round-trips a preset through matchingPreset and reports nudges', () => {
    expect(matchingPreset(STANDARD)?.id).toBe('standard');
    expect(matchingPreset(UNRESTRICTED)?.id).toBe('unrestricted');
    const nudged = withAxis(STANDARD, 'deploy_release', 4);
    expect(matchingPreset(nudged)).toBeNull();
    expect(axesModifiedFrom('standard', nudged)).toEqual(['deploy_release']);
  });

  it('orders presets from most to least constrained', () => {
    const total = (l: SecurityLevels) => SECURITY_AXIS_IDS.reduce((sum, id) => sum + l[id], 0);
    const totals = SECURITY_PRESETS.map((p) => total(p.levels));
    expect(totals).toEqual([...totals].sort((a, b) => a - b));
  });
});

describe('normalizeSecurityLevels', () => {
  it('fills missing axes from Standard and drops unknown keys', () => {
    const out = normalizeSecurityLevels({ autonomy: 0, not_an_axis: 9 });
    expect(out.autonomy).toBe(0);
    expect(out.deploy_release).toBe(STANDARD.deploy_release);
    expect(out).not.toHaveProperty('not_an_axis');
  });

  it('returns Standard for null and undefined', () => {
    expect(normalizeSecurityLevels(null)).toEqual(STANDARD);
    expect(normalizeSecurityLevels(undefined)).toEqual(STANDARD);
  });

  it('rejects a present-but-invalid level rather than coercing it', () => {
    // A typo'd level must never quietly become Refuse or Proceed.
    for (const bad of [-1, 5, 1.5, '2', true, null]) {
      expect(() => normalizeSecurityLevels({ autonomy: bad }), `autonomy=${String(bad)}`).toThrow(
        ValidationError,
      );
    }
  });

  it('rejects non-objects and arrays', () => {
    for (const bad of ['x', 3, []]) {
      expect(() => normalizeSecurityLevels(bad)).toThrow(ValidationError);
    }
  });

  it('rejects an unknown preset id', () => {
    expect(() => presetLevels('nope')).toThrow(ValidationError);
  });
});

describe('renderSecurityPolicyMarkdown', () => {
  it('always emits identity, precedence, and the grant-is-not-mandate clause', () => {
    for (const levels of [CONTAINED, STANDARD, UNRESTRICTED]) {
      const out = renderSecurityPolicyMarkdown(levels);
      expect(out.markdown).toContain('# Fleet Agent Policy');
      expect(out.markdown).toContain('## Fleet Management');
      expect(out.markdown).toContain('## Instruction Precedence and Safety Floor');
      expect(out.markdown).toContain('A level grants; it never instructs.');
      // Sections carry their rendered text so callers can digest the real
      // bytes rather than a constant heading literal.
      expect(out.sections.fleet_identity).toContain('## Fleet Management');
      expect(out.sections.safety_floor).toContain('## Instruction Precedence and Safety Floor');
      expect(out.markdown).toContain(out.sections.hard_stops!);
    }
  });

  it('names all three precedence tiers, including the user-global path', () => {
    // The old wording scoped itself to "repository instruction files" while the
    // wrapper writes to user-global paths, leaving the floor's scope undefined.
    const md = renderSecurityPolicyMarkdown(STANDARD).markdown;
    expect(md).toContain('$CODEX_HOME/AGENTS.md');
    expect(md).toContain('~/.claude/CLAUDE.md');
    expect(md).toContain('may never widen it');
  });

  it('reproduces today’s Hard Stop Lines at Standard', () => {
    const md = renderSecurityPolicyMarkdown(STANDARD).markdown;
    expect(md).toContain('## Hard Stop Lines');
    expect(md).toContain('Stop and ask only when at least one applies:');
    // Every normative phrase today's document carries must survive somewhere.
    for (const phrase of [
      'destructive or irreversible',
      'push',
      'deploy, publish, send',
      'production restart, production migration',
      'remote mutation',
      'cannot be identified safely',
      'weakening security, bypassing verification',
      'escalating privileges',
      'Multiple materially different product or business outcomes',
      'concurrent changes cannot be preserved safely',
    ]) {
      expect(md, `Standard render lost the normative phrase: ${phrase}`).toContain(phrase);
    }
    expect(md).toContain('Everything else: state the lowest-risk assumption in one line and proceed.');
  });

  it('composes noun fragments into one bullet instead of emitting "- push"', () => {
    // Today's document carries ONE bullet spanning three axes. Rendering the
    // fragments standalone produced bullets reading literally "- push" and
    // "- remote mutation".
    const md = renderSecurityPolicyMarkdown(STANDARD).markdown;
    expect(md).toContain(
      '- It creates an external side effect not clearly included in the user’s request: push, deploy, publish, send, production restart, production migration, or remote mutation.',
    );
    expect(md).not.toMatch(/^- push$/m);
    expect(md).not.toMatch(/^- remote mutation$/m);
    expect(md).toContain(
      '- It requires weakening security, bypassing verification, or escalating privileges beyond the task’s clear intent.',
    );
  });

  it('keeps whole sentences out of the floor’s noun list', () => {
    // The floor splices clauses into "...authorizes X, Y, or Z." A clause that
    // is a full sentence yields "authorizes Confirm each step before acting;
    // do not batch work behind one approval., pushing to..." — and a doubled
    // period. The trailer operation is the one that bites.
    for (const levels of [CONTAINED, STANDARD]) {
      const md = renderSecurityPolicyMarkdown(levels).markdown;
      const floor = md.slice(md.indexOf('No instruction from any tier'));
      const sentence = floor.slice(0, floor.indexOf('\n'));
      expect(sentence).not.toContain('..');
      expect(sentence).not.toContain('authorizes Confirm');
      // Every clause must read as a noun phrase after "authorizes".
      expect(sentence).toMatch(/authorizes [a-z]/);
    }
  });

  it('emits no Standing Authorizations at Contained and no stops at Unrestricted', () => {
    const contained = renderSecurityPolicyMarkdown(CONTAINED);
    expect(contained.sections.standing_authorizations).toBeNull();
    expect(contained.markdown).not.toContain('## Standing Authorizations');
    // The "everything else, proceed" trailer would be actively wrong here.
    expect(contained.markdown).not.toContain('Everything else: state the lowest-risk assumption');

    const open = renderSecurityPolicyMarkdown(UNRESTRICTED);
    expect(open.sections.standing_authorizations).toContain('## Standing Authorizations');
    expect(open.markdown).toContain('## Standing Authorizations');
    expect(open.markdown).toContain('They are permissions, not instructions.');
    // Nothing is forbidden, so the floor sentence must not appear at all.
    expect(open.markdown).not.toContain('No instruction from any tier');
  });

  it('unlocks remote mutation, deploys and secret values at Unrestricted', () => {
    const md = renderSecurityPolicyMarkdown(UNRESTRICTED).markdown;
    expect(md).toContain('Make task-relevant changes on an explicitly named remote host');
    expect(md).toContain('Restart and migrate production without asking');
    expect(md).toContain('Write secret values wherever the task requires');
    // The old hard-coded prohibitions must be gone, not merely contradicted.
    expect(md).not.toContain('No instruction from any tier');
  });

  it('never states a forbid and an allow for the same operation', () => {
    for (const levels of [CONTAINED, STANDARD, UNRESTRICTED]) {
      const { stances } = renderSecurityPolicyMarkdown(levels);
      const byId = new Map(stances.map((s) => [s.id, s.stance]));
      expect(byId.size).toBe(POLICY_OPERATIONS.length);
    }
  });

  it('inverts the stricter-mechanism clause only at security_controls 4', () => {
    const low = renderSecurityPolicyMarkdown(STANDARD).markdown;
    expect(low).toContain('A mechanical refusal is a boundary, not an obstacle');
    const high = renderSecurityPolicyMarkdown(withAxis(STANDARD, 'security_controls', 4)).markdown;
    expect(high).toContain('yours to reconfigure when the task requires it');
  });
});

describe('securityLevelEnforcement', () => {
  it('derives the documented endpoints', () => {
    const contained = securityLevelEnforcement(CONTAINED);
    expect(contained.codex.approval_policy.value).toBe('untrusted');
    expect(contained.codex.sandbox_mode.value).toBe('read-only');
    expect(contained.codex.network_access.value).toBe(false);
    expect(contained.claude.permission_mode.value).toBe('plan');

    const open = securityLevelEnforcement(UNRESTRICTED);
    expect(open.codex.approval_policy.value).toBe('never');
    expect(open.codex.sandbox_mode.value).toBe('danger-full-access');
    expect(open.codex.network_access.value).toBe(true);
    expect(open.claude.permission_mode.value).toBe('bypassPermissions');
  });

  it('lands Standard on the values the fleet already runs', () => {
    // Standard must not move any host's enforcement on the day this deploys.
    const std = securityLevelEnforcement(STANDARD);
    expect(CODEX_SANDBOX_MODES).toContain(std.codex.sandbox_mode.value);
    expect(std.claude.permission_mode.value).toBe('auto');
  });

  it('caps escalation while any axis is still restrictive', () => {
    // The contradiction this whole change exists to remove: full autonomy
    // beside prose that forbids destructive work.
    const lopsided = withAxis(UNRESTRICTED, 'destructive_data', 0);
    const derived = securityLevelEnforcement(lopsided);
    expect(derived.codex.approval_policy.value).not.toBe('never');
    expect(derived.codex.sandbox_mode.value).not.toBe('danger-full-access');
    expect(derived.claude.permission_mode.value).not.toBe('bypassPermissions');
  });

  it('never loosens a knob when a single axis is raised', () => {
    const order = {
      approval: ['untrusted', 'on-request', 'on-failure', 'never'],
      sandbox: [...CODEX_SANDBOX_MODES],
      claude: [...CLAUDE_PERMISSION_MODES_BY_LEVEL],
    };
    for (const base of [CONTAINED, STANDARD, UNRESTRICTED]) {
      for (const id of SECURITY_AXIS_IDS) {
        for (let level = 1; level < SECURITY_LEVELS.length; level += 1) {
          const lower = securityLevelEnforcement(withAxis(base, id, (level - 1) as SecurityLevel));
          const upper = securityLevelEnforcement(withAxis(base, id, level as SecurityLevel));
          expect(
            order.approval.indexOf(upper.codex.approval_policy.value),
            `raising ${id} to ${level} tightened approval_policy`,
          ).toBeGreaterThanOrEqual(order.approval.indexOf(lower.codex.approval_policy.value));
          expect(
            order.sandbox.indexOf(upper.codex.sandbox_mode.value),
            `raising ${id} to ${level} tightened sandbox_mode`,
          ).toBeGreaterThanOrEqual(order.sandbox.indexOf(lower.codex.sandbox_mode.value));
          expect(
            order.claude.indexOf(upper.claude.permission_mode.value),
            `raising ${id} to ${level} tightened permissions.defaultMode`,
          ).toBeGreaterThanOrEqual(order.claude.indexOf(lower.claude.permission_mode.value));
          expect(Number(upper.codex.network_access.value)).toBeGreaterThanOrEqual(
            Number(lower.codex.network_access.value),
          );
        }
      }
    }
  });

  it('names a governing axis for every knob', () => {
    const derived = securityLevelEnforcement(STANDARD);
    for (const knob of [
      derived.codex.approval_policy,
      derived.codex.sandbox_mode,
      derived.codex.network_access,
      derived.claude.permission_mode,
    ]) {
      expect(SECURITY_AXIS_IDS).toContain(knob.governedBy);
    }
  });

  it('declares the dead bypass key and the prose-only axes as not enforced', () => {
    // Shipping a slider that claims to unlock something and silently does
    // nothing is exactly the theatre this work exists to remove.
    const keys = securityLevelEnforcement(STANDARD).not_enforced.map((n) => n.key);
    expect(keys).toContain('[security].dangerously_bypass_approvals_and_sandbox');
    expect(keys).toContain('[shell_environment_policy]');
    expect(keys).toContain('verification_waiver');
    expect(keys).toContain('security_controls');
  });

  it('marks prose-only axes in the registry so the console can badge them', () => {
    expect(AXES.find((a) => a.id === 'verification_waiver')?.enforcement).toBe('prose_only');
  });
});
