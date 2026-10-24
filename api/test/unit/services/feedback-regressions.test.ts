import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { apiKillSwitch } from '../../../src/http/plugins/api-kill-switch.js';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { normalizeWorkspace, workspaceMatch, workspaceCoverage } from '../../../src/services/agent-messaging/workspace.js';
import { resourceSchema, overlaps } from '../../../src/services/agent-coordination/model.js';

describe('feedback regressions', () => {
  it('keeps repository identity on an origin-omitting refresh only for the same common dir', () => {
    const input = { cwd: '/repo', git_status: 'repository' as const, git_root: '/repo', git_common_dir: '/repo/.git' };
    const before = normalizeWorkspace({ ...input, origin_url: 'ssh://git@example.org/team/repo.git' });
    expect(normalizeWorkspace(input, before)?.repository_key).toBe(before?.repository_key);
    expect(normalizeWorkspace({ ...input, git_common_dir: '/other/.git' }, before)?.repository_key).toBeNull();
    expect(normalizeWorkspace({ ...input, origin_url: null }, before)?.repository_key).toBeNull();
  });
  it('finds a non-Git project child without matching sibling prefixes or other hosts', () => {
    const parent = { hostId: 1, cwd: '/projects/app', workspace: normalizeWorkspace({ cwd: '/projects/app', git_status: 'none', git_root: null, git_common_dir: null }) };
    const child = { hostId: 1, cwd: '/projects/app/web', workspace: null };
    expect(workspaceMatch(parent, child, 'project')).toBe('project_subdirectory');
    expect(workspaceMatch(parent, { ...child, hostId: 2 }, 'project')).toBeNull();
    expect(workspaceMatch(parent, { ...child, cwd: '/projects/application' }, 'project')).toBeNull();
    expect(workspaceCoverage(parent, [], 'project').effective_scope).toBe('project');
    expect(workspaceCoverage(parent, [child], 'project').coverage.limited).toBe(true);
  });
  it('accepts a redundant canonical path in native Git-resource union schemas', () => {
    expect(resourceSchema.parse({ kind: 'git', host_id: 1, common_dir: '/repo/.git', branch: 'main', path: '/repo' })).toMatchObject({ common_dir: '/repo/.git', branch: 'main' });
    expect(() => resourceSchema.parse({ kind: 'git', host_id: 1, common_dir: '/repo/.git', path: '../repo' })).toThrow();
  });
  it('coordinates unmanaged targets across caller hosts without inventing fleet membership', () => {
    const a = resourceSchema.parse({ kind: 'remote', fqdn: 'MX1.Example.org.', service: 'mail' });
    const b = resourceSchema.parse({ kind: 'remote', fqdn: 'mx1.example.org', service: '*' });
    expect(overlaps(a, b)).toBe(true);
    expect(overlaps(a, resourceSchema.parse({ kind: 'remote', fqdn: 'mx2.example.org', service: 'mail' }))).toBe(false);
    expect(() => resourceSchema.parse({ kind: 'remote', fqdn: 'https://mx1.example.org', service: 'mail' })).toThrow();
  });
  it('blocks direct bridge, relay, MCP, unknown and health requests before their handlers', async () => {
    const app = Fastify({ ignoreTrailingSlash: true });
    await app.register(envelopePlugin);
    let disabled = true;
    await app.register(apiKillSwitch(async () => disabled));
    for (const path of ['/host/agent-sessions/id/receiver/claim', '/relay', '/mcp', '/healthz']) app.post(path, async () => ({ reached: true }));
    app.get('/admin/api/state', async () => ({ disabled }));
    app.get('/admin/*', async () => ({ spa: true }));
    try {
      for (const path of ['/host/agent-sessions/id/receiver/claim', '/relay', '/mcp', '/healthz', '/unknown']) {
        const result = await app.inject({ method: 'POST', url: path });
        expect(result.statusCode).toBe(503);
        expect(result.json().code ?? result.json().error?.code).toBe('api_disabled');
      }
      expect((await app.inject('/admin/api/state?x=1')).statusCode).toBe(200);
      expect((await app.inject('/admin/api/state/')).statusCode).toBe(200);
      expect((await app.inject('/admin/api/state//')).statusCode).toBe(503);
      disabled = false;
      expect((await app.inject({ method: 'POST', url: '/mcp' })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
});
