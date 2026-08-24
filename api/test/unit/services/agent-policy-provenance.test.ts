/**
 * The console links a setting to the text it produced by walking the rendered
 * headings and consuming the server's ordered block list in step. That only
 * works while the two agree exactly, and nothing about a wording change makes
 * them disagree loudly — the highlights would just quietly stop appearing. These
 * tests are what makes that disagreement fail out loud instead.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_POLICY_MODULE_IDS,
  renderAgentPolicyBase,
  agentPolicyCatalog,
  documentHeadings,
} from '../../../src/services/agent-policy-composer.js';
import { renderManagedAgentFeatures } from '../../../src/services/managed-agents-features.js';
import {
  axisPolicySections,
  presetLevels,
  renderSecurityPolicyMarkdown,
  SECURITY_AXIS_IDS,
  type SecurityLevels,
} from '../../../src/services/agent-security-levels.js';

const PRESETS = ['contained', 'standard', 'trusted', 'unrestricted'] as const;

function context(overrides: Record<string, unknown> = {}) {
  const on = { enabled: true, reason: 'included' };
  return {
    engine: 'codex',
    skills: { ...on, count: 3 },
    memory: on,
    projects: on,
    browseros: on,
    secrets: { ...on, count: 2 },
    apiKeysInChat: on,
    agentMessaging: on,
    gitDirector: { ...on, count: 2 },
    ...overrides,
  } as never;
}

function composeBase(modules: readonly string[], custom = '') {
  return renderAgentPolicyBase({
    schema_version: 1,
    template_id: 'fleet-standard',
    template_version: 1,
    enabled_modules: [...modules],
    custom_instructions: custom,
  });
}

/** Every `##` heading of the rendered document, in the order a reader meets them. */
function renderedHeadings(body: string): string[] {
  return documentHeadings(body);
}

describe('rendered document provenance', () => {
  it('describes exactly the headings the document contains, in order', () => {
    const moduleSubsets = [
      [...AGENT_POLICY_MODULE_IDS],
      ['operating_contract', 'security'],
      ['midnight_rule'],
      [],
    ];
    for (const preset of PRESETS) {
      for (const modules of moduleSubsets) {
        const base = composeBase(modules, 'House rules.');
        const out = renderManagedAgentFeatures(base.content, context(), presetLevels(preset), base.provenance);
        expect(out.provenance.flatMap((entry) => entry.headings), `${preset} / ${modules.length} modules`).toEqual(
          renderedHeadings(out.body),
        );
      }
    }
  });

  it('reports an operator heading as part of the block it was typed into', () => {
    // Otherwise a `## Skills` in custom instructions would be consumed by the
    // real Skills section, shifting every managed block after it onto the wrong
    // control — a mis-attribution, which is worse than no link.
    const base = composeBase(['security'], 'Local notes.\n\n## Skills\n\nSomething the operator wrote.');
    const out = renderManagedAgentFeatures(base.content, context(), undefined, base.provenance);

    const custom = out.provenance.find((entry) => entry.key === 'custom_instructions');
    expect(custom?.headings).toEqual(['Custom Instructions', 'Skills']);
    expect(out.provenance.flatMap((entry) => entry.headings)).toEqual(renderedHeadings(out.body));
  });

  it('ignores a heading inside a fenced block, which renders as code not a heading', () => {
    const base = composeBase([], 'Run this:\n\n```sh\n## not a heading\n```\n');
    const out = renderManagedAgentFeatures(base.content, context(), undefined, base.provenance);
    expect(out.provenance.flatMap((entry) => entry.headings)).toEqual(renderedHeadings(out.body));
  });

  it('describes a legacy body as one block, since it has no per-section attribution', () => {
    const legacy = '## House Rules\n\nDo the thing.\n\n## More Rules\n\nDo it well.\n';
    const out = renderManagedAgentFeatures(legacy, context(), undefined, undefined);

    const legacyEntries = out.provenance.filter((entry) => entry.group === 'legacy');
    expect(legacyEntries).toHaveLength(1);
    expect(legacyEntries[0]!.headings).toEqual(['House Rules', 'More Rules']);
    expect(out.provenance.flatMap((entry) => entry.headings)).toEqual(renderedHeadings(out.body));
  });

  it('survives a served document being pasted back in as the canonical base', () => {
    const base = composeBase([...AGENT_POLICY_MODULE_IDS]);
    const once = renderManagedAgentFeatures(base.content, context(), undefined, base.provenance);
    const twice = renderManagedAgentFeatures(once.body, context(), undefined, undefined);
    expect(twice.provenance.flatMap((entry) => entry.headings)).toEqual(renderedHeadings(twice.body));
  });

  it('publishes each module heading, which is neither its id nor its label', () => {
    const catalog = agentPolicyCatalog();
    const security = catalog.modules.find((module) => module.id === 'security');
    expect(security?.label).toBe('Security and trust boundaries');
    expect(security?.heading).toBe('Security and Trust Boundaries');
    for (const module of catalog.modules) expect(module.heading).not.toBe('');
  });

  it('omits blocks the document does not contain', () => {
    const base = composeBase(['security']);
    const out = renderManagedAgentFeatures(
      base.content,
      context({ skills: { enabled: false, reason: 'no_skills' } }),
      presetLevels('contained'),
      base.provenance,
    );
    const keys = out.provenance.map((entry) => entry.key);
    expect(keys).not.toContain('feature:skills');
    // Nothing is granted outright at the most constrained preset.
    expect(keys).not.toContain('policy:standing_authorizations');
    expect(keys).toContain('module:security');
  });
});

describe('axis to policy section projection', () => {
  const sectionsAt = (levels: SecurityLevels) => axisPolicySections(renderSecurityPolicyMarkdown(levels));

  it('names every section an axis reaches, not just one', () => {
    // git_history forbids history rewrites in the floor while asking before a
    // commit in the stops; no level puts all of its text in one section.
    expect(sectionsAt(presetLevels('standard')).git_history).toEqual(['safety_floor', 'hard_stops']);
  });

  it('security_controls always reaches safety_floor (stricterMechanismClause)', () => {
    // Not an operation, so bucket projection alone never finds it.
    for (const preset of PRESETS) {
      expect(sectionsAt(presetLevels(preset)).security_controls, preset).toContain('safety_floor');
    }
  });

  it('autonomy always reaches hard_stops (proceed_on_ambiguity trailer)', () => {
    // Held out of all three buckets on purpose, and at high levels it is the
    // entire section body.
    for (const preset of PRESETS) {
      expect(sectionsAt(presetLevels(preset)).autonomy, preset).toContain('hard_stops');
    }
  });

  it('never names a section the document omitted', () => {
    for (const preset of PRESETS) {
      const policy = renderSecurityPolicyMarkdown(presetLevels(preset));
      const projected = axisPolicySections(policy);
      for (const axis of SECURITY_AXIS_IDS) {
        for (const section of projected[axis]) {
          expect(policy.sections[section], `${preset} / ${axis} / ${section}`).not.toBeNull();
        }
      }
    }
  });

  it('drops standing_authorizations entirely when nothing is granted outright', () => {
    const contained = sectionsAt(presetLevels('contained'));
    for (const axis of SECURITY_AXIS_IDS) {
      expect(contained[axis], axis).not.toContain('standing_authorizations');
    }
  });
});
