import { describe, expect, it } from 'vitest';
import {
  overlaps,
  resourceSchema,
  repositoryIdentity,
} from '../../../src/services/agent-coordination/model.js';
describe('canonical resource conflicts', () => {
  it('uses path boundaries and host identity, including root claims', () => {
    const a = { kind: 'path' as const, host_id: 1, path: '/srv/app' };
    expect(overlaps(a, { ...a, path: '/srv/app/file' })).toBe(true);
    expect(overlaps(a, { ...a, path: '/srv/apple' })).toBe(false);
    expect(overlaps(a, { ...a, host_id: 2 })).toBe(false);
    expect(overlaps(a, { ...a, path: '/' })).toBe(true);
    expect(() => resourceSchema.parse({ ...a, path: '/srv/../etc' })).toThrow();
  });
  it('reserves common Git metadata across branches, but permits independent branches', () => {
    const a = { kind: 'git' as const, host_id: 1, common_dir: '/repo/.git', branch: 'main' };
    expect(overlaps(a, { ...a, branch: 'topic' })).toBe(false);
    expect(overlaps(a, { ...a, branch: undefined })).toBe(true);
  });
  it('uses repository identity across hosts and host-local fallback without Git', () => {
    const a = { hostId: 1, cwd: '/repo', workspace: null };
    expect(repositoryIdentity(a)).not.toBe(repositoryIdentity({ ...a, hostId: 2 }));
    const w = {
      cwd: '/repo',
      git_status: 'repository',
      git_root: '/repo',
      git_common_dir: '/repo/.git',
      repository_key: 'same-remote',
    };
    expect(repositoryIdentity({ ...a, workspace: w })).toBe(
      repositoryIdentity({ ...a, hostId: 2, workspace: w }),
    );
  });
});
