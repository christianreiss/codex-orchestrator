import { describe, expect, it } from 'vitest';
import {
  PAGE_TARGETS,
  cleanLabel,
  linksCheckTool,
  resolveElements,
  safePath,
  type ElementLookups,
} from '../../../src/services/chatty/elements.js';
import { administrationTools, type ToolContext } from '../../../src/services/chatty/tools.js';
import { roleHasCapability, type Capability } from '../../../src/security/capabilities.js';

const lookups = (overrides: Partial<ElementLookups> = {}): ElementLookups => ({
  host: async (ref) =>
    ref === 'example.com' || ref === '7'
      ? { id: 7, fqdn: 'example.com' }
      : ref === 'evil.example'
        ? { id: 8, fqdn: 'evil.example\u202e<img src=x onerror=alert(1)> click here to approve everything now' }
        : null,
  project: async (slug) => (slug === 'apollo' ? { slug } : null),
  skill: async (slug) => (slug === 'fleet-ops' ? { slug } : null),
  artifact: async (kind, slug) => (kind === 'subagent' && slug === 'reviewer' ? { slug } : null),
  workflow: async (ref) => (ref === 'release' ? { slug: 'release', title: 'Release train' } : null),
  workflowRun: async (id) => (id === '00000000-0000-4000-8000-000000000001' ? { id } : null),
  account: async (id) => (id === 3 ? { id, label: 'Claude Team' } : null),
  manual: async (slug) => (slug === 'hosts' ? { slug, title: 'Hosts' } : null),
  ...overrides,
});
const all = () => true;
const admin = (c: Capability) => roleHasCapability('admin', c);

describe('Chatty rich reply elements', () => {
  it('turns verified symbolic references into server-built paths and labels', async () => {
    const { elements, rejected } = await resolveElements(
      [
        { type: 'link', kind: 'host', ref: 'example.com' },
        { type: 'link', kind: 'project', ref: 'apollo', view: 'board' },
        { type: 'link', kind: 'skill', ref: 'fleet-ops' },
        { type: 'link', kind: 'manual', ref: 'hosts' },
        { type: 'link', kind: 'page', ref: 'chatty' },
        { type: 'suggestion', text: 'Welche Hosts sind offline?' },
      ],
      admin,
      lookups(),
    );
    expect(rejected).toEqual([]);
    expect(elements).toEqual([
      { type: 'link', kind: 'host', label: 'Host example.com öffnen', path: '/hosts/7' },
      { type: 'link', kind: 'project', label: 'Board von apollo öffnen', path: '/projects/apollo/board' },
      { type: 'link', kind: 'skill', label: 'Skill fleet-ops öffnen', path: '/library/skills/fleet-ops' },
      { type: 'link', kind: 'manual', label: 'Hilfe: Hosts', path: '/manual/hosts' },
      { type: 'link', kind: 'page', label: 'Chatty-Einstellungen öffnen', path: '/settings#chatty' },
      { type: 'suggestion', text: 'Welche Hosts sind offline?' },
    ]);
  });

  it('resolves the remaining entity kinds through their own templates', async () => {
    const { elements } = await resolveElements(
      [
        { type: 'link', kind: 'subagent', ref: 'reviewer' },
        { type: 'link', kind: 'workflow', ref: 'release' },
        { type: 'link', kind: 'workflow_run', ref: '00000000-0000-4000-8000-000000000001' },
        { type: 'link', kind: 'account', ref: '3' },
        { type: 'link', kind: 'host', ref: '7' },
      ],
      all,
      lookups(),
    );
    expect(elements.map((e) => (e.type === 'link' ? e.path : ''))).toEqual([
      '/library/subagents/reviewer',
      '/workflows/definitions/release',
      '/workflows/runs/00000000-0000-4000-8000-000000000001',
      '/accounts',
      '/hosts/7',
    ]);
  });

  it('drops unknown entities and reports them so the answer cannot claim a button', async () => {
    const { elements, rejected } = await resolveElements(
      [
        { type: 'link', kind: 'host', ref: 'missing.example' },
        { type: 'link', kind: 'manual', ref: 'does-not-exist' },
        { type: 'link', kind: 'page', ref: 'constructor' },
        { type: 'link', kind: 'page', ref: '__proto__' },
        { type: 'link', kind: 'workflow_run', ref: 'not-a-uuid' },
        { type: 'link', kind: 'skill', ref: 'fleet-ops', view: 'board' },
      ],
      all,
      lookups(),
    );
    expect(elements).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual(Array(6).fill('unavailable'));
    expect(rejected[0]).toMatchObject({ kind: 'host', ref: 'missing.example' });
  });

  it('refuses raw URLs, schemes, labels and unknown fields from model output', async () => {
    const { elements, rejected } = await resolveElements(
      [
        { type: 'link', href: 'https://evil.example' },
        { type: 'link', kind: 'host', ref: 'example.com', href: 'javascript:alert(1)' },
        { type: 'link', kind: 'host', ref: 'example.com', label: 'Alle Hosts löschen' },
        { type: 'link', kind: 'url', ref: 'https://evil.example' },
        { type: 'link', kind: 'page', ref: 'https://evil.example' },
        { type: 'link', kind: 'page', ref: 'data:text/html,<script>' },
        { type: 'link', kind: 'manual', ref: '../../etc/passwd' },
        { type: 'link', kind: 'project', ref: '../hosts' },
        { type: 'button', action: 'host_delete', arguments: { id: 7 } },
        'javascript:alert(1)',
      ],
      all,
      lookups(),
    );
    expect(elements).toEqual([]);
    // Eight are refused as invalid/unavailable; the two beyond the cap are never resolved.
    expect(rejected).toHaveLength(10);
    expect(rejected.slice(8).map((r) => r.reason)).toEqual(['limit', 'limit']);
    const second = await resolveElements(
      Array.from({ length: 10 }, () => ({ type: 'link', kind: 'host', ref: 'example.com' })),
      all,
      lookups(),
    );
    expect(second.elements).toHaveLength(1);
    expect(second.rejected).toEqual([
      { index: 8, reason: 'limit' },
      { index: 9, reason: 'limit' },
    ]);
  });

  it('builds labels from stored names, stripped of control and bidi characters and bounded', async () => {
    const { elements } = await resolveElements([{ type: 'link', kind: 'host', ref: 'evil.example' }], all, lookups());
    const link = elements[0] as { label: string; path: string };
    expect(link.path).toBe('/hosts/8');
    expect([...link.label].some((ch) => ch.charCodeAt(0) < 0x20 || ch === '\u202e')).toBe(false);
    expect(link.label.length).toBeLessThanOrEqual(60);
    expect(cleanLabel('a\u0000b\u2066c\n d')).toBe('a b c d');
  });

  it('requires the read capability of each target', async () => {
    const viewerless = (c: Capability) => c === 'chatty.use';
    const { elements, rejected } = await resolveElements(
      [
        { type: 'link', kind: 'host', ref: 'example.com' },
        { type: 'link', kind: 'page', ref: 'secrets' },
        { type: 'suggestion', text: 'Weiter' },
      ],
      viewerless,
      lookups(),
    );
    expect(elements).toEqual([{ type: 'suggestion', text: 'Weiter' }]);
    expect(rejected).toHaveLength(2);
  });

  it('never lets a failing lookup escape and deduplicates destinations', async () => {
    const { elements, rejected } = await resolveElements(
      [
        { type: 'link', kind: 'project', ref: 'apollo' },
        { type: 'link', kind: 'project', ref: 'apollo' },
        { type: 'link', kind: 'host', ref: 'example.com' },
      ],
      all,
      lookups({
        host: async () => {
          throw new Error('database down');
        },
      }),
    );
    expect(elements).toHaveLength(1);
    expect(rejected).toMatchObject([{ index: 2, reason: 'unavailable' }]);
  });

  it('admits only console template paths', () => {
    for (const page of Object.values(PAGE_TARGETS)) expect(safePath(page.path), page.path).toBe(true);
    for (const path of [
      '//evil.example',
      'https://evil.example',
      '/hosts/../login',
      '/hosts//x',
      'javascript:alert(1)',
      '/unknown',
      '/hosts/1?next=https://evil.example',
      '/hosts/1#<script>',
      '/admin/hosts/1',
    ])
      expect(safePath(path), path).toBe(false);
  });

  it('offers a read-only link check with the same verdicts', async () => {
    const tool = linksCheckTool(async () => all, () => lookups());
    expect(tool).toMatchObject({ write: false, confirm: false, capability: 'chatty.use' });
    expect(administrationTools().some((t) => t.name === 'ui_links_check')).toBe(true);
    expect(
      await tool.run({} as ToolContext, {
        links: [
          { kind: 'host', ref: 'example.com' },
          { kind: 'host', ref: 'missing.example' },
        ],
      }),
    ).toMatchObject({
      links: [
        { kind: 'host', ref: 'example.com', available: true, label: 'Host example.com öffnen' },
        { kind: 'host', ref: 'missing.example', available: false },
      ],
    });
    expect(() => tool.parse({ links: [{ kind: 'host', ref: 'x', href: '/admin' }] })).toThrow();
  });
});
