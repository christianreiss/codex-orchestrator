/**
 * Publishing: the one place a role version becomes immutable and current,
 * whether an operator publishes a draft, a proposal is applied or a version is
 * reverted. Callers hold the role row lock.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, isNotNull, max } from 'drizzle-orm';
import { agentRoleVersions, agentRoles, type AgentRole, type AgentRoleVersion } from '../../db/schema.js';
import { sha256 } from '../../security/hash.js';
import { isoOffsetSeconds, nowIso } from '../../util/timestamp.js';
import { assertPublishable, bundleDigest, writeVersionFiles, type RoleDb, type RoleFileEntry } from './content.js';
import { readRolePolicy, roleUri, type RoleActor } from './contract.js';

export interface PublishInput {
  manifest: string;
  files: RoleFileEntry[];
  changelog: string | null;
  actor: RoleActor;
  sourceProposalId?: string | null;
  revertedFromVersion?: number | null;
  /** Publish this existing draft row instead of inserting a new one. */
  draftId?: string;
}

export async function nextVersionNumber(db: RoleDb, roleId: string): Promise<number> {
  const [row] = await db.select({ value: max(agentRoleVersions.version) }).from(agentRoleVersions).where(eq(agentRoleVersions.roleId, roleId));
  return Number(row?.value ?? 0) + 1;
}

/** Versions published in the rolling 24 hours, against the policy budget. */
export async function publishedInLastDay(db: RoleDb, roleId: string): Promise<number> {
  const rows = await db
    .select({ id: agentRoleVersions.id })
    .from(agentRoleVersions)
    .where(and(eq(agentRoleVersions.roleId, roleId), isNotNull(agentRoleVersions.publishedAt), gte(agentRoleVersions.publishedAt, isoOffsetSeconds(-86400))));
  return rows.length;
}

export async function publishVersion(db: RoleDb, role: AgentRole, input: PublishInput): Promise<{ version: AgentRoleVersion; previous: AgentRoleVersion | null }> {
  assertPublishable(role.slug, input.manifest, input.files);
  const number = await nextVersionNumber(db, role.id);
  const files = input.files.map((file) => ({ ...file, introduced_in_version: file.introduced_in_version ?? number }));
  const manifestSha = sha256(input.manifest);
  const bundle = bundleDigest(manifestSha, files);
  const now = nowIso();
  const id = input.draftId ?? randomUUID();
  const row = {
    version: number,
    state: 'published',
    manifest: input.manifest,
    manifestSha256: manifestSha,
    bundleSha256: bundle,
    changelog: input.changelog,
    publishedBy: { ...input.actor },
    publishedAt: now,
    sourceProposalId: input.sourceProposalId ?? null,
    revertedFromVersion: input.revertedFromVersion ?? null,
    updatedAt: now,
  };
  if (input.draftId) {
    await db.update(agentRoleVersions).set(row).where(eq(agentRoleVersions.id, input.draftId));
  } else {
    await db.insert(agentRoleVersions).values({ id, roleId: role.id, createdBy: { ...input.actor }, createdAt: now, ...row });
  }
  await writeVersionFiles(db, id, files);
  const previous = role.currentVersionId
    ? ((await db.select().from(agentRoleVersions).where(eq(agentRoleVersions.id, role.currentVersionId)).limit(1))[0] ?? null)
    : null;
  await db.update(agentRoles).set({ currentVersionId: id, updatedAt: now }).where(eq(agentRoles.id, role.id));
  const [version] = await db.select().from(agentRoleVersions).where(eq(agentRoleVersions.id, id)).limit(1);
  return { version: version!, previous };
}

/** After a withdraw the newest published version that remains becomes current. */
export async function recomputeCurrent(db: RoleDb, roleId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: agentRoleVersions.id })
    .from(agentRoleVersions)
    .where(and(eq(agentRoleVersions.roleId, roleId), eq(agentRoleVersions.state, 'published')))
    .orderBy(desc(agentRoleVersions.version))
    .limit(1);
  const id = row?.id ?? null;
  await db.update(agentRoles).set({ currentVersionId: id, updatedAt: nowIso() }).where(eq(agentRoles.id, roleId));
  return id;
}

/** ROLE-UPDATE/1: what a holder pinned to an older version is told. Informational. */
export function roleUpdateNotice(role: AgentRole, version: AgentRoleVersion, previous: AgentRoleVersion | null, severity: 'published' | 'withdrawn' = 'published'): string {
  const policy = readRolePolicy(role.policy);
  const upgrade =
    policy.holder_upgrade === 'at_task_boundary'
      ? `Between two work items (never in the middle of one), move to it with agent_role_activate {role:"${role.slug}", version:"latest", activated_by:"self_upgrade", reason:"upgrade v${previous?.version ?? '?'} -> v${version.version}", client_request_id:<new UUID>}, say so in your next answer, and work from the new core it returns.`
      : 'Stay on your pinned version; change only on your principal\'s explicit instruction.';
  const lines =
    severity === 'withdrawn'
      ? [
          `ROLE-UPDATE/1 role=${role.slug} withdrawn=${version.version} severity=withdrawn`,
          'Informational; no reply required.',
          '',
          `Version ${version.version} of role ${role.slug} was withdrawn as faulty. Tell your principal you are still on it, and move to the current version at the next task boundary: agent_role_activate {role:"${role.slug}", version:"latest", activated_by:"self_upgrade", ...}.`,
        ]
      : [
          `ROLE-UPDATE/1 role=${role.slug} version=${version.version} previous=${previous?.version ?? 'none'} sha=${version.bundleSha256.slice(0, 12)}`,
          'Informational; no reply required.',
          '',
          `A new version of role ${role.slug} is published: ${roleUri(role.slug, version.version)}.`,
          version.changelog ? `Changelog: ${version.changelog}` : 'No changelog was given.',
          `Your session keeps the version it activated. ${upgrade}`,
        ];
  return lines.join('\n');
}
