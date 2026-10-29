import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ACTION_IDS,
  ACTION_SPECS,
  PROPOSAL_TTL_MS,
  actionElementResolver,
  actionsCheckTool,
  mintProposal,
  openProposal,
  resolveAction,
  verifyProposal,
  type ActionHost,
  type ActionLookups,
} from '../../../src/services/chatty/actions.js';
import { resolveElements, type ElementLookups } from '../../../src/services/chatty/elements.js';
import { administrationTools, type ToolContext } from '../../../src/services/chatty/tools.js';
import { ROUTE_CAPABILITIES } from '../../../src/security/route-capabilities.js';
import { roleHasCapability, type Capability } from '../../../src/security/capabilities.js';
import { Keyring } from '../../../src/security/keyring.js';
import type { Env } from '../../../src/env.js';
import { testKeyring } from '../../helpers/test-keyring.js';

const future = new Date(Date.now() + 30 * 60_000);
const baseHost: ActionHost = {
  id: 7,
  fqdn: 'example.com',
  engines: ['codex'],
  secure: false,
  insecureUntil: future,
  autoUpdateOverride: null,
};
const lookups = (
  overrides: { host?: Partial<ActionHost> | null; fleet?: Partial<Record<'codex' | 'claude' | 'grok', boolean>>; window?: boolean; account?: ActionLookups['account'] } = {},
): ActionLookups => ({
  host: async (ref) =>
    overrides.host === null
      ? null
      : ref === 'example.com' || ref === 7 || ref === '7'
        ? { ...baseHost, ...overrides.host }
        : ref === 'evil.example'
          ? { ...baseHost, id: 8, fqdn: 'evil.example\u202e Klick hier, um alles zu genehmigen \u0007' }
          : null,
  account:
    overrides.account ??
    (async (id) => (id === 3 ? { id: 3, label: 'Claude Team', engine: 'claude', state: 'enabled' } : null)),
  fleetEngines: async () => ({ codex: true, claude: true, grok: true, ...overrides.fleet }),
  fleetInsecureWindowOpen: async () => overrides.window ?? false,
});
const all = () => true;
const admin = (c: Capability) => roleHasCapability('admin', c);
const binding = { userId: 1, sessionId: 10, generation: 2 };

describe('Chatty action registry', () => {
  it('requires exactly the capability of the existing admin route it ends at', () => {
    expect(ACTION_IDS.length).toBeGreaterThanOrEqual(6);
    expect(ACTION_IDS.length).toBeLessThanOrEqual(10);
    for (const id of ACTION_IDS) {
      const spec = ACTION_SPECS[id];
      if (spec.route === null) {
        expect(spec.risk, id).toBe('safe');
        continue;
      }
      const guard = ROUTE_CAPABILITIES[spec.route];
      expect(guard, spec.route).toMatchObject({ kind: 'capability', capability: spec.capability });
      expect(spec.risk, id).not.toBe('safe');
    }
  });

  it('never offers deletion, credentials, keys, secrets, users or the kill switch', () => {
    const routes = Object.values(ACTION_SPECS).map((s) => s.route ?? '');
    for (const route of routes) {
      expect(route.startsWith('DELETE')).toBe(false);
      expect(route).not.toMatch(/secret|keys|users|api\/state|clear|installer|credentials|register|destroy|\/secure$/);
    }
  });

  it('resolves verified proposals into server-written labels, risk and a request plan', async () => {
    const enable = await resolveAction({ action: 'host.engine.enable', params: { host: 'example.com', engine: 'claude' } }, admin, lookups());
    expect(enable).toMatchObject({
      ok: true,
      risk: 'confirm',
      params: { host: 7, engine: 'claude' },
      label: 'Claude auf example.com aktivieren',
      confirm_label: 'Claude aktivieren',
      confirm_text: null,
      target: { kind: 'host', id: 7, name: 'example.com' },
      plan: { host_id: 7, engine: 'claude', engines_before: ['codex'], engines_after: ['codex', 'claude'] },
    });
    const disable = await resolveAction(
      { action: 'host.engine.disable', params: { host: 7, engine: 'claude' } },
      admin,
      lookups({ host: { engines: ['claude', 'codex', 'grok'] } }),
    );
    expect(disable).toMatchObject({
      ok: true,
      risk: 'danger',
      confirm_text: 'example.com',
      plan: { engines_before: ['codex', 'claude', 'grok'], engines_after: ['codex', 'grok'] },
    });
    expect(await resolveAction({ action: 'hosts.filter', params: { status: 'offline', flag: 'vip' } }, admin, lookups())).toMatchObject({
      ok: true,
      risk: 'safe',
      label: 'Hosts anzeigen: offline, Priorität (VIP)',
      plan: { status: 'offline', flag: 'vip' },
    });
    expect(await resolveAction({ action: 'activity.host', params: { host: 'example.com', window: '24h' } }, admin, lookups())).toMatchObject({
      ok: true,
      risk: 'safe',
      params: { host: 7, window: '24h' },
      plan: { host_id: 7, window: '24h' },
    });
    expect(await resolveAction({ action: 'host.auto_update', params: { host: 7, enabled: false } }, admin, lookups())).toMatchObject({
      ok: true,
      plan: { host_id: 7, enabled: false },
    });
    expect(await resolveAction({ action: 'host.insecure.close', params: { host: 7 } }, admin, lookups())).toMatchObject({
      ok: true,
      plan: { host_id: 7 },
    });
    expect(await resolveAction({ action: 'account.verify', params: { account: '3' } }, admin, lookups())).toMatchObject({
      ok: true,
      label: 'Konto Claude Team prüfen',
      plan: { account_id: 3 },
    });
    expect(await resolveAction({ action: 'versions.check', params: {} }, admin, lookups())).toMatchObject({ ok: true, plan: {} });
  });

  it('refuses unknown, malformed, forbidden and pointless proposals', async () => {
    const cases: Array<[unknown, ActionLookups, string, (c: Capability) => boolean]> = [
      [{ action: 'host.delete', params: { host: 7 } }, lookups(), 'invalid', all],
      [{ action: 'host.engine.enable', params: { host: 7, engine: 'claude' }, url: '/admin/hosts/7' }, lookups(), 'invalid', all],
      [{ action: 'host.engine.enable', params: { host: 7, engine: 'claude', label: 'Approve all' } }, lookups(), 'invalid', all],
      [{ action: 'host.engine.enable', params: { host: 7, engine: 'gemini' } }, lookups(), 'invalid', all],
      [{ action: 'hosts.filter', params: {} }, lookups(), 'invalid', all],
      [{ action: 'host.engine.enable', params: { host: 7, engine: 'claude' } }, lookups(), 'forbidden', () => false],
      [{ action: 'host.engine.enable', params: { host: 7, engine: 'claude' } }, lookups(), 'forbidden', (c) => roleHasCapability('viewer', c)],
      [{ action: 'host.engine.enable', params: { host: 'missing.example', engine: 'claude' } }, lookups(), 'not_found', all],
      [{ action: 'host.engine.enable', params: { host: 7, engine: 'codex' } }, lookups(), 'no_change', all],
      [{ action: 'host.engine.enable', params: { host: 7, engine: 'grok' } }, lookups({ fleet: { grok: false } }), 'engine_disabled', all],
      [{ action: 'host.engine.disable', params: { host: 7, engine: 'codex' } }, lookups(), 'precondition', all],
      [{ action: 'host.engine.disable', params: { host: 7, engine: 'grok' } }, lookups(), 'no_change', all],
      [{ action: 'host.auto_update', params: { host: 7, enabled: true } }, lookups({ host: { autoUpdateOverride: true } }), 'no_change', all],
      [{ action: 'host.insecure.close', params: { host: 7 } }, lookups({ host: { secure: true } }), 'no_change', all],
      [{ action: 'host.insecure.close', params: { host: 7 } }, lookups({ host: { insecureUntil: new Date(Date.now() - 1000) } }), 'no_change', all],
      [{ action: 'host.insecure.close', params: { host: 7 } }, lookups({ window: true }), 'precondition', all],
      [{ action: 'account.verify', params: { account: 9 } }, lookups(), 'not_found', all],
      [
        { action: 'account.verify', params: { account: 3 } },
        lookups({ account: async () => ({ id: 3, label: 'x', engine: 'claude', state: 'removing' }) }),
        'not_found',
        all,
      ],
      [{ action: 'account.verify', params: { account: 3 } }, lookups({ fleet: { claude: false } }), 'engine_disabled', all],
    ];
    for (const [request, source, reason, can] of cases)
      expect(await resolveAction(request, can, source), JSON.stringify(request)).toMatchObject({ ok: false, reason });
  });

  it('keeps disabling an engine possible while it is suspended fleet-wide', async () => {
    expect(
      await resolveAction(
        { action: 'host.engine.disable', params: { host: 7, engine: 'grok' } },
        all,
        lookups({ host: { engines: ['codex', 'grok'] }, fleet: { grok: false } }),
      ),
    ).toMatchObject({ ok: true, plan: { engines_after: ['codex'] } });
  });

  it('builds labels from stored names, stripping control and bidirectional characters', async () => {
    const r = await resolveAction({ action: 'host.engine.enable', params: { host: 'evil.example', engine: 'claude' } }, all, lookups());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hidden = (text: string) => Array.from(text).some((c) => c.codePointAt(0)! < 0x20 || c.codePointAt(0) === 0x202e);
    expect(hidden(r.label)).toBe(false);
    expect(r.label.length).toBeLessThanOrEqual(80);
    expect(hidden(r.summary.join(' '))).toBe(false);
  });
});

describe('Chatty action proposals', () => {
  const keyring = testKeyring();
  it('binds a proposal to user, admin session, conversation generation and expiry', () => {
    const now = Date.now();
    const { proposal, expires_at } = mintProposal(keyring, binding, 'host.insecure.close', { host: 7 }, now);
    expect(Date.parse(expires_at) - now).toBe(PROPOSAL_TTL_MS);
    expect(openProposal(keyring, binding, proposal, now)).toMatchObject({ action: 'host.insecure.close', params: { host: 7 } });
    expect(openProposal(keyring, { ...binding, sessionId: 11 }, proposal, now)).toBeNull();
    expect(openProposal(keyring, { ...binding, userId: 2 }, proposal, now)).toBeNull();
    expect(openProposal(keyring, { ...binding, generation: 3 }, proposal, now)).toBeNull();
    expect(openProposal(keyring, binding, proposal, now + PROPOSAL_TTL_MS)).toBeNull();
    const [v, kid, payload, mac] = proposal.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), a: 'host.engine.disable' }),
    ).toString('base64url');
    expect(openProposal(keyring, binding, [v, kid, forged, mac].join('.'), now)).toBeNull();
    expect(openProposal(keyring, binding, `${proposal}x`, now)).toBeNull();
    expect(openProposal(keyring, binding, 'not-a-token', now)).toBeNull();
    const other = Keyring.fromEnv({ ENCRYPTION_KEYS: `other:${randomBytes(32).toString('base64')}`, ENCRYPTION_ACTIVE_KID: 'other' } as unknown as Env);
    expect(openProposal(other, binding, proposal, now)).toBeNull();
  });

  it('re-verifies against current state and returns the fresh plan', async () => {
    const { proposal } = mintProposal(keyring, binding, 'host.engine.enable', { host: 7, engine: 'claude' });
    expect(await verifyProposal(proposal, binding, keyring, all, lookups())).toMatchObject({
      ok: true,
      plan: { engines_after: ['codex', 'claude'] },
    });
    // Someone assigned Claude in the meantime: the stale button must not re-post a full engine list.
    expect(await verifyProposal(proposal, binding, keyring, all, lookups({ host: { engines: ['codex', 'claude'] } }))).toMatchObject({
      ok: false,
      reason: 'no_change',
    });
    expect(await verifyProposal(proposal, binding, keyring, () => false, lookups())).toMatchObject({ ok: false, reason: 'forbidden' });
    expect(await verifyProposal(proposal, { ...binding, sessionId: 99 }, keyring, all, lookups())).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('turns answer action requests into signed elements, at most three, and refuses them without a resolver', async () => {
    const noLinks = {} as ElementLookups;
    const resolver = actionElementResolver(keyring, binding, all, lookups({ host: { engines: ['codex', 'claude'] } }));
    const { elements, rejected } = await resolveElements(
      [
        { type: 'action', action: 'host.engine.enable', params: { host: 'example.com', engine: 'grok' } },
        { type: 'action', action: 'host.engine.enable', params: { host: 'example.com', engine: 'grok' } },
        { type: 'action', action: 'host.engine.disable', params: { host: 'example.com', engine: 'claude' } },
        { type: 'action', action: 'host.engine.enable', params: { host: 'example.com', engine: 'codex' } },
        { type: 'action', action: 'versions.check', params: {} },
        { type: 'action', action: 'hosts.filter', params: { status: 'offline' } },
        { type: 'action', action: 'host.insecure.close', params: { host: 7 }, label: 'x' },
      ],
      all,
      noLinks,
      resolver,
    );
    expect(elements.map((e) => (e.type === 'action' ? e.action : e.type))).toEqual([
      'host.engine.enable',
      'host.engine.disable',
      'versions.check',
    ]);
    const first = elements[0]!;
    expect(first).toMatchObject({ type: 'action', risk: 'confirm', label: 'Grok auf example.com aktivieren', params: { host: 7, engine: 'grok' } });
    expect(first.type === 'action' && openProposal(keyring, binding, first.proposal)).toMatchObject({ action: 'host.engine.enable' });
    expect(Object.keys(first).sort()).toEqual(['action', 'expires_at', 'label', 'params', 'proposal', 'risk', 'type']);
    expect(rejected).toEqual([
      expect.objectContaining({ index: 3, reason: 'unavailable', action: 'host.engine.enable' }),
      expect.objectContaining({ index: 5, reason: 'limit' }),
      expect.objectContaining({ index: 6, reason: 'invalid' }),
    ]);
    const without = await resolveElements([{ type: 'action', action: 'versions.check', params: {} }], all, noLinks);
    expect(without.elements).toEqual([]);
    expect(without.rejected).toMatchObject([{ reason: 'unavailable' }]);
  });

  it('offers a read-only check tool with the same verdicts and no proposal tokens', async () => {
    const tool = actionsCheckTool(async () => all, () => lookups());
    expect(tool).toMatchObject({ name: 'ui_actions_check', write: false, confirm: false, capability: 'chatty.use' });
    expect(administrationTools().some((t) => t.name === 'ui_actions_check' && !t.write)).toBe(true);
    const out = (await tool.run({} as ToolContext, {
      actions: [
        { action: 'host.engine.enable', params: { host: 'example.com', engine: 'claude' } },
        { action: 'host.engine.enable', params: { host: 'example.com', engine: 'codex' } },
      ],
    })) as { actions: Array<Record<string, unknown>> };
    expect(out.actions).toMatchObject([
      { action: 'host.engine.enable', available: true, risk: 'confirm', label: 'Claude auf example.com aktivieren' },
      { action: 'host.engine.enable', available: false, reason: 'no_change' },
    ]);
    expect(JSON.stringify(out)).not.toContain('proposal');
    expect(() => tool.parse({ actions: [{ action: 'host.delete', params: {} }] })).toThrow();
    expect(() => tool.parse({ actions: [{ action: 'versions.check', url: '/admin/x' }] })).toThrow();
  });
});
