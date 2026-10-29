import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { hosts } from '../../db/schema.js';
import type { Keyring } from '../../security/keyring.js';
import type { Capability } from '../../security/capabilities.js';
import { ENGINES, ENGINE_LABELS, ENGINE_CODEX, type Engine } from '../../util/engine.js';
import { visibleHost } from '../internal-hosts.js';
import { parseEnginesInput } from '../host-management.js';
import { readFleetEngineState } from '../engine-switch.js';
import { readFleetWindow } from '../insecure-fleet-window.js';
import { ProviderAccountsService } from '../provider-accounts.js';
import { SettingsService } from '../settings.js';
import { cleanLabel, type ActionElementResolver } from './elements.js';
import { define } from './tool-definition.js';
import type { ChattyActor } from './contracts.js';
import type { ChattyTool, ToolContext } from './tools.js';

/**
 * Chatty action buttons.
 *
 * The model proposes only `{action, params}` from the closed registry below. The
 * server validates the parameters, checks that the entity exists, that the acting
 * admin's role holds the capability of the existing admin route, that the engine
 * master switch permits it and that the change is not a no-op. Labels and the
 * confirmation copy come from the templates in this file, never from model prose.
 *
 * Nothing here mutates. A verified element carries a short-lived proposal token
 * bound to the admin user, admin session and conversation generation. The console
 * re-verifies the token (`POST /admin/chatty/proposals/verify`), shows the fresh
 * description in a confirmation dialog and then calls the SAME admin endpoint the
 * ordinary page uses for that operation, with its own capability check and audit.
 */

export const ACTION_IDS = [
  'hosts.filter',
  'activity.host',
  'host.engine.enable',
  'host.engine.disable',
  'host.auto_update',
  'host.insecure.close',
  'account.verify',
  'versions.check',
] as const;
export type ActionId = (typeof ACTION_IDS)[number];
export type ActionRisk = 'safe' | 'confirm' | 'danger';
export const MAX_ACTIONS = 3;
export const PROPOSAL_TTL_MS = 15 * 60_000;

export const HOST_STATUS_FILTERS = ['online', 'offline', 'attention'] as const;
export const HOST_FLAG_FILTERS = ['vip', 'roaming', 'secure', 'insecure', 'unprovisioned'] as const;
export const ACTIVITY_WINDOWS = ['1h', '24h', '7d'] as const;

const hostRef = z.union([
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  z.string().trim().min(1).max(191),
]);
const accountRef = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^\d{1,15}$/)]);
const engine = z.enum(ENGINES as [Engine, ...Engine[]]);

const PARAMS = {
  'hosts.filter': z
    .object({ status: z.enum(HOST_STATUS_FILTERS).optional(), flag: z.enum(HOST_FLAG_FILTERS).optional() })
    .strict()
    .refine((p) => !!(p.status || p.flag), 'status or flag is required'),
  'activity.host': z.object({ host: hostRef, window: z.enum(ACTIVITY_WINDOWS).optional() }).strict(),
  'host.engine.enable': z.object({ host: hostRef, engine }).strict(),
  'host.engine.disable': z.object({ host: hostRef, engine }).strict(),
  'host.auto_update': z.object({ host: hostRef, enabled: z.boolean() }).strict(),
  'host.insecure.close': z.object({ host: hostRef }).strict(),
  'account.verify': z.object({ account: accountRef }).strict(),
  'versions.check': z.object({}).strict(),
} satisfies Record<ActionId, z.ZodTypeAny>;

/**
 * The existing admin route each action ends at, and its capability. A unit test
 * asserts these equal `ROUTE_CAPABILITIES`, so a button is only offered to an admin
 * the route itself would admit. Navigation targets name the page's read capability.
 */
export const ACTION_SPECS: Record<ActionId, { risk: ActionRisk; capability: Capability; route: string | null }> = {
  'hosts.filter': { risk: 'safe', capability: 'hosts.read', route: null },
  'activity.host': { risk: 'safe', capability: 'audit.read', route: null },
  'host.engine.enable': { risk: 'confirm', capability: 'hosts.security_transition', route: 'POST /admin/hosts/:id/engines' },
  'host.engine.disable': { risk: 'danger', capability: 'hosts.security_transition', route: 'POST /admin/hosts/:id/engines' },
  'host.auto_update': { risk: 'confirm', capability: 'hosts.manage', route: 'POST /admin/hosts/:id/auto-update' },
  'host.insecure.close': { risk: 'confirm', capability: 'hosts.activate_insecure', route: 'POST /admin/hosts/:id/insecure/disable' },
  'account.verify': { risk: 'confirm', capability: 'auth.manage', route: 'POST /admin/accounts/:id/verify' },
  'versions.check': { risk: 'confirm', capability: 'settings.manage', route: 'POST /admin/versions/check' },
};

/** Model-facing request shape. Any extra field (url, label, body, risk) invalidates it. */
export const actionRequestSchema = z
  .object({ action: z.enum(ACTION_IDS), params: z.record(z.unknown()).default({}) })
  .strict();
export type ActionRequest = z.infer<typeof actionRequestSchema>;

export interface ActionHost {
  id: number;
  fqdn: string;
  engines: Engine[];
  secure: boolean;
  insecureUntil: Date | null;
  autoUpdateOverride: boolean | null;
}
export interface ActionAccount {
  id: number;
  label: string;
  engine: Engine;
  state: string;
}
/** Live reads; database-backed in production, injected in tests. */
export interface ActionLookups {
  host(ref: string | number): Promise<ActionHost | null>;
  account(id: number): Promise<ActionAccount | null>;
  fleetEngines(): Promise<Record<Engine, boolean>>;
  fleetInsecureWindowOpen(): Promise<boolean>;
}

/** What the console needs to call the existing endpoint; recomputed on every verification. */
export type ActionPlan =
  | { host_id: number; engine: Engine; engines_before: Engine[]; engines_after: Engine[] }
  | { host_id: number; enabled: boolean }
  | { host_id: number }
  | { account_id: number }
  | { status: string | null; flag: string | null }
  | { host_id: number; window: string | null }
  | Record<string, never>;

export interface ResolvedAction {
  action: ActionId;
  risk: ActionRisk;
  /** Canonical parameters (entity IDs, not names); these are what the proposal signs. */
  params: Record<string, string | number | boolean>;
  label: string;
  title: string;
  summary: string[];
  confirm_label: string;
  /** Danger only: the entity name the operator types to confirm. */
  confirm_text: string | null;
  target: { kind: 'host' | 'account'; id: number; name: string } | null;
  plan: ActionPlan;
}
export type ActionRefusal = {
  ok: false;
  reason: 'invalid' | 'forbidden' | 'not_found' | 'engine_disabled' | 'no_change' | 'precondition';
  detail: string;
};
export type ActionResolution = ({ ok: true } & ResolvedAction) | ActionRefusal;

const refuse = (reason: ActionRefusal['reason'], detail: string): ActionRefusal => ({ ok: false, reason, detail });
const engineList = (engines: Engine[]) => engines.map((e) => ENGINE_LABELS[e]).join(', ');
const ordered = (engines: Engine[]) => ENGINES.filter((e) => engines.includes(e));
const WINDOW_LABEL = { '1h': 'letzte Stunde', '24h': 'letzte 24 Stunden', '7d': 'letzte 7 Tage' } as const;
const STATUS_LABEL = { online: 'online', offline: 'offline', attention: 'mit Handlungsbedarf' } as const;
const FLAG_LABEL = {
  vip: 'Priorität (VIP)',
  roaming: 'IP-Wechsel erlaubt',
  secure: 'vertrauenswürdig',
  insecure: 'nicht vertrauenswürdig',
  unprovisioned: 'noch nicht angemeldet',
} as const;

/**
 * Validates one proposal against current state. Never throws for model input:
 * every unknown, malformed, forbidden or pointless request becomes a refusal.
 */
export async function resolveAction(
  raw: unknown,
  can: (capability: Capability) => boolean,
  lookups: ActionLookups,
): Promise<ActionResolution> {
  const request = actionRequestSchema.safeParse(raw);
  if (!request.success) return refuse('invalid', 'Unknown action or malformed request.');
  const { action } = request.data;
  const spec = ACTION_SPECS[action];
  const parsed = PARAMS[action].safeParse(request.data.params);
  if (!parsed.success) return refuse('invalid', parsed.error.issues[0]?.message ?? 'Invalid parameters.');
  if (!can(spec.capability)) return refuse('forbidden', 'The acting admin lacks the capability for this operation.');
  try {
    return await resolveParsed(action, parsed.data as Record<string, unknown>, lookups);
  } catch {
    return refuse('not_found', 'The target could not be read.');
  }
}

async function resolveParsed(action: ActionId, p: Record<string, unknown>, lookups: ActionLookups): Promise<ActionResolution> {
  const risk = ACTION_SPECS[action].risk;
  const done = (r: Omit<ResolvedAction, 'action' | 'risk'>): ActionResolution => ({ ok: true, action, risk, ...r });
  const host = async () => {
    const found = await lookups.host(p.host as string | number);
    return found && Number.isSafeInteger(found.id) && found.id > 0 ? found : null;
  };
  switch (action) {
    case 'hosts.filter': {
      const status = (p.status as keyof typeof STATUS_LABEL | undefined) ?? null;
      const flag = (p.flag as keyof typeof FLAG_LABEL | undefined) ?? null;
      const parts = [status ? STATUS_LABEL[status] : null, flag ? FLAG_LABEL[flag] : null].filter(Boolean);
      return done({
        params: { ...(status ? { status } : {}), ...(flag ? { flag } : {}) },
        label: `Hosts anzeigen: ${parts.join(', ')}`,
        title: 'Gefilterte Hostliste öffnen',
        summary: [`Öffnet die Hostliste mit dem Filter ${parts.join(', ')}.`],
        confirm_label: 'Öffnen',
        confirm_text: null,
        target: null,
        plan: { status, flag },
      });
    }
    case 'activity.host': {
      const h = await host();
      if (!h) return refuse('not_found', 'Host not found.');
      const window = (p.window as keyof typeof WINDOW_LABEL | undefined) ?? null;
      const name = cleanLabel(h.fqdn, 48);
      return done({
        params: { host: h.id, ...(window ? { window } : {}) },
        label: `Aktivität von ${name}${window ? ` (${WINDOW_LABEL[window]})` : ''}`,
        title: 'Gefilterte Aktivität öffnen',
        summary: [`Öffnet die Aktivität, gefiltert auf ${name}.`],
        confirm_label: 'Öffnen',
        confirm_text: null,
        target: { kind: 'host', id: h.id, name },
        plan: { host_id: h.id, window },
      });
    }
    case 'host.engine.enable':
    case 'host.engine.disable': {
      const h = await host();
      if (!h) return refuse('not_found', 'Host not found.');
      const e = p.engine as Engine;
      const name = cleanLabel(h.fqdn, 48);
      const before = ordered(h.engines);
      const label = ENGINE_LABELS[e];
      if (action === 'host.engine.enable') {
        if (before.includes(e)) return refuse('no_change', `${label} is already assigned to this host.`);
        // Mirrors assertEnginesAddable: a suspended engine cannot be newly assigned.
        if (!(await lookups.fleetEngines())[e]) return refuse('engine_disabled', `${label} is switched off fleet-wide.`);
        const after = ordered([...before, e]);
        return done({
          params: { host: h.id, engine: e },
          label: `${label} auf ${name} aktivieren`,
          title: `${label} auf ${name} aktivieren?`,
          summary: [
            `Host ${name} erhält zusätzlich die Engine ${label}.`,
            `Engines vorher: ${engineList(before)}. Danach: ${engineList(after)}.`,
            'Offene Installer-Links dieses Hosts werden ungültig; der Host übernimmt die Änderung bei seiner nächsten Synchronisierung.',
          ],
          confirm_label: `${label} aktivieren`,
          confirm_text: null,
          target: { kind: 'host', id: h.id, name },
          plan: { host_id: h.id, engine: e, engines_before: before, engines_after: after },
        });
      }
      if (!before.includes(e)) return refuse('no_change', `${label} is not assigned to this host.`);
      if (before.length <= 1) return refuse('precondition', 'A host needs at least one engine; the last one cannot be removed.');
      const after = before.filter((x) => x !== e);
      return done({
        params: { host: h.id, engine: e },
        label: `${label} auf ${name} deaktivieren`,
        title: `${label} auf ${name} deaktivieren?`,
        summary: [
          `Host ${name} verliert die Engine ${label}.`,
          `Engines vorher: ${engineList(before)}. Danach: ${engineList(after)}.`,
          `Agent-Nachrichten für ${label} auf diesem Host werden ausgesetzt, offene Installer-Links ungültig. Bei der nächsten Synchronisierung entfernt der Host Konfiguration und CLI dieser Engine.`,
          'Rückgängig: die Engine erneut aktivieren; der Host installiert sie dann neu.',
        ],
        confirm_label: `${label} deaktivieren`,
        // What the operator sees is what they type: the cleaned, untruncated name.
        confirm_text: cleanLabel(h.fqdn, 255),
        target: { kind: 'host', id: h.id, name },
        plan: { host_id: h.id, engine: e, engines_before: before, engines_after: after },
      });
    }
    case 'host.auto_update': {
      const h = await host();
      if (!h) return refuse('not_found', 'Host not found.');
      const enabled = p.enabled as boolean;
      if (h.autoUpdateOverride === enabled) return refuse('no_change', 'The host already has this auto-update override.');
      const name = cleanLabel(h.fqdn, 48);
      const state = enabled ? 'einschalten' : 'ausschalten';
      return done({
        params: { host: h.id, enabled },
        label: `Auto-Update für ${name} ${state}`,
        title: `Auto-Update für ${name} ${state}?`,
        summary: [
          `Setzt für Host ${name} eine Auto-Update-Ausnahme: ${enabled ? 'an' : 'aus'}.`,
          `Bisher: ${h.autoUpdateOverride === null ? 'Flotten-Standard' : h.autoUpdateOverride ? 'an' : 'aus'}. Die Hostseite kann die Ausnahme jederzeit ändern.`,
        ],
        confirm_label: `Auto-Update ${state}`,
        confirm_text: null,
        target: { kind: 'host', id: h.id, name },
        plan: { host_id: h.id, enabled },
      });
    }
    case 'host.insecure.close': {
      const h = await host();
      if (!h) return refuse('not_found', 'Host not found.');
      if (h.secure || !h.insecureUntil || h.insecureUntil.getTime() <= Date.now())
        return refuse('no_change', 'This host has no open insecure access window.');
      // The service refuses while the fleet window is open; do not offer what would fail.
      if (await lookups.fleetInsecureWindowOpen())
        return refuse('precondition', 'The fleet-wide insecure window is open; it must be closed first.');
      const name = cleanLabel(h.fqdn, 48);
      return done({
        params: { host: h.id },
        label: `Unsicheren Zugang von ${name} schließen`,
        title: `Unsicheren Zugang von ${name} schließen?`,
        summary: [
          `Beendet das offene Zugangsfenster von Host ${name} (bisher bis ${h.insecureUntil.toISOString()}).`,
          'Der Host kann Zugangsdaten erst nach einer neuen Freigabe wieder abrufen.',
        ],
        confirm_label: 'Zugang schließen',
        confirm_text: null,
        target: { kind: 'host', id: h.id, name },
        plan: { host_id: h.id },
      });
    }
    case 'account.verify': {
      const account = await lookups.account(Number(p.account));
      if (!account || account.state === 'removing') return refuse('not_found', 'Provider account not found.');
      if (!(await lookups.fleetEngines())[account.engine])
        return refuse('engine_disabled', `${ENGINE_LABELS[account.engine]} is switched off fleet-wide.`);
      const name = cleanLabel(account.label, 48);
      return done({
        params: { account: account.id },
        label: `Konto ${name} prüfen`,
        title: `Konto ${name} jetzt prüfen?`,
        summary: [
          `Prüft die gespeicherten ${ENGINE_LABELS[account.engine]}-Zugangsdaten des Kontos ${name} live beim Runner.`,
          'Das Ergebnis aktualisiert den Prüfstatus des Kontos; Zugangsdaten werden nicht angezeigt.',
        ],
        confirm_label: 'Konto prüfen',
        confirm_text: null,
        target: { kind: 'account', id: account.id, name },
        plan: { account_id: account.id },
      });
    }
    case 'versions.check':
      return done({
        params: {},
        label: 'Nach neuen CLI-Versionen suchen',
        title: 'Nach neuen CLI-Versionen suchen?',
        summary: [
          'Fragt die aktuellen Releases von Codex, Claude Code und Grok Build ab und aktualisiert die Versionsanzeige.',
          'Es wird nichts installiert und keine Version festgelegt.',
        ],
        confirm_label: 'Versionen prüfen',
        confirm_text: null,
        target: null,
        plan: {},
      });
  }
}

/** Production lookups; internal hosts never resolve. */
export function databaseActionLookups(c: Pick<ToolContext, 'db' | 'keyring'>): ActionLookups {
  return {
    async host(ref) {
      const where =
        typeof ref === 'number' || /^\d{1,15}$/.test(ref) ? eq(hosts.id, Number(ref)) : eq(hosts.fqdn, ref);
      const row = (
        await c.db
          .select({
            id: hosts.id,
            fqdn: hosts.fqdn,
            engines: hosts.engines,
            secure: hosts.secure,
            insecureEnabledUntil: hosts.insecureEnabledUntil,
            autoUpdateOverride: hosts.autoUpdateOverride,
          })
          .from(hosts)
          .where(and(where, visibleHost))
          .limit(1)
      )[0];
      if (!row) return null;
      const until = row.insecureEnabledUntil ? new Date(row.insecureEnabledUntil as unknown as string) : null;
      return {
        id: row.id,
        fqdn: row.fqdn,
        engines: parseEnginesInput(row.engines, [ENGINE_CODEX]),
        secure: row.secure === 1,
        insecureUntil: until && !Number.isNaN(until.getTime()) ? until : null,
        autoUpdateOverride: row.autoUpdateOverride === null || row.autoUpdateOverride === undefined ? null : row.autoUpdateOverride === 1,
      };
    },
    async account(id) {
      try {
        const account = await new ProviderAccountsService(c.db, c.keyring).get(id);
        return { id: account.id, label: account.label, engine: account.engine as Engine, state: account.state };
      } catch {
        return null;
      }
    },
    async fleetEngines() {
      return { ...(await readFleetEngineState(c.db)) };
    },
    async fleetInsecureWindowOpen() {
      return (await readFleetWindow(new SettingsService(c.db))).open;
    },
  };
}

// ── Proposal tokens ─────────────────────────────────────────────────────────

export interface ProposalBinding extends ChattyActor {
  generation: number;
}
interface ProposalPayload {
  a: ActionId;
  p: Record<string, string | number | boolean>;
  e: number;
  n: string;
}
const TOKEN = /^v1\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{1,1400})\.([A-Za-z0-9_-]{43})$/;

function mac(keyring: Keyring, kid: string, binding: ProposalBinding, payload: string): Buffer | null {
  const key = keyring.keyFor(kid);
  if (!key) return null;
  const framed = JSON.stringify(['chatty-action-proposal-v1', kid, binding.userId, binding.sessionId, binding.generation, payload]);
  return createHmac('sha256', Buffer.from(key.key)).update(framed).digest();
}

/** Opaque, stateless proposal ID: HMAC-bound to user, admin session and conversation generation. */
export function mintProposal(
  keyring: Keyring,
  binding: ProposalBinding,
  action: ActionId,
  params: Record<string, string | number | boolean>,
  now = Date.now(),
): { proposal: string; expires_at: string } {
  const kid = keyring.active().kid;
  const expires = now + PROPOSAL_TTL_MS;
  const payload = Buffer.from(
    JSON.stringify({ a: action, p: params, e: expires, n: randomBytes(9).toString('base64url') } satisfies ProposalPayload),
  ).toString('base64url');
  const kidPart = Buffer.from(kid).toString('base64url');
  return {
    proposal: `v1.${kidPart}.${payload}.${mac(keyring, kid, binding, payload)!.toString('base64url')}`,
    expires_at: new Date(expires).toISOString(),
  };
}

/** Returns the signed request, or null for a foreign, tampered, expired or other-session token. */
export function openProposal(
  keyring: Keyring,
  binding: ProposalBinding,
  token: string,
  now = Date.now(),
): { action: ActionId; params: Record<string, string | number | boolean>; expires_at: string } | null {
  const match = TOKEN.exec(token);
  if (!match) return null;
  const kid = Buffer.from(match[1]!, 'base64url').toString('utf8');
  const expected = mac(keyring, kid, binding, match[2]!);
  const given = Buffer.from(match[3]!, 'base64url');
  if (!expected || given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: ProposalPayload;
  try {
    payload = JSON.parse(Buffer.from(match[2]!, 'base64url').toString('utf8')) as ProposalPayload;
  } catch {
    return null;
  }
  if (!(ACTION_IDS as readonly string[]).includes(payload.a) || !Number.isFinite(payload.e) || payload.e <= now) return null;
  return { action: payload.a, params: payload.p, expires_at: new Date(payload.e).toISOString() };
}

/** The element stored with the answer and rendered by the console. */
export interface ActionElement {
  type: 'action';
  action: ActionId;
  risk: ActionRisk;
  label: string;
  params: Record<string, string | number | boolean>;
  proposal: string;
  expires_at: string;
}

export function actionElement(resolved: ResolvedAction, keyring: Keyring, binding: ProposalBinding): ActionElement {
  return {
    type: 'action',
    action: resolved.action,
    risk: resolved.risk,
    label: resolved.label,
    params: resolved.params,
    ...mintProposal(keyring, binding, resolved.action, resolved.params),
  };
}

/** Answer-time resolver: verified requests become signed elements, everything else a refusal. */
export function actionElementResolver(
  keyring: Keyring,
  binding: ProposalBinding,
  can: (capability: Capability) => boolean,
  lookups: ActionLookups,
): ActionElementResolver {
  return async (request) => {
    const resolved = await resolveAction(request, can, lookups);
    return resolved.ok ? { ok: true, element: actionElement(resolved, keyring, binding) } : { ok: false, detail: resolved.detail };
  };
}

/**
 * Re-verifies a proposal for the current request: token binding and expiry, then
 * the full registry check against current state with the signed canonical params.
 */
export async function verifyProposal(
  token: string,
  binding: ProposalBinding,
  keyring: Keyring,
  can: (capability: Capability) => boolean,
  lookups: ActionLookups,
): Promise<({ ok: true; expires_at: string } & ResolvedAction) | ActionRefusal | { ok: false; reason: 'expired'; detail: string }> {
  const opened = openProposal(keyring, binding, token);
  if (!opened)
    return { ok: false, reason: 'expired', detail: 'Dieser Vorschlag ist abgelaufen oder gehört zu einer anderen Sitzung. Frag Chatty erneut.' };
  const resolved = await resolveAction({ action: opened.action, params: opened.params }, can, lookups);
  return resolved.ok ? { ...resolved, expires_at: opened.expires_at } : resolved;
}

const PARAM_HELP =
  'hosts.filter {status?: online|offline|attention, flag?: vip|roaming|secure|insecure|unprovisioned}; ' +
  'activity.host {host: FQDN or ID, window?: 1h|24h|7d}; ' +
  'host.engine.enable / host.engine.disable {host, engine: codex|claude|grok}; ' +
  'host.auto_update {host, enabled: boolean}; host.insecure.close {host}; ' +
  'account.verify {account: ID}; versions.check {}';

/**
 * Read-only check the model uses before attaching an action button. It runs the
 * same resolver as the answer, but mints nothing and changes nothing.
 */
export function actionsCheckTool(
  access: (c: ToolContext) => Promise<(capability: Capability) => boolean>,
  lookups: (c: ToolContext) => ActionLookups = databaseActionLookups,
): ChattyTool {
  return define(
    'ui_actions_check',
    `Check proposed console action buttons before attaching them to an answer. Read-only: nothing is executed; the operator must click and confirm each mutation in the console. Actions: ${PARAM_HELP}. Returns availability, risk and the server label, or why it is unavailable.`,
    'chatty.use',
    { actions: z.array(z.object({ action: z.enum(ACTION_IDS), params: z.record(z.unknown()).optional() }).strict()).min(1).max(MAX_ACTIONS) },
    async (c, a) => {
      const can = await access(c);
      const source = lookups(c);
      const results = [];
      for (const item of a.actions) {
        const r = await resolveAction({ action: item.action, params: item.params ?? {} }, can, source);
        results.push(
          r.ok
            ? { action: item.action, params: r.params, available: true, risk: r.risk, label: r.label }
            : { action: item.action, available: false, reason: r.reason, detail: r.detail },
        );
      }
      return {
        actions: results,
        instruction:
          'Attach only available actions as {"type":"action","action":...,"params":...}. They are buttons the operator may confirm; never claim the action ran.',
      };
    },
  );
}
