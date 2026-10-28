import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { adminUsers, coordProjects, hosts } from '../../db/schema.js';
import { ownerRuntimeFor } from '../../control-plane/state/runtime.js';
import { roleHasCapability, type Capability } from '../../security/capabilities.js';
import { visibleHost } from '../internal-hosts.js';
import { SkillsService } from '../skills.js';
import { ClaudeArtifactsService } from '../claude-artifacts.js';
import { ProviderAccountsService } from '../provider-accounts.js';
import { ManualStore } from '../manual-articles.js';
import { SettingsService } from '../settings.js';
import { WorkflowsService } from '../workflows.js';
import { define } from './tool-definition.js';
import type { ChattyTool, ToolContext } from './tools.js';

/**
 * Rich reply elements.
 *
 * The model names targets symbolically ({kind:'host', ref:'example.com'}); it never
 * supplies a URL or a label. This module checks each reference against a closed
 * route template set, confirms the entity exists and that the acting admin holds the
 * read capability, and only then builds a base-relative path and a server label.
 * Everything else is dropped and reported back so the answer cannot claim it.
 */

export const LINK_KINDS = [
  'host',
  'project',
  'skill',
  'subagent',
  'command',
  'output-style',
  'workflow',
  'workflow_run',
  'account',
  'manual',
  'page',
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];
export const PROJECT_VIEWS = ['board', 'documents', 'reports', 'activity'] as const;

/** Base-relative console destinations (SvelteKit adds `/admin`). Keys are what the model may name. */
export const PAGE_TARGETS = {
  dashboard: { path: '/dashboard', label: 'Übersicht', capability: 'admin.read' },
  hosts: { path: '/hosts', label: 'Hosts', capability: 'hosts.read' },
  agents: { path: '/agents', label: 'Agents', capability: 'agent_portal.read' },
  projects: { path: '/projects', label: 'Projekte', capability: 'projects.read' },
  messages: { path: '/agent-messaging', label: 'Nachrichten', capability: 'agent_messaging.read' },
  schedules: { path: '/schedules', label: 'Zeitgesteuerte Weckrufe', capability: 'agent_messaging.read' },
  'git-director': { path: '/git-director', label: 'Git-Merges', capability: 'git_director.read' },
  transfers: { path: '/transfers', label: 'Geteilte Dateien', capability: 'transfers.read' },
  workflows: { path: '/workflows', label: 'Workflows', capability: 'workflows.read' },
  'workflow-runs': { path: '/workflows/runs', label: 'Workflow-Läufe', capability: 'workflows.read' },
  activity: { path: '/activity', label: 'Aktivität', capability: 'audit.read' },
  reports: { path: '/reports', label: 'Berichte', capability: 'feedback.read' },
  accounts: { path: '/accounts', label: 'Konten', capability: 'auth.read_metadata' },
  engines: { path: '/engines', label: 'Engines', capability: 'settings.read' },
  'engine-state': { path: '/engines#engine-state', label: 'Engine-Schalter', capability: 'settings.read' },
  limits: { path: '/limits', label: 'Nutzungslimits', capability: 'settings.read' },
  'quota-enforcement': { path: '/limits#quota-enforcement', label: 'Kontingentdurchsetzung', capability: 'settings.read' },
  scaling: { path: '/limits#scaling-rules', label: 'Nutzungsbasierte Skalierung', capability: 'settings.read' },
  library: { path: '/library', label: 'Bibliothek', capability: 'content.read' },
  'agent-rules': { path: '/library/agent-rules', label: 'Agent-Regeln', capability: 'content.read' },
  memories: { path: '/library?type=memories', label: 'Erinnerungen', capability: 'memory.read' },
  roles: { path: '/library?type=roles', label: 'Rollen', capability: 'content.read' },
  people: { path: '/people', label: 'Personen', capability: 'users.read' },
  'api-keys': { path: '/api-keys', label: 'API-Schlüssel', capability: 'auth.read_metadata' },
  secrets: { path: '/secrets', label: 'Secrets', capability: 'secrets.read_metadata' },
  settings: { path: '/settings', label: 'Einstellungen', capability: 'settings.read' },
  chatty: { path: '/settings#chatty', label: 'Chatty-Einstellungen', capability: 'settings.read' },
  'host-settings': { path: '/settings#hosts', label: 'Host-Einstellungen', capability: 'settings.read' },
  retention: { path: '/settings#retention', label: 'Datenaufbewahrung', capability: 'settings.read' },
  supervisor: { path: '/settings#agent-supervisor', label: 'Agent-Supervisor', capability: 'settings.read' },
  manual: { path: '/manual', label: 'Handbuch', capability: 'admin.read' },
  account: { path: '/account', label: 'Mein Konto', capability: 'account.self_manage' },
} as const satisfies Record<string, { path: string; label: string; capability: Capability }>;
export type PageTarget = keyof typeof PAGE_TARGETS;

const ref = z.string().trim().min(1).max(191);
/** One element as the model may write it. Strict: no href, label, url or extra field is accepted. */
export const elementRequestSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('link'),
      kind: z.enum(LINK_KINDS),
      ref,
      view: z.enum(PROJECT_VIEWS).optional(),
    })
    .strict(),
  z.object({ type: z.literal('suggestion'), text: z.string().trim().min(1).max(160) }).strict(),
]);
export type ElementRequest = z.infer<typeof elementRequestSchema>;
export const MAX_ELEMENTS = 8;
const MAX_LINKS = 6;
const MAX_SUGGESTIONS = 4;

export type ChattyElement =
  | { type: 'link'; kind: LinkKind; label: string; path: string }
  | { type: 'suggestion'; text: string };
export interface RejectedElement {
  index: number;
  kind?: string;
  ref?: string;
  reason: 'invalid' | 'unavailable' | 'limit';
}

/** Entity lookups; database-backed in production, injected in tests. */
export interface ElementLookups {
  host(ref: string): Promise<{ id: number; fqdn: string } | null>;
  project(slug: string): Promise<{ slug: string } | null>;
  skill(slug: string): Promise<{ slug: string } | null>;
  artifact(kind: 'subagent' | 'command' | 'output-style', slug: string): Promise<{ slug: string } | null>;
  workflow(ref: string): Promise<{ slug: string; title: string } | null>;
  workflowRun(id: string): Promise<{ id: string } | null>;
  account(id: number): Promise<{ id: number; label: string } | null>;
  manual(slug: string): Promise<{ slug: string; title: string } | null>;
}

const CAPABILITY: Record<Exclude<LinkKind, 'page'>, Capability> = {
  host: 'hosts.read',
  project: 'projects.read',
  skill: 'content.read',
  subagent: 'content.read',
  command: 'content.read',
  'output-style': 'content.read',
  workflow: 'workflows.read',
  workflow_run: 'workflows.read',
  account: 'auth.read_metadata',
  manual: 'admin.read',
};
const ARTIFACT_LABEL = { subagent: 'Subagent', command: 'Befehl', 'output-style': 'Antwortstil' } as const;
const ARTIFACT_PATH = { subagent: 'subagents', command: 'commands', 'output-style': 'output-styles' } as const;
const VIEW_LABEL = { board: 'Board', documents: 'Dokumente', reports: 'Berichte', activity: 'Aktivität' } as const;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;
const MANUAL_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Control, zero-width and bidirectional formatting characters that could disguise a label. */
const hidden = (code: number) =>
  code <= 0x1f ||
  (code >= 0x7f && code <= 0x9f) ||
  (code >= 0x200b && code <= 0x200f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069) ||
  code === 0xfeff;

/** Plain text, one line, no control or bidirectional override characters, bounded. */
export function cleanLabel(value: string, max = 60) {
  const text = Array.from(value, (char) => (hidden(char.codePointAt(0)!) ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Final gate: only base-relative paths built from the templates above can leave this module. */
const ALLOWED_PATH =
  /^\/(?:dashboard|hosts|agents|projects|agent-messaging|schedules|git-director|transfers|workflows|activity|reports|accounts|engines|limits|library|people|api-keys|secrets|settings|manual|account)(?:\/[A-Za-z0-9._~%-]+)*(?:\?type=[a-z-]+)?(?:#[a-z-]+)?$/;
export function safePath(path: string) {
  return ALLOWED_PATH.test(path) && !path.includes('//') && !/(^|\/)\.\.?(\/|$|\?|#)/.test(path);
}

async function resolveLink(
  item: Extract<ElementRequest, { type: 'link' }>,
  lookups: ElementLookups,
  can: (capability: Capability) => boolean,
): Promise<{ label: string; path: string } | null> {
  if (item.kind === 'page') {
    const page = PAGE_TARGETS[item.ref as PageTarget];
    if (!Object.hasOwn(PAGE_TARGETS, item.ref) || !page || !can(page.capability)) return null;
    return { label: `${page.label} öffnen`, path: page.path };
  }
  if (!can(CAPABILITY[item.kind])) return null;
  if (item.view && item.kind !== 'project') return null;
  switch (item.kind) {
    case 'host': {
      const host = await lookups.host(item.ref);
      return host && Number.isSafeInteger(host.id) && host.id > 0
        ? { label: `Host ${cleanLabel(host.fqdn, 48)} öffnen`, path: `/hosts/${host.id}` }
        : null;
    }
    case 'project': {
      const project = SLUG.test(item.ref) ? await lookups.project(item.ref) : null;
      if (!project) return null;
      const name = cleanLabel(project.slug, 40);
      return item.view
        ? { label: `${VIEW_LABEL[item.view]} von ${name} öffnen`, path: `/projects/${encodeURIComponent(project.slug)}/${item.view}` }
        : { label: `Projekt ${name} öffnen`, path: `/projects/${encodeURIComponent(project.slug)}` };
    }
    case 'skill': {
      const skill = SLUG.test(item.ref) ? await lookups.skill(item.ref) : null;
      return skill
        ? { label: `Skill ${cleanLabel(skill.slug, 48)} öffnen`, path: `/library/skills/${encodeURIComponent(skill.slug)}` }
        : null;
    }
    case 'subagent':
    case 'command':
    case 'output-style': {
      const artifact = SLUG.test(item.ref) ? await lookups.artifact(item.kind, item.ref) : null;
      return artifact
        ? {
            label: `${ARTIFACT_LABEL[item.kind]} ${cleanLabel(artifact.slug, 44)} öffnen`,
            path: `/library/${ARTIFACT_PATH[item.kind]}/${encodeURIComponent(artifact.slug)}`,
          }
        : null;
    }
    case 'workflow': {
      const workflow = SLUG.test(item.ref) ? await lookups.workflow(item.ref) : null;
      return workflow
        ? {
            label: `Workflow ${cleanLabel(workflow.title || workflow.slug, 44)} öffnen`,
            path: `/workflows/definitions/${encodeURIComponent(workflow.slug)}`,
          }
        : null;
    }
    case 'workflow_run': {
      const run = UUID.test(item.ref) ? await lookups.workflowRun(item.ref) : null;
      return run && UUID.test(run.id) ? { label: 'Workflow-Lauf öffnen', path: `/workflows/runs/${run.id.toLowerCase()}` } : null;
    }
    case 'account': {
      // Accounts have no detail route; the button opens the list after the account is confirmed.
      const account = /^\d{1,15}$/.test(item.ref) ? await lookups.account(Number(item.ref)) : null;
      return account ? { label: `Konten öffnen (${cleanLabel(account.label, 36)})`, path: '/accounts' } : null;
    }
    case 'manual': {
      const article = MANUAL_SLUG.test(item.ref) ? await lookups.manual(item.ref) : null;
      return article
        ? { label: `Hilfe: ${cleanLabel(article.title, 52)}`, path: `/manual/${article.slug}` }
        : null;
    }
  }
}

/**
 * Turns model-written element requests into renderable elements. Never throws for
 * model input: every invalid, unknown, forbidden or surplus entry becomes a rejection.
 */
export async function resolveElements(
  raw: readonly unknown[],
  can: (capability: Capability) => boolean,
  lookups: ElementLookups,
): Promise<{ elements: ChattyElement[]; rejected: RejectedElement[] }> {
  const elements: ChattyElement[] = [];
  const rejected: RejectedElement[] = [];
  const seen = new Set<string>();
  let links = 0;
  let suggestions = 0;
  for (const [index, value] of raw.slice(0, MAX_ELEMENTS).entries()) {
    const parsed = elementRequestSchema.safeParse(value);
    if (!parsed.success) {
      rejected.push({ index, reason: 'invalid' });
      continue;
    }
    const item = parsed.data;
    if (item.type === 'suggestion') {
      const text = cleanLabel(item.text, 160);
      if (!text || seen.has(`s:${text}`)) continue;
      if (suggestions >= MAX_SUGGESTIONS) {
        rejected.push({ index, reason: 'limit' });
        continue;
      }
      seen.add(`s:${text}`);
      suggestions++;
      elements.push({ type: 'suggestion', text });
      continue;
    }
    let link: { label: string; path: string } | null = null;
    try {
      link = await resolveLink(item, lookups, can);
    } catch {
      link = null;
    }
    if (!link || !safePath(link.path) || !link.label) {
      rejected.push({ index, kind: item.kind, ref: cleanLabel(item.ref, 80), reason: 'unavailable' });
      continue;
    }
    if (seen.has(`l:${link.path}`)) continue;
    if (links >= MAX_LINKS) {
      rejected.push({ index, kind: item.kind, ref: cleanLabel(item.ref, 80), reason: 'limit' });
      continue;
    }
    seen.add(`l:${link.path}`);
    links++;
    elements.push({ type: 'link', kind: item.kind, label: link.label, path: link.path });
  }
  for (let index = MAX_ELEMENTS; index < raw.length; index++) rejected.push({ index, reason: 'limit' });
  return { elements, rejected };
}

const nullOnMissing = async <T>(fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch {
    return null;
  }
};

/** Production lookups; every read hides internal hosts and soft-deleted content. */
export function databaseLookups(c: ToolContext, manual = new ManualStore(c.env.STATIC_ROOT)): ElementLookups {
  return {
    async host(value) {
      const where = /^\d{1,15}$/.test(value) ? eq(hosts.id, Number(value)) : eq(hosts.fqdn, value);
      const row = (
        await c.db.select({ id: hosts.id, fqdn: hosts.fqdn }).from(hosts).where(and(where, visibleHost)).limit(1)
      )[0];
      return row ? { id: row.id, fqdn: row.fqdn } : null;
    },
    async project(slug) {
      const row = (
        await c.db.select({ slug: coordProjects.slug }).from(coordProjects).where(eq(coordProjects.slug, slug)).limit(1)
      )[0];
      return row ?? null;
    },
    async skill(slug) {
      const skill = await new SkillsService(c.db).find(slug);
      return skill && !skill.deleted_at ? { slug: skill.slug } : null;
    },
    async artifact(kind, slug) {
      return nullOnMissing(async () => {
        const artifact = await new ClaudeArtifactsService(c.db).requireBySlug(kind, slug);
        return (artifact as { deleted_at?: string | null }).deleted_at ? null : { slug: artifact.slug };
      });
    },
    async workflow(value) {
      return nullOnMissing(async () => {
        const workflow = await workflowService(c).get(value);
        return { slug: workflow.slug, title: String(workflow.title ?? '') };
      });
    },
    async workflowRun(id) {
      return nullOnMissing(async () => {
        await workflowService(c).runGet(id, { limit: 1 });
        return { id };
      });
    },
    async account(id) {
      return nullOnMissing(async () => {
        const account = await new ProviderAccountsService(c.db, c.keyring).get(id);
        return account.state === 'removing' ? null : { id: account.id, label: account.label };
      });
    },
    async manual(slug) {
      const article = manual.article(slug);
      return article ? { slug: article.slug, title: article.meta.title || article.slug } : null;
    },
  };
}
const workflowService = (c: ToolContext) =>
  new WorkflowsService({
    db: c.db,
    settings: new SettingsService(c.db),
    keyring: c.keyring,
    publicBaseUrl: c.env.PUBLIC_BASE_URL,
  });

export const capabilityChecker = (accessLevel: string) => (capability: Capability) =>
  roleHasCapability(accessLevel, capability);

/** The acting admin's current role; an unknown or inactive account holds nothing. */
export async function actorAccess(c: ToolContext) {
  const owner = ownerRuntimeFor(c.db);
  const user = owner
    ? owner.state.snapshot().table('adminUsers').get(c.actor.userId)
    : (await c.db.select().from(adminUsers).where(eq(adminUsers.id, c.actor.userId)).limit(1))[0];
  return user?.active ? capabilityChecker(user.accessLevel) : () => false;
}

const linkRequest = z
  .object({ kind: z.enum(LINK_KINDS), ref, view: z.enum(PROJECT_VIEWS).optional() })
  .strict();

/**
 * Read-only check the model uses before promising a button: the same resolver the
 * answer goes through, so a link reported available here is one the reply can carry.
 */
export function linksCheckTool(
  access: (c: ToolContext) => Promise<(capability: Capability) => boolean> = actorAccess,
  lookups: (c: ToolContext) => ElementLookups = databaseLookups,
): ChattyTool {
  return define(
    'ui_links_check',
    `Check console links for an answer: host (FQDN or ID), project (slug, optional view), skill, subagent, command, output-style, workflow (slug), workflow_run (UUID), account (ID), manual (help article slug) or page (named console page). Returns which references can become buttons. Attach them as answer elements; never write URLs. Page names: ${Object.keys(PAGE_TARGETS).join(', ')}.`,
    'chatty.use',
    { links: z.array(linkRequest).min(1).max(MAX_ELEMENTS) },
    async (c, a) => {
      const can = await access(c);
      const source = lookups(c);
      const results = [];
      for (const link of a.links) {
        const { elements } = await resolveElements([{ type: 'link', ...link }], can, source);
        const element = elements[0];
        results.push(
          element?.type === 'link'
            ? { ...link, available: true, label: element.label }
            : { ...link, available: false },
        );
      }
      return {
        links: results,
        instruction:
          'Only available links can become buttons. Do not mention a button for an unavailable reference.',
      };
    },
  );
}
