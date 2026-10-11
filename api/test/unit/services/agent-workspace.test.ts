import { describe, expect, it } from 'vitest';
import {
  normalizeWorkspace,
  workspaceMatch,
  type WorkspaceInput,
} from '../../../src/services/agent-messaging/workspace.js';
import { pageAgentAddresses } from '../../../src/services/agent-messaging/discovery.js';

const input = (
  cwd = '/repo',
  common = '/repo/.git',
  origin = 'git@example.org:team/repo.git',
): WorkspaceInput => ({
  cwd,
  git_status: 'repository',
  git_root: cwd,
  git_common_dir: common,
  origin_url: origin,
});
const location = (hostId = 1, workspace = normalizeWorkspace(input()), cwd = '/repo') => ({
  hostId,
  cwd,
  workspace,
});

describe('workspace discovery', () => {
  it('matches subdirectories and linked worktrees through the common directory', () => {
    const caller = location();
    expect(
      workspaceMatch(
        caller,
        location(1, normalizeWorkspace(input('/repo/api', '/repo/.git', ''))),
        'project',
      ),
    ).toBe('same_clone');
    expect(
      workspaceMatch(caller, location(1, normalizeWorkspace(input('/linked', '/repo/.git', ''))), 'project'),
    ).toBe('same_clone');
    expect(
      workspaceMatch(caller, location(1, normalizeWorkspace(input('/repo/api'))), 'directory'),
    ).toBeNull();
  });
  it('matches equivalent network remotes across hosts without persisting secrets', () => {
    for (const remote of [
      'https://user:secret@example.org/team/repo.git?token=secret#secret',
      'ssh://git@example.org:2222/team/repo/',
      'git@example.org:team/repo.git',
    ]) {
      const workspace = normalizeWorkspace(input('/elsewhere', '/elsewhere/.git', remote));
      expect(JSON.stringify(workspace)).not.toMatch(/secret|origin_url|example.org/);
      expect(workspaceMatch(location(), location(2, workspace), 'project')).toBe('same_repository');
      expect(workspaceMatch(location(), location(2, workspace), 'directory')).toBeNull();
    }
  });
  it('does not match different repos or host-local remotes across hosts', () => {
    for (const remote of ['git@example.org:team/other.git', '/srv/repo', 'file:///srv/repo', '../repo']) {
      expect(
        workspaceMatch(
          location(),
          location(2, normalizeWorkspace(input('/repo', '/repo/.git', remote))),
          'project',
        ),
      ).toBeNull();
    }
    expect(workspaceMatch(location(), location(2, null), 'directory')).toBeNull();
  });
  it('keeps exact-directory discovery for legacy and non-Git sessions', () => {
    const noGit = normalizeWorkspace({
      cwd: '/repo',
      git_status: 'none',
      git_root: null,
      git_common_dir: null,
    });
    expect(workspaceMatch(location(1, noGit), location(1, null), 'project')).toBe('same_directory');
    expect(workspaceMatch(location(1, null), location(), 'directory')).toBe('same_directory');
    expect(workspaceMatch(location(1, null), location(1, null, '/repo-other'), 'project')).toBeNull();
  });
  it('filters scope before pagination and preserves multiple agents at one path', () => {
    const peers = Array.from({ length: 53 }, (_, i) => ({
      ...location(i === 0 ? 2 : 1, null),
      address: { address: `agent:${i}`, launchName: null, displayAlias: null },
    }));
    const scoped = peers.filter((peer) => workspaceMatch(location(), peer, 'directory'));
    const page = pageAgentAddresses(scoped, { limit: 50 });
    expect(page).toMatchObject({ total: 52, next_offset: 50 });
    expect(pageAgentAddresses(scoped, { offset: 50 }).addresses).toHaveLength(2);
  });
  it('rejects relative, null-byte and inconsistent workspace facts', () => {
    expect(() => normalizeWorkspace({ ...input(), cwd: 'relative' })).toThrow();
    expect(() => normalizeWorkspace({ ...input(), cwd: '/repo\0' })).toThrow();
    expect(() => normalizeWorkspace({ ...input(), git_common_dir: null })).toThrow();
    expect(() => normalizeWorkspace({ ...input(), git_status: 'none' })).toThrow();
  });
});
