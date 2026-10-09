import { z } from 'zod';
import { eq, like, desc, and } from 'drizzle-orm';
import type { RouteContext } from '../../routes/index.js';
import type { Capability } from '../../security/capabilities.js';
import { ConflictError, NotFoundError } from '../../http/errors.js';
import {
  hosts,
  skills,
  providerAccounts,
  coordProjects,
  adminUsers,
  logs,
  versions,
  sharedMemories,
  agentsDocuments,
  clientConfigDocuments,
  claudeArtifacts,
  coordProjectNotes,
  openaiApiKeys,
  agentWatchdogs,
} from '../../db/schema.js';
import { ProjectContentService } from '../project-content.js';
import { HostProjectsService } from '../host-projects.js';
import { OpenAiKeyService } from '../openai-keys.js';
import { AgentTransfersService } from '../agent-transfers.js';
import { SkillsService } from '../skills.js';
import { ProjectsService } from '../projects.js';
import { ProviderAccountsService } from '../provider-accounts.js';
import { HostManagementService } from '../host-management.js';
import { makeAdminEventsWriter } from '../admin-events-writer.js';
import { listEngineStates, setFleetEngineEnabled, ENGINE_DISABLED_FLAGS } from '../engine-switch.js';
import { SettingsService } from '../settings.js';
import { SchedulesService } from '../schedules.js';
import { SharedMemoriesService } from '../shared-memories.js';
import { AgentsService } from '../agents.js';
import { ClientConfigService } from '../client-config.js';
import { ClaudeArtifactsService } from '../claude-artifacts.js';
import { AdminAuthService } from '../admin-auth.js';
import { AdminUsersService } from '../admin-users.js';
import { AdminEventsService } from '../admin-events.js';
import { SecretsService } from '../secrets.js';
import { GitDirectorService } from '../git-director.js';
import { ProjectBoardService } from '../project-board.js';
import { WatchdogsService } from '../watchdogs.js';
import { engineSchema, modelSafe, signature, type ChattyActor } from './contracts.js';

export interface ToolContext extends RouteContext {
  actor: ChattyActor;
}
export interface ChattyTool {
  name: string;
  description: string;
  capability: Capability;
  write: boolean;
  confirm: boolean;
  parameters: Record<string, unknown>;
  parse: (args: unknown) => Record<string, unknown>;
  snapshot?: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
  href?: (args: Record<string, unknown>) => string;
}

/** The subset of Zod used in this registry; unknown types fail at registration. */
export function jsonSchema(s: z.ZodTypeAny): Record<string, unknown> {
  const d = s._def;
  if (s instanceof z.ZodOptional || s instanceof z.ZodDefault) return jsonSchema(d.innerType);
  if (s instanceof z.ZodNullable) return { anyOf: [jsonSchema(d.innerType), { type: 'null' }] };
  if (s instanceof z.ZodString)
    return {
      type: 'string',
      ...(d.description ? { description: d.description } : {}),
      ...Object.fromEntries(
        d.checks
          .filter((c: { kind: string }) => ['min', 'max'].includes(c.kind))
          .map((c: { kind: string; value: number }) => [
            c.kind === 'min' ? 'minLength' : 'maxLength',
            c.value,
          ]),
      ),
    };
  if (s instanceof z.ZodNumber)
    return { type: d.checks.some((c: { kind: string }) => c.kind === 'int') ? 'integer' : 'number' };
  if (s instanceof z.ZodBoolean) return { type: 'boolean' };
  if (s instanceof z.ZodEnum) return { type: 'string', enum: d.values };
  if (s instanceof z.ZodLiteral) return { const: d.value };
  if (s instanceof z.ZodRecord) return { type: 'object', additionalProperties: true };
  if (s instanceof z.ZodArray) return { type: 'array', items: jsonSchema(d.type) };
  if (s instanceof z.ZodObject) {
    const fields = d.shape() as Record<string, z.ZodTypeAny>;
    return {
      type: 'object',
      properties: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, jsonSchema(v)])),
      required: Object.entries(fields)
        .filter(([, v]) => !v.isOptional())
        .map(([k]) => k),
      additionalProperties: false,
    };
  }
  throw new Error(`Unsupported Chatty tool schema: ${d.typeName}`);
}

function define<S extends z.ZodRawShape>(
  name: string,
  description: string,
  capability: Capability,
  shape: S,
  run: (ctx: ToolContext, args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  options: {
    confirm?: boolean;
    snapshot?: (ctx: ToolContext, args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
    href?: (args: z.infer<z.ZodObject<S>>) => string;
  } = {},
): ChattyTool {
  const schema = z.object(shape).strict();
  return {
    name,
    description,
    capability,
    parameters: jsonSchema(schema),
    write: !!options.snapshot,
    confirm: options.confirm ?? false,
    parse: (args) => schema.parse(args),
    run: (ctx, args) => run(ctx, schema.parse(args)),
    snapshot: options.snapshot ? (ctx, args) => options.snapshot!(ctx, schema.parse(args)) : undefined,
    href: options.href ? (args) => options.href!(schema.parse(args)) : undefined,
  };
}
const id = z.number().int().positive();
const slug = z.string().min(1).max(191);
const text = z.string().min(1).max(60000);
const query = z.string().max(200).default('');
const project = (c: ToolContext) => new ProjectsService(c.db);
const host = (c: ToolContext) =>
  new HostManagementService({
    db: c.db,
    env: c.env,
    keyring: c.keyring,
    events: makeAdminEventsWriter(c.db),
  });
const content = (c: ToolContext) => new ProjectContentService(c.db, project(c));
const board = (c: ToolContext) =>
  new ProjectBoardService({
    db: c.db,
    projects: new HostProjectsService(c.db),
    settings: new SettingsService(c.db),
  });
const account = (c: ToolContext) => new ProviderAccountsService(c.db, c.keyring);
const user = (c: ToolContext) =>
  new AdminUsersService(c.db, new AdminAuthService(c.db, c.env), new AdminEventsService(c.db));
const hostSnapshot = async (c: ToolContext, a: { id: number }) =>
  modelSafe((await c.db.select().from(hosts).where(eq(hosts.id, a.id)).for('update'))[0] ?? null);
const skillSnapshot = async (c: ToolContext, a: { slug: string }) =>
  (await c.db.select().from(skills).where(eq(skills.slug, a.slug)).for('update'))[0] ?? null;
const projectSnapshot = async (c: ToolContext, a: { slug: string }) =>
  (await c.db.select().from(coordProjects).where(eq(coordProjects.slug, a.slug)).for('update'))[0] ?? null;
const accountSnapshot = async (c: ToolContext, a: { id: number }) =>
  modelSafe(
    (await c.db.select().from(providerAccounts).where(eq(providerAccounts.id, a.id)).for('update'))[0] ??
      null,
  );
const userSnapshot = async (c: ToolContext, a: { id: number }) =>
  modelSafe((await c.db.select().from(adminUsers).where(eq(adminUsers.id, a.id)).for('update'))[0] ?? null);

async function configRead(c: ToolContext, engine: 'codex' | 'claude' | 'grok') {
  const { content: _content, ...view } = await new ClientConfigService(c.db).adminFetch(engine);
  return modelSafe(view);
}
function mergeSettings(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key))
      throw new ConflictError('Invalid settings key');
    const previous = merged[key];
    if (key === 'mcp_servers' && Array.isArray(value) && Array.isArray(previous)) {
      // Configuration reads hide credentials. Match named servers before patching
      // so editing their public fields cannot erase omitted env/header secrets.
      merged[key] = value.map((entry: unknown) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
        const patchEntry = entry as Record<string, unknown>;
        const existing = previous.find((server) => server?.name === patchEntry.name);
        return existing ? mergeSettings(existing, patchEntry) : patchEntry;
      });
      continue;
    }
    merged[key] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      previous &&
      typeof previous === 'object' &&
      !Array.isArray(previous)
        ? mergeSettings(previous as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return merged;
}
/** Each entry invokes a named domain operation; no arbitrary HTTP, SQL or code. */
export function administrationTools(): ChattyTool[] {
  const tools: ChattyTool[] = [
    define(
      'hosts_search',
      'Find registered hosts by FQDN. Resolve exact IDs before changes.',
      'hosts.read',
      { query },
      async (c, a) =>
        modelSafe(
          await c.db
            .select()
            .from(hosts)
            .where(like(hosts.fqdn, `%${a.query}%`))
            .limit(50),
        ),
    ),
    define(
      'host_read',
      'Read a host configuration and current reported state.',
      'hosts.read',
      { id },
      async (c, a) => modelSafe(await host(c).requireById(a.id)),
    ),
    define(
      'host_delete',
      'Delete a registered host and revoke its managed access.',
      'hosts.security_transition',
      { id },
      async (c, a) => host(c).delete(a.id),
      { confirm: true, snapshot: hostSnapshot },
    ),
    define(
      'host_engines',
      'Set the engines assigned to an existing host.',
      'hosts.security_transition',
      { id, engines: z.array(engineSchema).min(1).max(3) },
      async (c, a) => modelSafe(await host(c).setEngines(a.id, a.engines)),
      { confirm: true, snapshot: hostSnapshot },
    ),
    define(
      'accounts_list',
      'List provider accounts, verification and quota metadata. No credentials.',
      'auth.read_metadata',
      {},
      async (c) => modelSafe(await account(c).list()),
    ),
    define(
      'account_update',
      'Rename, pause or enable a provider account.',
      'auth.manage',
      { id, label: z.string().min(1).max(191).optional(), state: z.enum(['enabled', 'paused']).optional() },
      async (c, a) => {
        await account(c).update(a.id, { label: a.label, state: a.state });
        return modelSafe(await account(c).get(a.id));
      },
      { confirm: true, snapshot: accountSnapshot, href: () => '/admin/accounts' },
    ),
    define(
      'account_remove',
      'Retire an account after its active leases drain.',
      'auth.manage',
      { id },
      async (c, a) => {
        await account(c).update(a.id, { state: 'removing' });
        return { status: 'removing', id: a.id };
      },
      { confirm: true, snapshot: accountSnapshot },
    ),
    define('engines_read', 'Read fleet engine master switches and effects.', 'settings.read', {}, async (c) =>
      listEngineStates(c.db),
    ),
    define(
      'engine_set',
      'Enable or suspend an engine fleet-wide; assignments and accounts are retained.',
      'settings.manage',
      { engine: engineSchema, enabled: z.boolean() },
      async (c, a) => setFleetEngineEnabled(c.db, a.engine, a.enabled, `admin:${c.actor.userId}`),
      {
        confirm: true,
        snapshot: async (c, a) =>
          (
            await c.db
              .select()
              .from(versions)
              .where(eq(versions.name, ENGINE_DISABLED_FLAGS[a.engine]))
              .for('update')
          )[0] ?? null,
        href: () => '/admin/settings',
      },
    ),
    define(
      'skills_search',
      'Find skills, including managed skills; use before authoring.',
      'content.read',
      { query },
      async (c, a) =>
        (await new SkillsService(c.db).list())
          .filter((s) =>
            `${s.slug} ${s.display_name} ${s.description}`.toLowerCase().includes(a.query.toLowerCase()),
          )
          .slice(0, 50)
          .map(({ manifest: _manifest, ...s }) => s),
    ),
    define(
      'skill_read',
      'Read the complete current skill manifest and ownership. Read skill-manager before authoring.',
      'content.read',
      { slug, offset: z.number().int().min(0).default(0) },
      async (c, a) => {
        const value = await new SkillsService(c.db).find(a.slug);
        if (!value) return null;
        const end = Math.min(value.manifest.length, a.offset + 8000);
        return {
          ...value,
          manifest: value.manifest.slice(a.offset, end),
          offset: a.offset,
          truncated: end < value.manifest.length,
          next_offset: end < value.manifest.length ? end : null,
        };
      },
    ),
    define(
      'skill_store',
      'Create or update a skill. Existing content must be read first; preserve its unrelated sections.',
      'content.manage',
      {
        slug,
        manifest: text,
        display_name: z.string().max(191).optional(),
        description: z.string().max(2000).optional(),
        engine: engineSchema.nullable().optional(),
        expected_sha256: z.string().length(64).nullable(),
      },
      async (c, a) => {
        const svc = new SkillsService(c.db);
        const current = await svc.find(a.slug);
        if ((current?.sha256 ?? null) !== a.expected_sha256)
          throw new ConflictError('Skill changed; read it again');
        const result = await svc.store(a);
        const saved = await svc.find(a.slug);
        if (saved?.sha256 !== result.sha256) throw new ConflictError('Skill receipt could not be verified');
        return { ...result, synchronization: 'Stored centrally; host synchronization is separate.' };
      },
      { snapshot: skillSnapshot, href: (a) => `/admin/authoring/skills/${encodeURIComponent(a.slug)}` },
    ),
    define(
      'skill_delete',
      'Delete an authored skill; managed content stays protected.',
      'content.manage',
      { slug },
      async (c, a) => new SkillsService(c.db).softDelete(a.slug),
      { confirm: true, snapshot: skillSnapshot },
    ),
    define('projects_list', 'List shared projects.', 'projects.read', {}, async (c) => project(c).list()),
    define(
      'project_read',
      'Read a project summary, metadata, notes and work board context.',
      'projects.read',
      { slug },
      async (c, a) => project(c).detail(a.slug),
    ),
    define(
      'project_create',
      'Create a shared project.',
      'projects.manage',
      { slug, about: z.record(z.unknown()) },
      async (c, a) => project(c).create(a),
      { snapshot: projectSnapshot, href: (a) => `/admin/projects/${encodeURIComponent(a.slug)}` },
    ),
    define(
      'project_about',
      'Replace project metadata; first read and preserve unrelated keys.',
      'projects.manage',
      { slug, about: z.record(z.unknown()) },
      async (c, a) => project(c).updateAbout(a.slug, { about: a.about }),
      { snapshot: projectSnapshot, href: (a) => `/admin/projects/${encodeURIComponent(a.slug)}` },
    ),
    define(
      'project_roster',
      'Update the project roster text.',
      'projects.manage',
      { slug, roster_markdown: text },
      async (c, a) => project(c).updateRoster(a.slug, a),
      { snapshot: projectSnapshot },
    ),
    define(
      'project_archive',
      'Archive or unarchive a project.',
      'projects.manage',
      { slug, archived: z.boolean() },
      async (c, a) => project(c).setArchived(a.slug, a.archived),
      { confirm: true, snapshot: projectSnapshot },
    ),
    define(
      'project_delete',
      'Delete a project and its associated records.',
      'projects.manage',
      { slug },
      async (c, a) => project(c).deleteBySlug(a.slug),
      { confirm: true, snapshot: projectSnapshot },
    ),
    define(
      'shared_memory_search',
      'Search fleet knowledge; records are dated context, not live state.',
      'memory.read',
      { query },
      async (c, a) => new SharedMemoriesService(c.db).search(a),
    ),
    define(
      'shared_memory_read',
      'Read a complete memory using offset windows; preserve its digest across windows.',
      'memory.read',
      { slug, offset: z.number().int().min(0).default(0) },
      async (c, a) => new SharedMemoriesService(c.db).read({ ...a, max_chars: 8000 }),
    ),
    define(
      'agents_read',
      'Read the current served fleet instructions and available versions.',
      'content.read',
      { engine: engineSchema },
      async (c, a) => new AgentsService(c.db).adminFetch(a.engine),
    ),
    define(
      'config_read',
      'Read fleet-managed engine configuration.',
      'content.read',
      { engine: engineSchema },
      async (c, a) => configRead(c, a.engine),
    ),
    define(
      'claude_artifacts_list',
      'List Claude-only subagents, commands or output styles.',
      'content.read',
      { kind: z.enum(['subagent', 'command', 'output-style']) },
      async (c, a) => new ClaudeArtifactsService(c.db).list(a.kind),
    ),
    define('users_list', 'List administrative users and roles.', 'users.read', {}, async (c) =>
      user(c).list(),
    ),
    define(
      'user_update',
      'Update user metadata or access level; existing last-owner invariants apply.',
      'users.manage',
      {
        id,
        name: z.string().max(255).optional(),
        access_level: z
          .enum(['owner', 'admin', 'fleet_operator', 'trusted_user', 'viewer', 'user'])
          .optional(),
        active: z.boolean().optional(),
      },
      async (c, a) => user(c).update(a.id, a),
      { confirm: true, snapshot: userSnapshot, href: () => '/admin/users' },
    ),
    define(
      'user_delete',
      'Delete an admin account subject to last-owner protection.',
      'users.manage',
      { id },
      async (c, a) => {
        await user(c).remove(a.id);
        return { deleted: true, id: a.id };
      },
      { confirm: true, snapshot: userSnapshot },
    ),
    define(
      'secrets_search',
      'Search credential metadata without revealing values.',
      'secrets.read_metadata',
      { query },
      async (c, a) => new SecretsService({ db: c.db, keyring: c.keyring }).search(a.query),
    ),
    define(
      'schedules_list',
      'Read existing scheduled work; Chatty cannot create or reactivate host work.',
      'agent_messaging.read',
      {},
      async (c) => new SchedulesService(c.db, c.keyring).list(),
    ),
    define(
      'schedule_read',
      'Read a schedule and its execution history.',
      'agent_messaging.read',
      { id: z.string().uuid() },
      async (c, a) => new SchedulesService(c.db, c.keyring).get(a.id),
    ),
    define(
      'schedule_pause',
      'Pause an existing schedule at the supplied version.',
      'agent_messaging.manage',
      { id: z.string().uuid(), version: id },
      async (c, a) =>
        new SchedulesService(c.db, c.keyring).update({ ...a, enabled: false }, `admin:${c.actor.userId}`),
      { snapshot: async (c, a) => new SchedulesService(c.db, c.keyring).get(a.id) },
    ),
    define(
      'schedule_delete',
      'Delete an existing schedule at the supplied version.',
      'agent_messaging.manage',
      { id: z.string().uuid(), version: id },
      async (c, a) => new SchedulesService(c.db, c.keyring).remove(a, `admin:${c.actor.userId}`),
      { confirm: true, snapshot: async (c, a) => new SchedulesService(c.db, c.keyring).get(a.id) },
    ),
    define(
      'git_director_read',
      'Read clone registrations, tasks and merge leases.',
      'git_director.read',
      {},
      async (c) => new GitDirectorService({ db: c.db, settings: new SettingsService(c.db) }).adminClones(),
    ),
    define(
      'logs_read',
      'Read recent sanitized operational log entries by action prefix.',
      'audit.read',
      { query },
      async (c, a) =>
        modelSafe(
          await c.db
            .select({
              id: logs.id,
              action: logs.action,
              created_at: logs.createdAt,
              engine: logs.engine,
              host_id: logs.hostId,
            })
            .from(logs)
            .where(like(logs.action, `${a.query}%`))
            .orderBy(desc(logs.id))
            .limit(50),
        ),
    ),
    define(
      'settings_read',
      'Read selected non-secret fleet limits and quota settings.',
      'settings.read',
      {},
      async (c) => {
        const svc = new SettingsService(c.db);
        return Object.fromEntries(
          await Promise.all(
            [
              'quota_hard_fail',
              'quota_limit_percent',
              'quota_week_partition',
              'authorization_mode',
              'inactivity_window_days',
            ].map(async (key) => [key, await svc.getRaw(key)]),
          ),
        );
      },
    ),
  ];
  const toggles = [
    ['vip', 'setVip', 'hosts.manage', false],
    ['roaming', 'setRoaming', 'hosts.manage', true],
    ['secure', 'setSecure', 'hosts.security_transition', true],
    ['curl_insecure', 'setCurlInsecure', 'hosts.manage', true],
    ['browseros_mcp', 'setBrowserOsMcp', 'hosts.manage', true],
    ['scaling_exempt', 'setScalingExempt', 'hosts.manage', false],
  ] as const;
  for (const [name, method, cap, confirm] of toggles)
    tools.push(
      define(
        `host_${name}`,
        `Set ${name} for one host.`,
        cap,
        { id, enabled: z.boolean() },
        async (c, a) => modelSafe(await host(c)[method](a.id, a.enabled)),
        { confirm, snapshot: hostSnapshot, href: (a) => `/admin/hosts/${a.id}` },
      ),
    );
  tools.push(
    define(
      'models_read',
      'Read enabled models and fleet defaults for an engine.',
      'settings.read',
      { engine: engineSchema },
      async (c, a) => configRead(c, a.engine),
    ),
    define(
      'config_store',
      'Patch fleet configuration and model defaults; omitted settings are preserved. Read first and supply its digest. Secret fields require the existing UI.',
      'content.manage',
      {
        engine: engineSchema,
        settings: z.record(z.unknown()),
        expected_sha256: z.string().length(64).nullable(),
      },
      async (c, a) => {
        if (signature(modelSafe(a.settings)) !== signature(a.settings))
          throw new ConflictError('Use the configuration UI for credential fields.');
        const service = new ClientConfigService(c.db);
        const current = await service.adminFetch(a.engine);
        if ((current.sha256 ?? null) !== a.expected_sha256)
          throw new ConflictError('Configuration changed; read it again.');
        const result = await service.store(
          {
            settings: mergeSettings((current.settings ?? {}) as Record<string, unknown>, a.settings),
            sha256: a.expected_sha256,
          },
          null,
          a.engine,
        );
        return { saved: true, engine: a.engine, sha256: result.sha256 };
      },
      {
        confirm: true,
        snapshot: async (c, a) =>
          await c.db
            .select({
              id: clientConfigDocuments.id,
              sha256: clientConfigDocuments.sha256,
              updatedAt: clientConfigDocuments.updatedAt,
            })
            .from(clientConfigDocuments)
            .where(eq(clientConfigDocuments.engine, a.engine))
            .for('update'),
      },
    ),
    define(
      'agents_store',
      'Replace authored fleet instructions for one engine. Read first and preserve unrelated sections; managed feature text stays managed.',
      'content.manage',
      { engine: engineSchema, body: text },
      async (c, a) => new AgentsService(c.db).store(a.body, null, null, a.engine),
      {
        confirm: true,
        snapshot: async (c, a) =>
          c.db
            .select()
            .from(agentsDocuments)
            .where(eq(agentsDocuments.engine, a.engine))
            .orderBy(desc(agentsDocuments.id))
            .limit(1)
            .for('update'),
      },
    ),
    define(
      'shared_memory_store',
      'Create or replace a fleet memory with a complete preserved body and expected digest. Never replace from an excerpt.',
      'memory.write',
      {
        slug,
        content: text,
        title: z.string().max(255).optional(),
        expected_sha256: z.string().length(64).nullable(),
        tags: z.array(z.string().max(100)).max(20).optional(),
      },
      async (c, a) => {
        const row = (await c.db.select().from(sharedMemories).where(eq(sharedMemories.slug, a.slug)))[0];
        if ((row && !row.deletedAt ? row.contentSha256 : null) !== a.expected_sha256)
          throw new ConflictError('Memory changed; read the complete current body');
        return new SharedMemoriesService(c.db).write(a);
      },
      {
        snapshot: async (c, a) =>
          (
            await c.db.select().from(sharedMemories).where(eq(sharedMemories.slug, a.slug)).for('update')
          )[0] ?? null,
      },
    ),
    define(
      'shared_memory_delete',
      'Delete an entire obsolete fleet memory.',
      'memory.write',
      { slug },
      async (c, a) => new SharedMemoriesService(c.db).delete(a),
      {
        confirm: true,
        snapshot: async (c, a) =>
          (
            await c.db.select().from(sharedMemories).where(eq(sharedMemories.slug, a.slug)).for('update')
          )[0] ?? null,
      },
    ),
    define(
      'claude_artifact_read',
      'Read a Claude subagent, command or output style.',
      'content.read',
      { kind: z.enum(['subagent', 'command', 'output-style']), slug },
      async (c, a) => new ClaudeArtifactsService(c.db).requireBySlug(a.kind, a.slug),
    ),
    define(
      'claude_artifact_store',
      'Create or update a Claude-native artifact; does not start work.',
      'content.manage',
      { kind: z.enum(['subagent', 'command', 'output-style']), slug, body: text },
      async (c, a) => new ClaudeArtifactsService(c.db).store(a.kind, a),
      {
        snapshot: async (c, a) =>
          (
            await c.db
              .select()
              .from(claudeArtifacts)
              .where(and(eq(claudeArtifacts.kind, a.kind), eq(claudeArtifacts.slug, a.slug)))
              .for('update')
          )[0] ?? null,
      },
    ),
    define(
      'claude_artifact_delete',
      'Delete a Claude-native artifact.',
      'content.manage',
      { kind: z.enum(['subagent', 'command', 'output-style']), slug },
      async (c, a) => new ClaudeArtifactsService(c.db).softDelete(a.kind, a.slug),
      {
        confirm: true,
        snapshot: async (c, a) =>
          (
            await c.db
              .select()
              .from(claudeArtifacts)
              .where(and(eq(claudeArtifacts.kind, a.kind), eq(claudeArtifacts.slug, a.slug)))
              .for('update')
          )[0] ?? null,
      },
    ),
    define('project_notes', 'Read the notes of a shared project.', 'projects.read', { slug }, async (c, a) =>
      content(c).listNotes(a.slug),
    ),
    define(
      'project_note_store',
      'Create a note with id null, or update a note after reading its complete content.',
      'projects.manage',
      { slug, id: id.nullable(), header: z.string().min(1).max(255), body: text },
      async (c, a) => content(c).upsertNote(a.slug, a.id, a),
      {
        snapshot: async (c, a) => {
          await projectSnapshot(c, a);
          return a.id
            ? ((
                await c.db
                  .select()
                  .from(coordProjectNotes)
                  .where(eq(coordProjectNotes.id, a.id))
                  .for('update')
              )[0] ?? null)
            : null;
        },
      },
    ),
    define(
      'project_note_delete',
      'Delete a project note.',
      'projects.manage',
      { slug, id },
      async (c, a) => content(c).deleteNote(a.slug, a.id),
      {
        confirm: true,
        snapshot: async (c, a) =>
          (
            await c.db.select().from(coordProjectNotes).where(eq(coordProjectNotes.id, a.id)).for('update')
          )[0] ?? null,
      },
    ),
    define(
      'project_board_read',
      'Read the project board and cards.',
      'projects.read',
      { slug },
      async (c, a) => board(c).adminBoard(a.slug),
    ),
    define(
      'project_card_create',
      'Create a planning card; this does not dispatch work to an agent.',
      'projects.manage',
      {
        slug,
        title: z.string().min(1).max(255),
        detail: z.string().max(32000).optional(),
        column: slug.optional(),
      },
      async (c, a) => board(c).createCard(a, null),
      { snapshot: projectSnapshot },
    ),
    define(
      'project_card_update',
      'Edit a project planning card.',
      'projects.manage',
      {
        slug,
        card: slug,
        title: z.string().max(255).optional(),
        detail: z.string().max(32000).optional(),
        priority: z.number().int().optional(),
      },
      async (c, a) => board(c).updateCard(a, null),
      {
        snapshot: async (c, a) => {
          await projectSnapshot(c, a);
          return board(c).adminBoard(a.slug);
        },
      },
    ),
    define(
      'project_card_move',
      'Move a planning card to an existing column.',
      'projects.manage',
      { slug, card: slug, column: slug },
      async (c, a) => board(c).moveCard(a, null),
      {
        snapshot: async (c, a) => {
          await projectSnapshot(c, a);
          return board(c).adminBoard(a.slug);
        },
      },
    ),
    define(
      'project_card_archive',
      'Archive a planning card.',
      'projects.manage',
      { slug, card: slug },
      async (c, a) => board(c).archiveCard(a, null),
      {
        confirm: true,
        snapshot: async (c, a) => {
          await projectSnapshot(c, a);
          return board(c).adminBoard(a.slug);
        },
      },
    ),
    define(
      'project_files',
      'List project files and metadata; use the product UI for uploads.',
      'projects.read',
      { slug },
      async (c, a) => content(c).listFiles(a.slug),
    ),
    define('project_feedback', 'Read project feedback.', 'projects.read', { slug }, async (c, a) =>
      content(c).listFeedback(a.slug),
    ),
    define('watchdogs_list', 'Read bounded recovery watchdogs.', 'agent_messaging.read', {}, async (c) =>
      modelSafe(await new WatchdogsService(c.db, c.keyring).list()),
    ),
    define(
      'watchdog_disable',
      'Disable existing recovery; cannot enable or extend it.',
      'agent_messaging.manage',
      { id: z.string().uuid(), version: id },
      async (c, a) => {
        await new WatchdogsService(c.db, c.keyring).finish(a, `admin:${c.actor.userId}`, true);
        return { disabled: true, id: a.id };
      },
      {
        snapshot: async (c, a) =>
          modelSafe(
            (await c.db.select().from(agentWatchdogs).where(eq(agentWatchdogs.id, a.id)).for('update'))[0] ??
              null,
          ),
      },
    ),
    define(
      'gateway_keys_list',
      'List gateway keys for a surface, independently of the engine serving that surface. No key values.',
      'auth.read_metadata',
      { surface: engineSchema },
      async (c, a) => new OpenAiKeyService(c).listByEngine(a.surface),
    ),
    define(
      'gateway_key_active',
      'Enable or suspend a gateway key by surface.',
      'keys.manage',
      { id, surface: engineSchema, active: z.boolean() },
      async (c, a) => modelSafe(await new OpenAiKeyService(c).setActive(a.id, a.active, a.surface)),
      {
        confirm: true,
        snapshot: async (c, a) =>
          modelSafe(
            (
              await c.db
                .select()
                .from(openaiApiKeys)
                .where(and(eq(openaiApiKeys.id, a.id), eq(openaiApiKeys.engine, a.surface)))
                .for('update')
            )[0] ?? null,
          ),
      },
    ),
    define(
      'gateway_key_delete',
      'Delete a gateway key and revoke access.',
      'keys.manage',
      { id, surface: engineSchema },
      async (c, a) => ({ deleted: await new OpenAiKeyService(c).delete(a.id, a.surface) }),
      {
        confirm: true,
        snapshot: async (c, a) =>
          modelSafe(
            (
              await c.db
                .select()
                .from(openaiApiKeys)
                .where(and(eq(openaiApiKeys.id, a.id), eq(openaiApiKeys.engine, a.surface)))
                .for('update')
            )[0] ?? null,
          ),
      },
    ),
    define(
      'transfers_list',
      'List current file-transfer metadata without downloading file content.',
      'transfers.read',
      {},
      async (c) =>
        new AgentTransfersService({
          db: c.db,
          settings: new SettingsService(c.db),
          dataRoot: c.env.DATA_ROOT ?? '/app/storage',
        }).list(),
    ),
    define(
      'interactive_handoff',
      'Open the existing interface for credentials, identity verification, uploads or operations not directly exposed as Chatty tools. Does not perform an action.',
      'chatty.use',
      {
        destination: z.enum([
          'accounts',
          'api-keys',
          'secrets',
          'users',
          'account/passkeys',
          'authoring',
          'settings',
          'projects',
          'transfers',
          'agent-sessions',
          'git-director',
          'hosts',
        ]),
      },
      async (_c, a) => ({
        href: `/admin/${a.destination}`,
        instruction: 'Complete this operation in the linked interface. Chatty has not executed it.',
      }),
    ),
  );
  return tools;
}

export function requireTool(tools: ChattyTool[], name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new NotFoundError('Unknown or unavailable Chatty tool');
  return tool;
}

export function checkSnapshot(expected: unknown, actual: unknown) {
  if (signature(expected) !== signature(actual))
    throw new ConflictError('Target changed since preparation. Read it again and prepare a new action.');
}
