/**
 * Agent roles: the shared vocabulary of the role package, its limits and the
 * operator policy. Nothing here touches the database.
 *
 * A role is a versioned package — a `ROLE.md` manifest (YAML frontmatter plus
 * the role prompt) and optional support files. A role grants no permission:
 * its content is data below the fleet policy, and nothing in this module turns
 * it into an authorization decision.
 */
import yaml from 'js-yaml';
import { ApiError, ValidationError } from '../../http/errors.js';
import { FILE_MAX_DECODED_BYTES } from '../project-file-encoding.js';

export const ROLES_ENABLED_KEY = 'roles_enabled';
/** First cxx that serves the agent_role_* tools and the role-aware SessionStart hook. */
export const ROLES_MIN_CXX_VERSION = '0.9.108';
export const ROLE_MANIFEST_PATH = 'ROLE.md';

/** Manifest plus `core` files, delivered whole on every activation. */
export const ROLE_CORE_MAX_BYTES = 48 * 1024;
export const ROLE_FILE_MAX_BYTES = FILE_MAX_DECODED_BYTES;
export const ROLE_VERSION_MAX_BYTES = 16 * 1024 * 1024;
export const ROLE_MAX_FILES = 256;
export const ROLE_PATH_MAX = 512;
export const ROLE_SUMMARY_MAX = 600;
export const ROLE_REASON_MAX = 2000;
/** Unreviewed `modifying` proposals fall back to a stricter judge pass after this. */
export const ROLE_REVIEW_FALLBACK_SECONDS = 72 * 3600;
/** `in_review` or `held` proposals untouched this long are superseded. */
export const ROLE_PROPOSAL_EXPIRY_SECONDS = 14 * 24 * 3600;
export const ROLE_PROPOSALS_PER_HOUR = 20;

export const ROLE_LOAD_MODES = ['core', 'on_demand'] as const;
export type RoleLoadMode = (typeof ROLE_LOAD_MODES)[number];

export const ROLE_ACTIVATION_KINDS = ['operator_prompt', 'portal', 'spawn', 'peer', 'self_upgrade'] as const;
export type RoleActivationKind = (typeof ROLE_ACTIVATION_KINDS)[number];

export const ROLE_PROPOSAL_KINDS = ['file_add', 'file_change', 'file_remove', 'manifest_change', 'note', 'revert'] as const;
export type RoleProposalKind = (typeof ROLE_PROPOSAL_KINDS)[number];

export type RoleRisk = 'additive' | 'modifying' | 'core' | 'revert';
export type RoleProposalStatus = 'checking' | 'in_review' | 'held' | 'applied' | 'rejected' | 'withdrawn' | 'superseded';
export const ROLE_OPEN_PROPOSAL_STATUSES: RoleProposalStatus[] = ['checking', 'in_review', 'held'];

export interface RolePolicy {
  /** autonomous publishes on its own; supervised holds every publish for `decide`; frozen changes nothing. */
  mutation: 'autonomous' | 'supervised' | 'frozen';
  /** Paths only an operator may change (or `decide` under supervision). */
  protected_paths: string[];
  /** Published versions per rolling 24 hours before further proposals are held. */
  daily_budget: number;
  /** Whether a holder moves to a newer version on its own at a task boundary. */
  holder_upgrade: 'at_task_boundary' | 'manual';
  /** Whether a role verdict binds. Reserved: nothing enforces it yet. */
  verdict_binding: boolean;
}

export const DEFAULT_ROLE_POLICY: RolePolicy = {
  mutation: 'autonomous',
  protected_paths: [],
  daily_budget: 10,
  holder_upgrade: 'at_task_boundary',
  verdict_binding: false,
};

export interface RoleActor {
  kind: 'admin' | 'agent' | 'server';
  admin_user_id?: number;
  address_id?: string;
  session_id?: string;
  host_id?: number;
  engine?: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function normalizeRoleSlug(value: unknown): string {
  const slug = String(value ?? '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw new ValidationError('role must be 1–64 lowercase letters, digits, dots, underscores or hyphens', { param: 'role' });
  }
  return slug;
}

/** Relative, forward-slash, no traversal, no hidden segments, never the manifest name. */
export function normalizeRolePath(value: unknown): string {
  const path = String(value ?? '').trim();
  if (!path || path.length > ROLE_PATH_MAX) {
    throw new ValidationError(`path must be 1–${ROLE_PATH_MAX} characters`, { param: 'path' });
  }
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    throw new ValidationError('path must be relative and use forward slashes', { param: 'path' });
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    throw new ValidationError('path segments must be non-empty and must not start with a dot', { param: 'path' });
  }
  if (path === ROLE_MANIFEST_PATH) {
    throw new ValidationError(`${ROLE_MANIFEST_PATH} is the manifest, not a support file`, { param: 'path' });
  }
  return path;
}

export interface RoleToolHint {
  name?: string;
  capability?: string;
  candidates?: string[];
  why?: string;
}

export interface RoleManifest {
  name: string;
  /** Short label for session titles, "(Name) (Label) task"; falls back to the display name. */
  label: string | null;
  summary: string | null;
  responsibilities: string[];
  boundaries: string[];
  tools: { required: RoleToolHint[]; recommended: RoleToolHint[] };
  collaboration: { accepts: string[]; finding_classes: string[]; priorities: string[] };
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()) : [];

const toolList = (value: unknown): RoleToolHint[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => ({
          ...(typeof item.name === 'string' ? { name: item.name } : {}),
          ...(typeof item.capability === 'string' ? { capability: item.capability } : {}),
          ...(Array.isArray(item.candidates) ? { candidates: stringList(item.candidates) } : {}),
          ...(typeof item.why === 'string' ? { why: item.why } : {}),
        }))
    : [];

/**
 * Parse `ROLE.md`. Frontmatter is required and must name the role; everything
 * else is optional and only ever descriptive. The body is the role prompt and
 * is kept byte for byte.
 */
export function parseRoleManifest(slug: string, manifest: unknown): RoleManifest {
  if (typeof manifest !== 'string' || manifest.trim() === '') {
    throw new ValidationError('manifest is required', { param: 'manifest' });
  }
  const match = FRONTMATTER.exec(manifest);
  if (!match) throw new ValidationError('manifest must open with YAML frontmatter (---)', { param: 'manifest' });
  let front: unknown;
  try {
    front = yaml.load(match[1]!, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    throw new ValidationError(`manifest frontmatter is not valid YAML: ${(error as Error).message}`, { param: 'manifest' });
  }
  if (!front || typeof front !== 'object' || Array.isArray(front)) {
    throw new ValidationError('manifest frontmatter must be a mapping', { param: 'manifest' });
  }
  const fields = front as Record<string, unknown>;
  if (fields.name !== slug) {
    throw new ValidationError(`manifest frontmatter name must be "${slug}"`, { param: 'manifest' });
  }
  const tools = (fields.tools && typeof fields.tools === 'object' ? fields.tools : {}) as Record<string, unknown>;
  const collaboration = (fields.collaboration && typeof fields.collaboration === 'object' ? fields.collaboration : {}) as Record<string, unknown>;
  const body = manifest.slice(match[0].length);
  if (!body.trim()) throw new ValidationError('manifest needs a role prompt after the frontmatter', { param: 'manifest' });
  return {
    name: slug,
    label: typeof fields.label === 'string' && fields.label.trim() ? fields.label.trim().replace(/[()]/g, '').slice(0, 40) : null,
    summary: typeof fields.summary === 'string' ? fields.summary.trim() : null,
    responsibilities: stringList(fields.responsibilities),
    boundaries: stringList(fields.boundaries),
    tools: { required: toolList(tools.required), recommended: toolList(tools.recommended) },
    collaboration: {
      accepts: stringList(collaboration.accepts),
      finding_classes: stringList(collaboration.finding_classes),
      priorities: stringList(collaboration.priorities),
    },
    body,
  };
}

export function normalizeRolePolicy(input: unknown, base: RolePolicy = DEFAULT_ROLE_POLICY): RolePolicy {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const policy: RolePolicy = { ...base, protected_paths: [...base.protected_paths] };
  if (raw.mutation !== undefined) {
    if (!['autonomous', 'supervised', 'frozen'].includes(String(raw.mutation)))
      throw new ValidationError('mutation must be autonomous, supervised or frozen', { param: 'mutation' });
    policy.mutation = raw.mutation as RolePolicy['mutation'];
  }
  if (raw.protected_paths !== undefined) {
    if (!Array.isArray(raw.protected_paths)) throw new ValidationError('protected_paths must be a list', { param: 'protected_paths' });
    policy.protected_paths = [...new Set(raw.protected_paths.map((path) => (path === ROLE_MANIFEST_PATH ? path : normalizeRolePath(path))))].slice(0, 64);
  }
  if (raw.daily_budget !== undefined) {
    const budget = Number(raw.daily_budget);
    if (!Number.isInteger(budget) || budget < 0 || budget > 1000)
      throw new ValidationError('daily_budget must be an integer from 0 to 1000', { param: 'daily_budget' });
    policy.daily_budget = budget;
  }
  if (raw.holder_upgrade !== undefined) {
    if (!['at_task_boundary', 'manual'].includes(String(raw.holder_upgrade)))
      throw new ValidationError('holder_upgrade must be at_task_boundary or manual', { param: 'holder_upgrade' });
    policy.holder_upgrade = raw.holder_upgrade as RolePolicy['holder_upgrade'];
  }
  if (raw.verdict_binding !== undefined) {
    if (typeof raw.verdict_binding !== 'boolean') throw new ValidationError('verdict_binding must be a boolean', { param: 'verdict_binding' });
    policy.verdict_binding = raw.verdict_binding;
  }
  return policy;
}

/** Stored policies predate later fields; read them through the defaults. */
export function readRolePolicy(stored: unknown): RolePolicy {
  try {
    return normalizeRolePolicy(stored);
  } catch {
    return { ...DEFAULT_ROLE_POLICY };
  }
}

export function rolesDisabledError(): ApiError {
  return new ApiError('Agent roles are disabled on this fleet', { status: 403, code: 'roles_disabled' });
}

/** The URI an agent reads a version, or one file of it, through `resource_read`. */
export function roleUri(slug: string, version?: number | null, path?: string): string {
  const base = `role://${slug}${version ? `@${version}` : ''}`;
  return path ? `${base}/${path.split('/').map(encodeURIComponent).join('/')}` : base;
}

/** Common credential shapes; a role is shared fleet-wide and must never carry one. */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['slack_token', /\bxox[abpors]-[A-Za-z0-9-]{10,}/],
  ['fleet_bridge_token', /\bcxx_[a-z]+_[A-Za-z0-9]{24,}/],
];

export function findSecretShapes(text: string): string[] {
  return SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}
