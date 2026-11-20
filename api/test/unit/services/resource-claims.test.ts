import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  overlaps,
  parseAcquireForHost,
  resourceSchema,
  repositoryIdentity,
} from '../../../src/services/agent-coordination/model.js';
const acquire = (resource: Record<string, unknown>) => ({
  client_request_id: '00000000-0000-4000-8000-000000000001',
  purpose: 'test',
  resources: [resource],
});
const issues = (input: unknown, hostId = 7) => {
  try {
    parseAcquireForHost(input, hostId);
  } catch (err) {
    if (err instanceof ZodError) return err.issues;
    throw err;
  }
  throw new Error('accepted');
};
describe('flattened native resource input', () => {
  it('rejects fqdn on host-local kinds and names host_id and kind remote instead', () => {
    for (const resource of [
      { kind: 'service', fqdn: 'web01.example.org', service: 'nginx:reload' },
      { kind: 'path', fqdn: 'web01.example.org', path: '/etc/pki' },
      { kind: 'git', fqdn: 'web01.example.org', common_dir: '/repo/.git', branch: 'main' },
      { kind: 'service', host_id: 7, fqdn: 'web01.example.org', service: 'nginx:reload' },
    ]) {
      const [issue, ...rest] = issues(acquire(resource));
      expect(rest).toEqual([]);
      expect(issue).toMatchObject({ code: 'unrecognized_keys', keys: ['fqdn'], path: ['resources', 0] });
      expect(issue!.message).toContain("Unrecognized key(s) in object: 'fqdn'");
      expect(issue!.message).toContain(`kind ${resource.kind} accepts`);
      expect(issue!.message).toContain('host_id');
      expect(issue!.message).toContain('kind remote');
    }
    // Quoted verbatim in docs/interface-api.md.
    expect(issues(acquire({ kind: 'service', fqdn: 'web01.example.org', service: 'nginx:reload' }))[0]!.message).toBe(
      "Unrecognized key(s) in object: 'fqdn'. kind service accepts host_id and service. Select the managed fleet host with host_id (omit it for this session's host); fqdn belongs only to kind remote, for an unmanaged SSH target.",
    );
  });
  it('names the accepted fields of a remote target when given host_id', () => {
    const [issue] = issues(acquire({ kind: 'remote', host_id: 7, fqdn: 'lab.example.org', service: 'vm:a' }));
    expect(issue!.message).toContain('kind remote accepts fqdn and service');
    expect(issue!.message).toContain('kind path, git or service');
  });
  it('keeps the canonical host_id identity and the caller-host default', () => {
    expect(parseAcquireForHost(acquire({ kind: 'service', service: 'nginx:reload' }), 7).resources).toEqual([
      { kind: 'service', host_id: 7, service: 'nginx:reload' },
    ]);
    expect(parseAcquireForHost(acquire({ kind: 'path', host_id: 9, path: '/etc/pki/' }), 7).resources).toEqual([
      { kind: 'path', host_id: 9, path: '/etc/pki' },
    ]);
  });
});
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
