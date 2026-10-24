import {
  roleContext,
  roleState,
  roleCommand,
  roleVersion,
  stageRoleVersion,
  rolePublish,
  roleAgentProof,
} from './roles/owner.js';
import { ownerRuntimeFor, type OwnerMutationContext } from '../control-plane/state/runtime.js';
import { stageUpdate, stageDelete } from '../control-plane/state/rows.js';
import type { MessagingHost } from './agent-messaging/types.js';
/**
 * Agent roles facade. Slices live in `roles/`: the package contract, content
 * and versions, assignments (who holds which pinned version) and proposals
 * (the self-mutating pipeline).
 *
 * Catalog and content are session-independent and served to hosts through the
 * clx MCP (`role_list`, `role://`). Activation, proposals and reviews need the
 * calling agent's identity, so they ride the agent-messaging bridge.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import {
  agentRoleProposals,
  agentRoleVersions,
  agentRoles,
  type AgentRole,
  type AgentSession,
} from '../db/schema.js';
import { ApiError, ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { sha256 } from '../security/hash.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import { FILE_ENCODING_UTF8 } from './project-file-encoding.js';
import type { SettingsService } from './settings.js';
import { RoleAssignments } from './roles/assignments.js';
import {
  acceptFiles,
  activationPayload,
  bundleDigest,
  fileAt,
  fileIndexView,
  readBlob,
  versionFiles,
  versionView,
  writeVersionFiles,
} from './roles/content.js';
import {
  DEFAULT_ROLE_POLICY,
  ROLES_ENABLED_KEY,
  ROLE_MANIFEST_PATH,
  ROLE_SUMMARY_MAX,
  normalizeRolePath,
  normalizeRolePolicy,
  normalizeRoleSlug,
  parseRoleManifest,
  readRolePolicy,
  roleUri,
  rolesDisabledError,
  type RoleActor,
} from './roles/contract.js';
import type { RoleProposalJudge } from './roles/judge.js';
import { RoleProposals } from './roles/proposals.js';
import { publishVersion, recomputeCurrent } from './roles/versions.js';

export interface RolesServiceDeps {
  db: Database;
  settings: SettingsService;
  judge?: RoleProposalJudge | null;
  /** Session authentication from agent messaging; required for the agent operations. */
  authenticateBridge?: (
    sessionId: string,
    token: string,
  ) => Promise<{ session: AgentSession; host: MessagingHost }>;
  /** Server-originated informational delivery to agent addresses (ROLE-UPDATE, ROLE-REVIEW, ROLE-PROPOSAL). */
  notify?: (addressIds: string[], body: string) => Promise<void>;
  notifyOwned?: (context: OwnerMutationContext, addressIds: string[], body: string) => Promise<void> | void;
}

const createSchema = z
  .object({
    slug: z.string().min(1).max(64),
    display_name: z.string().trim().min(1).max(255),
    summary: z.string().trim().min(1).max(ROLE_SUMMARY_MAX),
    policy: z.record(z.unknown()).optional(),
  })
  .strict();

const draftSchema = z
  .object({
    manifest: z.string().min(1),
    files: z.array(z.record(z.unknown())).optional(),
    changelog: z.string().max(4000).nullable().optional(),
  })
  .strict();

interface ParsedRoleUri {
  slug: string;
  version: number | null;
  path: string | null;
}

export function parseRoleUri(uri: string): ParsedRoleUri {
  const match = /^role:\/\/([^/@]+)(?:@(\d+))?(?:\/(.+))?$/.exec(uri);
  if (!match) throw new ValidationError('role URIs are role://{slug}[@{version}][/{path}]', { param: 'uri' });
  const path = match[3]
    ? match[3]
        .split('/')
        .map((segment) => decodeURIComponent(segment))
        .join('/')
    : null;
  return {
    slug: normalizeRoleSlug(match[1]),
    version: match[2] ? Number(match[2]) : null,
    path: path === null ? null : path === ROLE_MANIFEST_PATH ? path : normalizeRolePath(path),
  };
}

const BINARY_PREFIXES = ['image/', 'audio/', 'video/', 'font/'];
const isBinaryMime = (mime: string) =>
  BINARY_PREFIXES.some((prefix) => mime.startsWith(prefix)) ||
  mime === 'application/octet-stream' ||
  mime === 'application/pdf' ||
  mime === 'application/zip';

export class RolesService {
  readonly assignments: RoleAssignments;
  readonly proposals: RoleProposals;

  constructor(private readonly deps: RolesServiceDeps) {
    const assertEnabled = async () => {
      if (!(await this.isEnabled())) throw rolesDisabledError();
    };
    this.assignments = new RoleAssignments({
      db: deps.db,
      authenticateBridge: (sessionId, token) => this.bridge(sessionId, token),
      assertEnabled,
    });
    this.proposals = new RoleProposals({
      db: deps.db,
      assignments: this.assignments,
      judge: deps.judge ?? null,
      identity: async (sessionId, token) => {
        const { session, host } = await this.bridge(sessionId, token);
        if (!session.agentBusAddressId)
          throw new ConflictError(
            'Agent session has no messaging address',
            'agent_messaging_address_missing',
          );
        await assertEnabled();
        return { session, addressId: session.agentBusAddressId, engine: session.engine, hostId: host.id };
      },
      notify: (ids, body) => this.notify(ids, body),
    });
  }

  private bridge(sessionId: string, token: string) {
    const state = roleState(this.deps.db);
    if (state) return Promise.resolve(roleAgentProof(state, sessionId, token));
    if (!this.deps.authenticateBridge)
      throw new ApiError('Agent role operations need agent messaging', {
        status: 503,
        code: 'roles_unavailable',
      });
    return this.deps.authenticateBridge(sessionId, token);
  }

  /** Delivery is best effort: a notice that cannot be sent never undoes the change it reports. */
  private async notify(addressIds: string[], body: string) {
    // Routine role history is available through role/proposal reads and audit.
    // Address-bound information must not follow an ended session or resume it.
    // Explicit ROLE-REVIEW requests still need delivery.
    const [header, instruction] = body.split('\n', 2);
    if (
      instruction === 'Informational; no reply required.' &&
      (/^ROLE-UPDATE\/1 role=[a-z0-9][a-z0-9._-]* version=[1-9]\d* previous=(?:none|[1-9]\d*) sha=[a-f0-9]{12}$/.test(
        header!,
      ) ||
        /^ROLE-PROPOSAL\/1 role=[a-z0-9][a-z0-9._-]* proposal_id=[a-f0-9-]{36} status=(?:applied|rejected|superseded|held)(?: version=[1-9]\d*)?$/.test(
          header!,
        ))
    )
      return;
    if (!addressIds.length) return;
    const ctx = roleContext();
    if (ctx) {
      if (!this.deps.notifyOwned) throw new Error('Owner role notices require same-command messaging');
      await this.deps.notifyOwned(ctx.command, addressIds, body);
      return;
    }
    if (!this.deps.notify) return;
    try {
      await this.deps.notify(addressIds, body);
    } catch {
      // Messaging disabled or an address ineligible: the change stands.
    }
  }

  // ── module switch ─────────────────────────────────────────────────────

  async isEnabled(): Promise<boolean> {
    return this.deps.settings.getFlag(ROLES_ENABLED_KEY, false);
  }

  async setEnabled(enabled: boolean) {
    await this.deps.settings.set(ROLES_ENABLED_KEY, enabled ? '1' : '0');
    rolePublish(() => wsPublisher.publish('agent_roles.state.changed', { enabled }));
    return { enabled };
  }

  private async requireEnabled() {
    if (!(await this.isEnabled())) throw rolesDisabledError();
  }

  private async roleBySlug(slug: string): Promise<AgentRole> {
    const state = roleState(this.deps.db);
    const [role] = state
      ? [
          state
            .table('agentRoles')
            .all()
            .find((r) => r.slug === normalizeRoleSlug(slug)),
        ]
      : await this.deps.db
          .select()
          .from(agentRoles)
          .where(eq(agentRoles.slug, normalizeRoleSlug(slug)))
          .limit(1);
    if (!role) throw new NotFoundError(`No role named ${slug}`, 'role_not_found');
    return role;
  }

  // ── catalog and content (clx MCP) ─────────────────────────────────────

  async catalog(args: Record<string, unknown> = {}) {
    await this.requireEnabled();
    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
    const includeRetired = args.include_retired === true;
    const state = roleState(this.deps.db);
    const roles = state
      ? [...state.table('agentRoles').all()].sort((a, b) => a.slug.localeCompare(b.slug))
      : await this.deps.db.select().from(agentRoles).orderBy(asc(agentRoles.slug));
    const versions = await this.currentVersions(roles);
    const listed = roles
      .filter((role) => role.currentVersionId && (includeRetired || role.status === 'active'))
      .filter(
        (role) => !query || `${role.slug} ${role.displayName} ${role.summary}`.toLowerCase().includes(query),
      )
      .map((role) => ({
        slug: role.slug,
        display_name: role.displayName,
        summary: role.summary,
        status: role.status,
        current_version: versions.get(role.id)?.version ?? null,
        sha: versions.get(role.id)?.bundleSha256 ?? null,
        uri: roleUri(role.slug),
      }));
    return {
      roles: listed,
      note: 'A catalog entry is not an activation. On an explicit assignment, read skill://roles and activate with agent_role_activate.',
    };
  }

  private async currentVersions(roles: AgentRole[]) {
    const ids = roles.map((role) => role.currentVersionId).filter((id): id is string => Boolean(id));
    if (!ids.length) return new Map<string, Omit<typeof agentRoleVersions.$inferSelect, 'manifest'>>();
    const state = roleState(this.deps.db);
    const rows = state
      ? state
          .table('agentRoleVersions')
          .all()
          .filter((v) => ids.includes(v.id))
      : await this.deps.db.select().from(agentRoleVersions).where(inArray(agentRoleVersions.id, ids));
    return new Map(rows.map((row) => [row.roleId, row]));
  }

  /** `resource_read` for `role://`: the manifest and index, or one file as text or blob. */
  async readResource(uri: string): Promise<{
    contents: Array<{ uri: string; name: string; mimeType: string; text?: string; blob?: string }>;
  }> {
    await this.requireEnabled();
    const parsed = parseRoleUri(uri);
    const role = await this.roleBySlug(parsed.slug);
    let version;
    if (parsed.version === null) {
      if (!role.currentVersionId)
        throw new NotFoundError(`Role ${role.slug} has no published version`, 'role_version_not_found');
      version = await roleVersion(this.deps.db, role.currentVersionId);
    } else {
      const state = roleState(this.deps.db);
      const id = state
        ?.table('agentRoleVersions')
        .all()
        .find((v) => v.roleId === role.id && v.version === parsed.version)?.id;
      if (state) version = id ? await roleVersion(this.deps.db, id) : undefined;
      else
        [version] = await this.deps.db
          .select()
          .from(agentRoleVersions)
          .where(and(eq(agentRoleVersions.roleId, role.id), eq(agentRoleVersions.version, parsed.version)))
          .limit(1);
    }
    if (!version || version.state === 'draft')
      throw new NotFoundError(`Role ${role.slug} has no such version`, 'role_version_not_found');
    if (parsed.path === null) {
      const files = await versionFiles(this.deps.db, version.id);
      const body = {
        role: role.slug,
        display_name: role.displayName,
        summary: role.summary,
        status: role.status,
        version: versionView(role, version),
        ...(version.state === 'withdrawn'
          ? { warning: 'role_version_withdrawn: this version was withdrawn as faulty' }
          : {}),
        manifest: version.manifest,
        files: fileIndexView(role, version, files),
      };
      return {
        contents: [{ uri, name: role.slug, mimeType: 'application/json', text: JSON.stringify(body) }],
      };
    }
    if (parsed.path === ROLE_MANIFEST_PATH)
      return {
        contents: [{ uri, name: ROLE_MANIFEST_PATH, mimeType: 'text/markdown', text: version.manifest }],
      };
    const file = await fileAt(this.deps.db, version.id, parsed.path);
    if (!file)
      throw new NotFoundError(
        `No file ${parsed.path} in ${role.slug}@${version.version}`,
        'role_file_not_found',
      );
    const blob = await readBlob(this.deps.db, file.blobSha256);
    if (!blob) throw new NotFoundError('Role file body is missing', 'role_file_not_found');
    if (blob.encoding === FILE_ENCODING_UTF8 && !isBinaryMime(file.mimeType)) {
      return { contents: [{ uri, name: parsed.path, mimeType: file.mimeType, text: blob.content }] };
    }
    const base64 =
      blob.encoding === FILE_ENCODING_UTF8
        ? Buffer.from(blob.content, 'utf8').toString('base64')
        : blob.content;
    return { contents: [{ uri, name: parsed.path, mimeType: file.mimeType, blob: base64 }] };
  }

  // ── agent operations (bridge) ─────────────────────────────────────────

  activate(sessionId: string, token: string, body: unknown) {
    return this.assignments.activate(sessionId, token, body);
  }
  current(sessionId: string, token: string, body: unknown) {
    return this.assignments.current(sessionId, token, body);
  }
  release(sessionId: string, token: string, body: unknown) {
    return this.assignments.release(sessionId, token, body);
  }
  propose(sessionId: string, token: string, body: unknown) {
    return this.proposals.propose(sessionId, token, body);
  }
  listProposals(sessionId: string, token: string, body: unknown) {
    return this.proposals.listForAgent(sessionId, token, body);
  }
  review(sessionId: string, token: string, body: unknown) {
    return this.proposals.review(sessionId, token, body);
  }
  processDue(now?: Date) {
    return this.proposals.processDue(now);
  }

  // ── operator surface ──────────────────────────────────────────────────

  async listAdmin() {
    const state = roleState(this.deps.db);
    const roles = state
      ? [...state.table('agentRoles').all()].sort((a, b) => a.slug.localeCompare(b.slug))
      : await this.deps.db.select().from(agentRoles).orderBy(asc(agentRoles.slug));
    const versions = await this.currentVersions(roles);
    const holders = roles.length
      ? await Promise.all(
          roles.map(
            async (role) =>
              [role.id, (await this.assignments.holders(this.deps.db, role.id)).length] as const,
          ),
        )
      : [];
    const holderCount = new Map(holders);
    const open = roles.length
      ? state
        ? state
            .table('agentRoleProposals')
            .all()
            .filter((p) => ['checking', 'in_review', 'held'].includes(p.status))
        : await this.deps.db
            .select({ roleId: agentRoleProposals.roleId, status: agentRoleProposals.status })
            .from(agentRoleProposals)
            .where(inArray(agentRoleProposals.status, ['checking', 'in_review', 'held']))
      : [];
    return {
      enabled: await this.isEnabled(),
      roles: roles.map((role) => ({
        slug: role.slug,
        display_name: role.displayName,
        summary: role.summary,
        status: role.status,
        current_version: versions.get(role.id)?.version ?? null,
        policy: readRolePolicy(role.policy),
        holders: holderCount.get(role.id) ?? 0,
        open_proposals: open.filter((row) => row.roleId === role.id).length,
        held_proposals: open.filter((row) => row.roleId === role.id && row.status === 'held').length,
        updated_at: role.updatedAt,
      })),
    };
  }

  async detailAdmin(slug: string) {
    const role = await this.roleBySlug(slug);
    const state = roleState(this.deps.db);
    const versions = state
      ? state
          .table('agentRoleVersions')
          .all()
          .filter((v) => v.roleId === role.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      : await this.deps.db
          .select()
          .from(agentRoleVersions)
          .where(eq(agentRoleVersions.roleId, role.id))
          .orderBy(desc(agentRoleVersions.createdAt));
    const draft = versions.find((version) => version.state === 'draft') ?? null;
    const holders = await this.assignments.holders(this.deps.db, role.id);
    return {
      role: {
        slug: role.slug,
        display_name: role.displayName,
        summary: role.summary,
        status: role.status,
        policy: readRolePolicy(role.policy),
        version: role.version,
        current_version_id: role.currentVersionId,
      },
      versions: versions
        .filter((version) => version.state !== 'draft')
        .map((version) => versionView(role, version)),
      draft: draft
        ? {
            ...versionView(role, draft),
            manifest: (await roleVersion(this.deps.db, draft.id))!.manifest,
            files: fileIndexView(role, draft, await versionFiles(this.deps.db, draft.id)),
          }
        : null,
      holders: holders.map((holder) => ({
        address_id: holder.addressId,
        version_id: holder.versionId,
        activated_at: holder.createdAt,
        activated_by: holder.activatedBy,
        reason: holder.reason,
      })),
    };
  }

  /** One version's manifest and every text file, for the operator's diff and editor. */
  async versionContent(slug: string, number: number) {
    const role = await this.roleBySlug(slug);
    const state = roleState(this.deps.db),
      id = state
        ?.table('agentRoleVersions')
        .all()
        .find((v) => v.roleId === role.id && v.version === number)?.id;
    const [version] = state
      ? [id ? await roleVersion(this.deps.db, id) : undefined]
      : await this.deps.db
          .select()
          .from(agentRoleVersions)
          .where(and(eq(agentRoleVersions.roleId, role.id), eq(agentRoleVersions.version, number)))
          .limit(1);
    if (!version) throw new NotFoundError(`Role ${slug} has no version ${number}`, 'role_version_not_found');
    const files = await versionFiles(this.deps.db, version.id);
    const withText = [];
    for (const file of files) {
      const blob =
        file.encoding === FILE_ENCODING_UTF8 ? await readBlob(this.deps.db, file.blob_sha256) : null;
      withText.push({ ...fileIndexView(role, version, [file])[0]!, text: blob?.content ?? null });
    }
    return { ...versionView(role, version), manifest: version.manifest, files: withText };
  }

  async createRole(
    body: unknown,
    actor: RoleActor,
  ): Promise<Awaited<ReturnType<RolesService['detailAdmin']>>> {
    if (ownerRuntimeFor(this.deps.db) && !roleContext())
      return roleCommand(this.deps.db, 'roles.createRole', () => this.createRole(body, actor));
    const input = createSchema.parse(body ?? {});
    const slug = normalizeRoleSlug(input.slug);
    const policy = normalizeRolePolicy(input.policy ?? {}, DEFAULT_ROLE_POLICY);
    const now = nowIso();
    if (slug === 'state' || slug === 'proposals')
      throw new ValidationError(`${slug} is reserved`, { param: 'slug' });
    const state = roleState(this.deps.db);
    const [existing] = state
      ? [
          state
            .table('agentRoles')
            .all()
            .find((r) => r.slug === slug),
        ]
      : await this.deps.db.select().from(agentRoles).where(eq(agentRoles.slug, slug)).limit(1);
    if (existing) throw new ConflictError(`Role ${slug} already exists`, 'role_exists');
    const row = {
        id: randomUUID(),
        slug,
        displayName: input.display_name,
        summary: input.summary,
        status: 'active',
        policy: { ...policy },
        currentVersionId: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      ctx = roleContext();
    if (ctx) {
      ctx.command.draft.upsert('agentRoles', row);
      ctx.command.write(async (tx) => tx.insert(agentRoles).values(row));
    } else await this.deps.db.insert(agentRoles).values(row);
    rolePublish(() => wsPublisher.publish('agent_roles.changed', { slug, actor: actor.kind }));
    return this.detailAdmin(slug);
  }

  async updateRole(slug: string, body: unknown): Promise<Awaited<ReturnType<RolesService['detailAdmin']>>> {
    if (ownerRuntimeFor(this.deps.db) && !roleContext())
      return roleCommand(this.deps.db, 'roles.updateRole', () => this.updateRole(slug, body));
    const input = z
      .object({
        display_name: z.string().trim().min(1).max(255).optional(),
        summary: z.string().trim().min(1).max(ROLE_SUMMARY_MAX).optional(),
        status: z.enum(['active', 'retired']).optional(),
        policy: z.record(z.unknown()).optional(),
        expected_version: z.number().int().positive(),
      })
      .strict()
      .parse(body ?? {});
    const role = await this.roleBySlug(slug);
    if (role.version !== input.expected_version)
      throw new ConflictError('Role changed since you read it', 'role_version_conflict');
    const policy = input.policy
      ? normalizeRolePolicy(input.policy, readRolePolicy(role.policy))
      : readRolePolicy(role.policy);
    const ctx = roleContext();
    if (ctx)
      stageUpdate(ctx.command, 'agentRoles', role.id, {
        displayName: input.display_name ?? role.displayName,
        summary: input.summary ?? role.summary,
        status: input.status ?? role.status,
        policy: { ...policy },
        version: role.version + 1,
        updatedAt: nowIso(),
      });
    else
      await this.deps.db
        .update(agentRoles)
        .set({
          displayName: input.display_name ?? role.displayName,
          summary: input.summary ?? role.summary,
          status: input.status ?? role.status,
          policy: { ...policy },
          version: role.version + 1,
          updatedAt: nowIso(),
        })
        .where(and(eq(agentRoles.id, role.id), eq(agentRoles.version, role.version)));
    rolePublish(() => wsPublisher.publish('agent_roles.changed', { slug: role.slug }));
    return this.detailAdmin(role.slug);
  }

  async saveDraft(
    slug: string,
    body: unknown,
    actor: RoleActor,
  ): Promise<Awaited<ReturnType<RolesService['detailAdmin']>>> {
    if (ownerRuntimeFor(this.deps.db) && !roleContext())
      return roleCommand(this.deps.db, 'roles.saveDraft', () => this.saveDraft(slug, body, actor));
    const input = draftSchema.parse(body ?? {});
    const role = await this.roleBySlug(slug);
    parseRoleManifest(role.slug, input.manifest);
    const files = await acceptFiles(this.deps.db, input.files ?? []);
    const manifestSha = sha256(input.manifest);
    const now = nowIso();
    await roleCommand(this.deps.db, 'roles.version.write', async (tx) => {
      if (!roleContext())
        await tx.select().from(agentRoles).where(eq(agentRoles.id, role.id)).limit(1).for('update');
      const metadata = roleState(tx)
        ?.table('agentRoleVersions')
        .all()
        .find((v) => v.roleId === role.id && v.state === 'draft');
      const [draft] = roleState(tx)
        ? [metadata ? await roleVersion(tx, metadata.id) : undefined]
        : await tx
            .select()
            .from(agentRoleVersions)
            .where(and(eq(agentRoleVersions.roleId, role.id), eq(agentRoleVersions.state, 'draft')))
            .limit(1);
      const id = draft?.id ?? randomUUID();
      const row = {
        manifest: input.manifest,
        manifestSha256: manifestSha,
        bundleSha256: bundleDigest(manifestSha, files),
        changelog: input.changelog ?? null,
        updatedAt: now,
      };
      const ctx = roleContext();
      if (ctx) {
        const values = {
          id,
          roleId: role.id,
          version: null,
          state: 'draft',
          createdBy: { ...actor },
          createdAt: now,
          publishedBy: null,
          publishedAt: null,
          withdrawnAt: null,
          sourceProposalId: null,
          revertedFromVersion: null,
          ...draft,
          ...row,
        };
        stageRoleVersion(ctx, values);
        ctx.command.write(async (db) =>
          draft
            ? db.update(agentRoleVersions).set(row).where(eq(agentRoleVersions.id, id))
            : db.insert(agentRoleVersions).values(values),
        );
      } else if (draft) await tx.update(agentRoleVersions).set(row).where(eq(agentRoleVersions.id, id));
      else
        await tx.insert(agentRoleVersions).values({
          id,
          roleId: role.id,
          version: null,
          state: 'draft',
          createdBy: { ...actor },
          createdAt: now,
          ...row,
        });
      await writeVersionFiles(tx, id, files);
    });
    rolePublish(() => wsPublisher.publish('agent_roles.changed', { slug: role.slug, draft: true }));
    return this.detailAdmin(role.slug);
  }

  async discardDraft(slug: string): Promise<Awaited<ReturnType<RolesService['detailAdmin']>>> {
    if (ownerRuntimeFor(this.deps.db) && !roleContext())
      return roleCommand(this.deps.db, 'roles.discardDraft', () => this.discardDraft(slug));
    const role = await this.roleBySlug(slug);
    const metadata = roleState(this.deps.db)
      ?.table('agentRoleVersions')
      .all()
      .find((v) => v.roleId === role.id && v.state === 'draft');
    const [draft] = roleState(this.deps.db)
      ? [metadata ? await roleVersion(this.deps.db, metadata.id) : undefined]
      : await this.deps.db
          .select()
          .from(agentRoleVersions)
          .where(and(eq(agentRoleVersions.roleId, role.id), eq(agentRoleVersions.state, 'draft')))
          .limit(1);
    if (!draft) throw new NotFoundError('No draft to discard', 'role_draft_not_found');
    await writeVersionFiles(this.deps.db, draft.id, []);
    const ctx = roleContext();
    if (ctx) {
      stageDelete(ctx.command, 'agentRoleVersions', draft.id);
      ctx.versions.delete(draft.id);
    } else await this.deps.db.delete(agentRoleVersions).where(eq(agentRoleVersions.id, draft.id));
    return this.detailAdmin(role.slug);
  }

  async publishDraft(
    slug: string,
    body: unknown,
    actor: RoleActor,
  ): Promise<Awaited<ReturnType<RolesService['detailAdmin']>>> {
    if (ownerRuntimeFor(this.deps.db) && !roleContext())
      return roleCommand(this.deps.db, 'roles.publishDraft', () => this.publishDraft(slug, body, actor));
    const input = z
      .object({ changelog: z.string().max(4000).optional() })
      .strict()
      .parse(body ?? {});
    const role = await this.roleBySlug(slug);
    const out = await roleCommand(this.deps.db, 'roles.version.write', async (tx) => {
      const state = roleState(tx);
      const [locked] = state
        ? [state.table('agentRoles').get(role.id)]
        : await tx.select().from(agentRoles).where(eq(agentRoles.id, role.id)).limit(1).for('update');
      const metadata = roleState(tx)
        ?.table('agentRoleVersions')
        .all()
        .find((v) => v.roleId === role.id && v.state === 'draft');
      const [draft] = roleState(tx)
        ? [metadata ? await roleVersion(tx, metadata.id) : undefined]
        : await tx
            .select()
            .from(agentRoleVersions)
            .where(and(eq(agentRoleVersions.roleId, role.id), eq(agentRoleVersions.state, 'draft')))
            .limit(1);
      if (!draft) throw new NotFoundError('No draft to publish', 'role_draft_not_found');
      const files = await versionFiles(tx, draft.id);
      return publishVersion(tx, locked!, {
        manifest: draft.manifest,
        files,
        changelog: input.changelog ?? draft.changelog,
        actor,
        draftId: draft.id,
      });
    });
    const state = roleState(this.deps.db);
    const [fresh] = state
      ? [state.table('agentRoles').get(role.id)]
      : await this.deps.db.select().from(agentRoles).where(eq(agentRoles.id, role.id)).limit(1);
    await this.proposals.announce(fresh!, out.version, out.previous);
    rolePublish(() =>
      wsPublisher.publish('agent_roles.changed', { slug: role.slug, version: out.version.version }),
    );
    return this.detailAdmin(role.slug);
  }

  async revert(
    slug: string,
    body: unknown,
    actor: RoleActor,
  ): Promise<Awaited<ReturnType<RolesService['detailAdmin']>>> {
    if (ownerRuntimeFor(this.deps.db) && !roleContext())
      return roleCommand(this.deps.db, 'roles.revert', () => this.revert(slug, body, actor));
    const input = z
      .object({ version: z.number().int().positive(), reason: z.string().trim().min(1).max(2000) })
      .strict()
      .parse(body ?? {});
    const role = await this.roleBySlug(slug);
    await this.proposals.revertTo(
      role.id,
      input.version,
      actor,
      `revert to v${input.version}: ${input.reason}`,
    );
    rolePublish(() => wsPublisher.publish('agent_roles.changed', { slug: role.slug }));
    return this.detailAdmin(role.slug);
  }

  async withdraw(
    slug: string,
    number: number,
    body: unknown,
  ): Promise<Awaited<ReturnType<RolesService['detailAdmin']>>> {
    if (ownerRuntimeFor(this.deps.db) && !roleContext())
      return roleCommand(this.deps.db, 'roles.withdraw', () => this.withdraw(slug, number, body));
    const input = z
      .object({ reason: z.string().trim().min(1).max(2000) })
      .strict()
      .parse(body ?? {});
    const role = await this.roleBySlug(slug);
    const version = await roleCommand(this.deps.db, 'roles.version.write', async (tx) => {
      if (!roleContext())
        await tx.select().from(agentRoles).where(eq(agentRoles.id, role.id)).limit(1).for('update');
      const metadata = roleState(tx)
        ?.table('agentRoleVersions')
        .all()
        .find((v) => v.roleId === role.id && v.version === number);
      const [row] = roleState(tx)
        ? [metadata ? await roleVersion(tx, metadata.id) : undefined]
        : await tx
            .select()
            .from(agentRoleVersions)
            .where(and(eq(agentRoleVersions.roleId, role.id), eq(agentRoleVersions.version, number)))
            .limit(1);
      if (!row || row.state !== 'published')
        throw new ConflictError(`Version ${number} is not published`, 'role_version_not_published');
      const now = nowIso();
      const patch = {
          state: 'withdrawn',
          withdrawnAt: now,
          changelog: `${row.changelog ?? ''}\n[withdrawn] ${input.reason}`.trim(),
          updatedAt: now,
        },
        ctx = roleContext();
      if (ctx) {
        stageRoleVersion(ctx, { ...row, ...patch });
        ctx.command.write(async (db) =>
          db.update(agentRoleVersions).set(patch).where(eq(agentRoleVersions.id, row.id)),
        );
      } else await tx.update(agentRoleVersions).set(patch).where(eq(agentRoleVersions.id, row.id));
      await recomputeCurrent(tx, role.id);
      return { ...row, state: 'withdrawn' };
    });
    const state = roleState(this.deps.db);
    const [fresh] = state
      ? [state.table('agentRoles').get(role.id)]
      : await this.deps.db.select().from(agentRoles).where(eq(agentRoles.id, role.id)).limit(1);
    await this.proposals.announce(fresh!, version, null, 'withdrawn');
    rolePublish(() => wsPublisher.publish('agent_roles.changed', { slug: role.slug }));
    return this.detailAdmin(role.slug);
  }

  async timeline(slug: string) {
    const role = await this.roleBySlug(slug);
    const state = roleState(this.deps.db);
    const versions = state
      ? state
          .table('agentRoleVersions')
          .all()
          .filter((v) => v.roleId === role.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      : await this.deps.db
          .select()
          .from(agentRoleVersions)
          .where(eq(agentRoleVersions.roleId, role.id))
          .orderBy(desc(agentRoleVersions.createdAt));
    const proposals = state
      ? state
          .table('agentRoleProposals')
          .all()
          .filter((row) => row.roleId === role.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 200)
      : await this.deps.db
          .select()
          .from(agentRoleProposals)
          .where(eq(agentRoleProposals.roleId, role.id))
          .orderBy(desc(agentRoleProposals.createdAt))
          .limit(200);
    return {
      role: role.slug,
      versions: versions
        .filter((version) => version.state !== 'draft')
        .map((version) => versionView(role, version)),
      proposals: proposals.map((row) => this.proposals.view(row, role)),
    };
  }

  async proposalDetail(id: string) {
    const state = roleState(this.deps.db);
    const [row] = state
      ? [state.table('agentRoleProposals').get(id)]
      : await this.deps.db.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, id)).limit(1);
    if (!row) throw new NotFoundError('Proposal not found', 'proposal_not_found');
    const [role] = state
      ? [state.table('agentRoles').get(row.roleId)]
      : await this.deps.db.select().from(agentRoles).where(eq(agentRoles.id, row.roleId)).limit(1);
    const before: Array<{ path: string; text: string | null }> = [];
    if (role?.currentVersionId) {
      const current = await roleVersion(this.deps.db, role.currentVersionId);
      const files = await versionFiles(this.deps.db, role.currentVersionId);
      for (const op of row.ops as Array<{ path: string }>) {
        if (op.path === ROLE_MANIFEST_PATH) before.push({ path: op.path, text: current?.manifest ?? null });
        else {
          const file = files.find((entry) => entry.path === op.path);
          const blob =
            file && file.encoding === FILE_ENCODING_UTF8
              ? await readBlob(this.deps.db, file.blob_sha256)
              : null;
          before.push({ path: op.path, text: blob?.content ?? null });
        }
      }
    }
    return {
      proposal: this.proposals.view(row, role),
      current: before,
      proposed: await this.proposals.opBodies(this.deps.db, row),
      events: await this.proposals.events(this.deps.db, row.id),
    };
  }

  decide(id: string, body: unknown, actor: RoleActor) {
    return this.proposals.decide(id, body, actor);
  }

  /** For an operator preview: what an activation of the current version delivers. */
  async previewActivation(slug: string) {
    const role = await this.roleBySlug(slug);
    if (!role.currentVersionId)
      throw new NotFoundError(`Role ${slug} has no published version`, 'role_version_not_found');
    const version = await roleVersion(this.deps.db, role.currentVersionId);
    return activationPayload(this.deps.db, role, version!);
  }
}
