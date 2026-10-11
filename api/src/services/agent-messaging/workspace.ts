import { posix } from 'node:path';
import { z } from 'zod';
import { sha256 } from '../../security/hash.js';
import { normalizeRemote } from '../git-director.js';

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

/** Remote text is never persisted or returned; local remotes cannot identify a fleet project. */
export function normalizeWorkspace(input: WorkspaceInput | undefined): AgentWorkspace | null {
  if (!input) return null;
  const value = workspaceInputSchema.parse(input);
  const origin = value.origin_url?.trim().split(/[?#]/, 1)[0] ?? '';
  const networkRemote =
    /^(?:https?|ssh|git):\/\//i.test(origin) ||
    (/^(?:[^/@:]+@)?[^/:]+:[^:]/.test(origin) && !origin.includes('://'));
  const remote = networkRemote ? normalizeRemote(origin) : null;
  return {
    cwd: posix.normalize(value.cwd),
    git_status: value.git_status,
    git_root: value.git_root ? posix.normalize(value.git_root) : null,
    git_common_dir: value.git_common_dir ? posix.normalize(value.git_common_dir) : null,
    repository_key: remote ? sha256(remote) : null,
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
export type DiscoveryScope = 'fleet' | 'directory' | 'project';

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
    sameHost && posix.normalize(a?.cwd ?? caller.cwd) === posix.normalize(b?.cwd ?? peer.cwd);
  if (scope === 'directory') return sameDirectory ? 'same_directory' : null;
  if (sameDirectory) return 'same_directory';
  if (a?.git_common_dir && b?.git_common_dir && sameHost && a.git_common_dir === b.git_common_dir)
    return 'same_clone';
  if (a?.repository_key && a.repository_key === b?.repository_key) return 'same_repository';
  return null;
}
