import { z } from 'zod';
import { define } from './tool-definition.js';
import type { ChattyTool, ToolContext } from './tools.js';
import { RolesService } from '../roles.js';
import { SettingsService } from '../settings.js';
import { createAgentMessagingService } from '../agent-messaging.js';
import type { RoleActor } from '../roles/contract.js';
import {
  retentionStatus,
  saveRetentionPolicy,
  previewRetention,
  requestRetentionRun,
  retentionRun,
} from '../server-retention/admin.js';

const slug = z.string().min(1).max(64);
const version = z.number().int().positive();
const reason = z.string().trim().min(1).max(2000);
const policy = z
  .object({
    mutation: z.enum(['autonomous', 'supervised', 'frozen']).optional(),
    protected_paths: z.array(z.string().min(1).max(512)).max(64).optional(),
    daily_budget: z.number().int().min(0).max(1000).optional(),
    holder_upgrade: z.enum(['at_task_boundary', 'manual']).optional(),
    verdict_binding: z.boolean().optional(),
  })
  .strict();
const file = z
  .object({
    path: z.string().min(1).max(512),
    content: z.string().optional(),
    encoding: z.enum(['utf8', 'base64']).optional(),
    blob_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    mime_type: z.string().max(127).optional(),
    load: z.enum(['core', 'on_demand']).optional(),
    description: z.string().nullable().optional(),
  })
  .strict();
const actor = (c: ToolContext): RoleActor => ({ kind: 'admin', admin_user_id: c.actor.userId });
function roles(c: ToolContext) {
  const messaging = createAgentMessagingService(c.db, c.env, c.keyring);
  // Operator actions do not invoke the proposal judge. Notices use the same
  // owned messaging callbacks as the admin route's RolesService.
  return new RolesService({
    db: c.db,
    settings: new SettingsService(c.db),
    notifyOwned: async (command, addresses, body) => {
      await messaging.noticeAddressesOwned(command, addresses, body);
    },
    notify: async (addresses, body) => {
      await messaging.noticeAddresses(addresses, body);
    },
  });
}
const detail = (c: ToolContext, a: { slug: string }) => roles(c).detailAdmin(a.slug);
const href = (a: { slug: string }) => `/admin/library/roles/${encodeURIComponent(a.slug)}`;
const retentionSnapshot = async (c: ToolContext) => {
  const status = retentionStatus(c.db);
  // Observation clocks and due flags are not confirmation targets.
  return { policy: status.policy, revision: status.revision, run: status.run };
};

/** Named domain operations; every write needs a confirmed prepared action. */
export function roleRetentionTools(): ChattyTool[] {
  return [
    define('role_state_read', 'Read whether agent roles are enabled.', 'content.read', {}, async (c) => ({
      enabled: await roles(c).isEnabled(),
    })),
    define(
      'role_state_set',
      'Enable or suspend agent roles.',
      'content.manage',
      { enabled: z.boolean() },
      (c, a) => roles(c).setEnabled(a.enabled),
      { confirm: true, snapshot: async (c) => ({ enabled: await roles(c).isEnabled() }) },
    ),
    define('roles_list', 'List agent roles, policies, versions and holder counts.', 'content.read', {}, (c) =>
      roles(c).listAdmin(),
    ),
    define('role_read', 'Read one role, its draft, versions and holders.', 'content.read', { slug }, detail, {
      href,
    }),
    define(
      'role_create',
      'Create an unpublished role and its mutation policy.',
      'content.manage',
      {
        slug,
        display_name: z.string().trim().min(1).max(255),
        summary: z.string().trim().min(1).max(600),
        policy: policy.optional(),
      },
      (c, a) => roles(c).createRole(a, actor(c)),
      { confirm: true, snapshot: async (c) => roles(c).listAdmin(), href },
    ),
    define(
      'role_update',
      'Update role metadata or policy at the version you read.',
      'content.manage',
      {
        slug,
        display_name: z.string().trim().min(1).max(255).optional(),
        summary: z.string().trim().min(1).max(600).optional(),
        status: z.enum(['active', 'retired']).optional(),
        policy: policy.optional(),
        expected_version: version,
      },
      (c, { slug: target, ...body }) => roles(c).updateRole(target, body),
      { confirm: true, snapshot: detail, href },
    ),
    define(
      'role_draft_read',
      'Read the operator draft manifest and file index.',
      'content.read',
      { slug },
      async (c, a) => (await detail(c, a)).draft,
      { href },
    ),
    define(
      'role_draft_save',
      'Replace the operator draft manifest and support files. Omitted files become an empty file list.',
      'content.manage',
      {
        slug,
        manifest: z.string().min(1),
        files: z.array(file).max(256).optional(),
        changelog: z.string().max(4000).nullable().optional(),
      },
      (c, { slug: target, ...body }) => roles(c).saveDraft(target, body, actor(c)),
      { confirm: true, snapshot: detail, href },
    ),
    define(
      'role_draft_discard',
      'Discard the unpublished operator draft.',
      'content.manage',
      { slug },
      (c, a) => roles(c).discardDraft(a.slug),
      { confirm: true, snapshot: detail, href },
    ),
    define(
      'role_publish',
      'Publish the operator draft and notify role holders.',
      'content.manage',
      { slug, changelog: z.string().max(4000).optional() },
      (c, { slug: target, ...body }) => roles(c).publishDraft(target, body, actor(c)),
      { confirm: true, snapshot: detail, href },
    ),
    define(
      'role_revert',
      'Publish a new version restoring an earlier version.',
      'content.manage',
      { slug, version, reason },
      (c, { slug: target, ...body }) => roles(c).revert(target, body, actor(c)),
      { confirm: true, snapshot: detail, href },
    ),
    define(
      'role_withdraw',
      'Withdraw a published version and recompute the current version.',
      'content.manage',
      { slug, version, reason },
      (c, a) => roles(c).withdraw(a.slug, a.version, { reason: a.reason }),
      { confirm: true, snapshot: detail, href },
    ),
    define(
      'role_proposal_read',
      'Read proposal before/proposed file bodies and events.',
      'content.read',
      { id: z.string().uuid() },
      (c, a) => roles(c).proposalDetail(a.id),
    ),
    define(
      'role_proposal_decide',
      'Accept or reject a held proposal, or veto an applied proposal.',
      'content.manage',
      {
        id: z.string().uuid(),
        verdict: z.enum(['accept', 'reject']),
        reason: z.string().trim().min(1).max(4000),
        expected_version: version,
      },
      (c, { id, ...body }) => roles(c).decide(id, body, actor(c)),
      { confirm: true, snapshot: (c, a) => roles(c).proposalDetail(a.id) },
    ),
    define(
      'role_timeline_read',
      'Read role version and proposal history.',
      'content.read',
      { slug },
      (c, a) => roles(c).timeline(a.slug),
      { href },
    ),
    define(
      'role_version_read',
      'Read a version manifest and support file content.',
      'content.read',
      { slug, version },
      (c, a) => roles(c).versionContent(a.slug, a.version),
      { href },
    ),
    define(
      'server_retention_read',
      'Read retention policy, status and cleanup obligations.',
      'settings.read',
      {},
      async (c) => retentionStatus(c.db),
    ),
    define(
      'server_retention_policy_set',
      'Replace retention policy using the revision you read.',
      'settings.manage',
      {
        policy: z
          .object({
            audit_days: z.number().int().min(1).max(3650),
            history_hours: z.number().int().min(1).max(87600),
            quota_days: z.number().int().min(1).max(3650),
            armed: z.boolean(),
          })
          .strict(),
        expected_revision: z.string().regex(/^[0-9a-f]{64}$/),
      },
      (c, a) => saveRetentionPolicy(c.db, a),
      { confirm: true, snapshot: retentionSnapshot, href: () => '/admin/settings#retention' },
    ),
    define(
      'server_retention_preview',
      'Preview eligible and retained history under the saved policy; no deletion.',
      'settings.read',
      {},
      (c) => previewRetention(c.db),
    ),
    define(
      'server_retention_run',
      'Request an asynchronous guarded cleanup pass. Acceptance does not prove deletion completed; read run status.',
      'settings.manage',
      { client_request_id: z.string().uuid(), expected_revision: z.string().regex(/^[0-9a-f]{64}$/) },
      (c, a) => requestRetentionRun(c.db, a),
      { confirm: true, snapshot: retentionSnapshot, href: () => '/admin/settings#retention' },
    ),
    define(
      'server_retention_run_read',
      'Read a retained run status; a newer run may replace its bounded slot.',
      'settings.read',
      { id: z.string().uuid() },
      async (c, a) => retentionRun(c.db, a.id),
    ),
  ];
}
