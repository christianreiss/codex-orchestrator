import { posix } from 'node:path';
import { z } from 'zod';
import { sha256 } from '../../security/hash.js';
import { normalizeRemote } from '../git-director/remote-normalization.js';

const path = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => value.startsWith('/') && !value.includes('\0'), 'Expected an absolute path');
export const workspaceInputSchema = z
  .object({
    cwd: path,
    git_status: z.enum(['repository', 'none', 'unavailable']),
    git_root: path.nullable(),
    git_common_dir: path.nullable(),
    branch: z.string().max(255).nullable().optional(),
    head_sha: z.string().regex(/^[a-f0-9]{40,64}$/).nullable().optional(),
    origin_url: z.string().max(4096).nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.git_status === 'repository'
        ? value.git_root !== null && value.git_common_dir !== null
        : value.git_root === null && value.git_common_dir === null && !value.origin_url,
    'Git roots must agree with git_status',
  );

export type WorkspaceInput = z.infer<typeof workspaceInputSchema>;
export type AgentWorkspace = Omit<WorkspaceInput, 'origin_url'> & { repository_key: string | null };

const cleanPath = (value: string) => posix.normalize(value).replace(/\/+$/, '') || '/';

/** Remote text is never persisted or returned; local remotes cannot identify a fleet project. */
export function normalizeWorkspace(input: WorkspaceInput | undefined, previous?: AgentWorkspace | null): AgentWorkspace | null {
  if (!input) return null;
  const value = workspaceInputSchema.parse(input);
  const origin = value.origin_url?.trim().split(/[?#]/, 1)[0] ?? '';
  const networkRemote =
    /^(?:https?|ssh|git):\/\//i.test(origin) ||
    (/^(?:[^/@:]+@)?[^/:]+:[^:]/.test(origin) && !origin.includes('://'));
  const remote = networkRemote ? normalizeRemote(origin) : null;
  return {
    cwd: cleanPath(value.cwd),
    git_status: value.git_status,
    git_root: value.git_root ? cleanPath(value.git_root) : null,
    git_common_dir: value.git_common_dir ? cleanPath(value.git_common_dir) : null,
    branch: value.branch ?? null,
    head_sha: value.head_sha ?? null,
    repository_key: remote ? sha256(remote) :
      value.origin_url === undefined && value.git_status === 'repository' &&
      previous?.git_common_dir === cleanPath(value.git_common_dir!) ? previous.repository_key : null,
  };
}

export function readWorkspace(value: unknown): AgentWorkspace | null {
  if (!value || typeof value !== 'object') return null;
  const workspace = value as AgentWorkspace;
  return typeof workspace.cwd === 'string' &&
    ['repository', 'none', 'unavailable'].includes(workspace.git_status)
    ? workspace
    : null;
}

export interface WorkspaceLocation {
  hostId: number;
  cwd: string;
  workspace: unknown;
}
export type DiscoveryScope = 'fleet' | 'directory' | 'checkout' | 'project';

/** Checkout occupancy is local; unknown local peers prevent a false empty result. */
export function workspaceCoverage(
  caller: WorkspaceLocation,
  peers: WorkspaceLocation[],
  scope: DiscoveryScope,
) {
  const workspace = readWorkspace(caller.workspace);
  const population = scope === 'checkout' ? peers.filter((peer) => peer.hostId === caller.hostId) : peers;
  const missing = population.filter((peer) => {
    const value = readWorkspace(peer.workspace);
    return (
      !value || value.git_status === 'unavailable' ||
      (scope === 'checkout' && value.git_status === 'repository' && !value.git_root)
    );
  }).length;
  return {
    effective_scope: scope === 'checkout' && !workspace?.git_root ? 'directory' : scope,
    ...(scope === 'checkout' ? { checkout_root: workspace?.git_root ?? null } : {}),
    coverage: {
      limited: scope === 'checkout'
        ? !workspace?.git_root || missing > 0
        : scope === 'project' && (!workspace || workspace.git_status === 'unavailable' || missing > 0),
      peers_without_workspace: missing,
    },
  };
}

export function workspaceMatch(
  caller: WorkspaceLocation,
  peer: WorkspaceLocation,
  scope: DiscoveryScope,
): string | null {
  if (scope === 'fleet') return 'fleet';
  const a = readWorkspace(caller.workspace),
    b = readWorkspace(peer.workspace);
  const sameHost = caller.hostId === peer.hostId;
  const sameDirectory =
    sameHost && cleanPath(a?.cwd ?? caller.cwd) === cleanPath(b?.cwd ?? peer.cwd);
  if (scope === 'directory') return sameDirectory ? 'same_directory' : null;
  if (scope === 'checkout') {
    if (!sameHost) return null;
    if (a?.git_root && b?.git_root) return a.git_root === b.git_root ? 'same_checkout' : null;
    return sameDirectory ? 'same_directory' : null;
  }
  if (sameDirectory) return 'same_directory';
  if (sameHost && !a?.git_common_dir) {
    const root = cleanPath(a?.cwd ?? caller.cwd);
    const child = cleanPath(b?.cwd ?? peer.cwd);
    if (child.startsWith(root === '/' ? '/' : root + '/')) return 'project_subdirectory';
  }
  if (a?.git_common_dir && b?.git_common_dir && sameHost && a.git_common_dir === b.git_common_dir)
    return 'same_clone';
  if (a?.repository_key && a.repository_key === b?.repository_key) return 'same_repository';
  return null;
}
