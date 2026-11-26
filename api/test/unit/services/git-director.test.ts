/**
 * Unit coverage for the Git Director's decision core.
 *
 * Everything here is the pure half — the parts that decide an outcome without a
 * database — because those are the parts whose failure is silent. A wrong
 * `normalizeRemote` does not throw, it just quietly stops grouping two clones of
 * one repository and nobody finds out. A `resolveVerdict` that consults a model
 * on an uncontended request does not fail a test either, it just spends money
 * and adds latency to the common case forever.
 *
 * The DB-backed half — registration, leases, reclaim — lives in
 * `test/integration/git-director/`.
 */
import { describe, expect, it } from 'vitest';
import {
  GitDirectorService,
  normalizeJudgeVerdict,
  normalizePath,
  normalizeRemote,
  overlappingPaths,
  peerDeclarationOverlap,
  reportedShaProblem,
  resolveVerdict,
  summarizeCloneEntry,
} from '../../../src/services/git-director.js';
import type { Host } from '../../../src/db/schema.js';
import { parseJudgeReply } from '../../../src/services/git-director-judge.js';

describe('normalizeRemote', () => {
  it('collapses the ssh and https spellings of one repository onto one string', () => {
    // The whole point of the column. If these ever diverge, clones of one repo
    // silently stop grouping across hosts and there is no error to notice.
    const ssh = normalizeRemote('git@git.alpha-labs.net:chris/codex-orchestrator.git');
    const https = normalizeRemote('https://git.alpha-labs.net/chris/codex-orchestrator');
    expect(ssh).toBe('git.alpha-labs.net/chris/codex-orchestrator');
    expect(https).toBe(ssh);
  });

  it('ignores userinfo, ports, trailing slashes, .git and host case', () => {
    const forms = [
      'https://user:token@Git.Example.COM:8443/org/repo.git/',
      'ssh://git@git.example.com/org/repo',
      'git@git.example.com:org/repo.git',
      'https://git.example.com/org/repo/',
    ];
    const normalized = forms.map(normalizeRemote);
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe('git.example.com/org/repo');
  });

  it('keeps genuinely different repositories apart', () => {
    expect(normalizeRemote('git@host:org/one.git')).not.toBe(normalizeRemote('git@host:org/two.git'));
    expect(normalizeRemote('git@a:org/repo.git')).not.toBe(normalizeRemote('git@b:org/repo.git'));
  });

  it('treats a blank or missing remote as no remote', () => {
    expect(normalizeRemote(null)).toBeNull();
    expect(normalizeRemote('   ')).toBeNull();
  });
});

describe('normalizePath', () => {
  it('collapses duplicate and trailing separators without eating the root', () => {
    expect(normalizePath('/home//chris/repo/')).toBe('/home/chris/repo');
    expect(normalizePath('/')).toBe('/');
  });
});

describe('overlappingPaths', () => {
  it('compares the checkout root in both directions and keeps literal filename characters', () => {
    expect(overlappingPaths(['.'], ['docs/manual'])).toEqual(['.']);
    expect(overlappingPaths(['docs/manual'], ['.'])).toEqual(['docs/manual']);
    expect(overlappingPaths(['*'], ['docs/manual'])).toEqual([]);
  });

  it('counts a directory prefix as an overlap in both directions', () => {
    // Two agents are in each other's way when one rewrites a directory the other
    // edits a file inside, even though no exact path repeats.
    expect(overlappingPaths(['api/src/services/mcp-tools.ts'], ['api/src/services'])).toEqual([
      'api/src/services/mcp-tools.ts',
    ]);
    expect(overlappingPaths(['api/src/services'], ['api/src/services/mcp-tools.ts'])).toEqual([
      'api/src/services',
    ]);
  });

  it('does not treat a shared name prefix as a shared directory', () => {
    // 'api/src/services-legacy' starts with 'api/src/services' as a string but is
    // a different directory; only a separator-terminated prefix counts.
    expect(overlappingPaths(['api/src/services-legacy/x.ts'], ['api/src/services'])).toEqual([]);
  });

  it('returns nothing for disjoint sets', () => {
    expect(overlappingPaths(['a/one.ts'], ['b/two.ts'])).toEqual([]);
  });
});

describe('resolveVerdict', () => {
  it('allows an uncontended request without consulting anything', () => {
    const out = resolveVerdict({ holderPresent: false, overlap: [], judged: null, judgeConsulted: false });
    expect(out).toEqual({
      verdict: 'allow',
      decidedBy: 'policy',
      reason: 'No lease is held on this branch and no declared paths overlap.',
    });
  });

  it('never lets a judge grant a second lease while another holder remains', () => {
    const judged = { verdict: 'allow' as const, reason: 'Both edits append to distinct blocks.' };
    const out = resolveVerdict({ holderPresent: true, overlap: ['a.ts'], judged, judgeConsulted: true });
    expect(out.decidedBy).toBe('policy');
    expect(out.verdict).toBe('wait');
    expect(out.reason).toContain('holds the lease');
  });

  it('falls back to a deterministic wait when no arbiter answered', () => {
    // The property that decides whether this feature survives an inference
    // outage: a missing judge must never turn into a missing answer.
    const out = resolveVerdict({
      holderPresent: true,
      overlap: ['api/a.ts', 'api/b.ts'],
      judged: null,
      judgeConsulted: true,
    });
    expect(out.verdict).toBe('wait');
    expect(out.decidedBy).toBe('policy');
    expect(out.reason).toContain('holds the lease');
    expect(out.reason).toContain('api/a.ts');
    expect(out.reason).toContain('no arbiter was reachable');
  });

  it('waits on pure path overlap even with no lease held', () => {
    const out = resolveVerdict({
      holderPresent: false,
      overlap: ['shared.ts'],
      judged: null,
      judgeConsulted: false,
    });
    expect(out.verdict).toBe('wait');
    expect(out.decidedBy).toBe('policy');
    // No judge was consulted, so the reason must not blame an unreachable one.
    expect(out.reason).not.toContain('no arbiter was reachable');
  });

  const peer = {
    worktree_id: 'w-b',
    worktree_path: '/srv/repo-b',
    username: 'chris',
    branch: 'feat/b',
    paths: ['CHANGELOG.md', 'docs/x.md'],
  };

  it('allows over peer declarations alone but names the peer and the paths', () => {
    // A declaration is a plan, not a hold on the branch: waiting on it would only
    // clear when the peer deregisters, and two peers who both declared
    // CHANGELOG.md would wait on each other forever.
    const out = resolveVerdict({
      holderPresent: false,
      overlap: [],
      peerOverlap: [peer],
      judged: null,
      judgeConsulted: false,
    });
    expect(out.verdict).toBe('allow');
    expect(out.decidedBy).toBe('policy');
    expect(out.reason).not.toContain('no declared paths overlap');
    expect(out.reason).toContain('/srv/repo-b');
    expect(out.reason).toContain('CHANGELOG.md');
    expect(out.reason).toContain('docs/x.md');
  });

  it('keeps the holder wait and adds the peer declarations to its reason', () => {
    const out = resolveVerdict({
      holderPresent: true,
      overlap: ['api/a.ts'],
      peerOverlap: [peer],
      judged: null,
      judgeConsulted: false,
    });
    expect(out.verdict).toBe('wait');
    expect(out.reason).toContain('holds the lease');
    expect(out.reason).toContain('/srv/repo-b');
  });

  it('appends the peer declarations to a judged reason without changing the verdict', () => {
    const judged = { verdict: 'allow' as const, reason: 'Distinct blocks.' };
    const out = resolveVerdict({
      holderPresent: false,
      overlap: ['api/a.ts'],
      peerOverlap: [peer],
      judged,
      judgeConsulted: true,
    });
    expect(out.verdict).toBe('allow');
    expect(out.decidedBy).toBe('llm');
    expect(out.reason.startsWith('Distinct blocks.')).toBe(true);
    expect(out.reason).toContain('/srv/repo-b');
  });
});

describe('peerDeclarationOverlap', () => {
  const peers = [
    {
      worktree_id: 'w-b',
      worktree_path: '/srv/repo-b',
      username: 'chris',
      branch: 'main',
      declared_paths: ['frontend/e2e', 'docs', 'CHANGELOG.md'],
    },
    {
      worktree_id: 'w-c',
      worktree_path: '/srv/repo-c',
      username: 'chris',
      branch: 'feat/c',
      declared_paths: ['doc', 'api/src/services'],
    },
  ];

  it('matches declared directories against changed files beneath them', () => {
    // The reported case: directory declarations, file-level changed paths.
    const out = peerDeclarationOverlap(
      ['frontend/e2e/admin-design.spec.ts', 'docs/web-design-verification.md', 'CHANGELOG.md', 'api/x.ts'],
      peers,
    );
    expect(out).toEqual([
      {
        worktree_id: 'w-b',
        worktree_path: '/srv/repo-b',
        username: 'chris',
        branch: 'main',
        paths: ['CHANGELOG.md', 'docs/web-design-verification.md', 'frontend/e2e/admin-design.spec.ts'],
      },
    ]);
  });

  it('is path-segment aware: a declared "doc" never claims "docs/x"', () => {
    expect(peerDeclarationOverlap(['docs/x.md', 'api/src/services-legacy/a.ts'], [peers[1]!])).toEqual([]);
  });

  it('drops peers that declared nothing', () => {
    expect(peerDeclarationOverlap(['a.ts'], [{ ...peers[0]!, declared_paths: [] }])).toEqual([]);
  });
});

describe('normalizeJudgeVerdict', () => {
  it('accepts a well-formed verdict and clamps the wait hint', () => {
    expect(
      normalizeJudgeVerdict({ verdict: 'wait', reason: 'Holder is mid-rebase.', wait_seconds: 99_999 }),
    ).toEqual({ verdict: 'wait', reason: 'Holder is mid-rebase.', wait_seconds: 3600 });
  });

  it('rejects anything outside the enum, so it becomes a fallback and not a retry', () => {
    // The structural answer to a prompt-injected task string talking the arbiter
    // into a novel verdict: an unrecognised answer is simply no answer.
    expect(normalizeJudgeVerdict({ verdict: 'always_allow' as never, reason: 'x' })).toBeNull();
    expect(normalizeJudgeVerdict({ verdict: 'allow', reason: '' })).toBeNull();
    expect(normalizeJudgeVerdict(null)).toBeNull();
  });

  it('drops a nonsensical wait hint rather than carrying it', () => {
    const out = normalizeJudgeVerdict({ verdict: 'wait', reason: 'r', wait_seconds: -5 });
    expect(out).toEqual({ verdict: 'wait', reason: 'r' });
  });
});

describe('parseJudgeReply', () => {
  it('reads the object out of a fenced or prose-wrapped reply', () => {
    expect(parseJudgeReply('```json\n{"verdict":"deny","reason":"r"}\n```')).toEqual({
      verdict: 'deny',
      reason: 'r',
    });
    expect(parseJudgeReply('Here you go: {"verdict":"allow","reason":"r"} — hope that helps')).toEqual({
      verdict: 'allow',
      reason: 'r',
    });
  });

  it('returns null on anything unparseable, which routes to the fallback', () => {
    expect(parseJudgeReply('I cannot decide this one.')).toBeNull();
    expect(parseJudgeReply('')).toBeNull();
    expect(parseJudgeReply('{ not json')).toBeNull();
  });
});

describe('summarizeCloneEntry', () => {
  const entry = {
    clone_id: 'c1',
    repo_root: '/srv/repo',
    fqdn: 'h.example',
    worktrees: Array.from({ length: 30 }, (_, i) => ({
      worktree_id: `w${i}`,
      worktree_path: `/srv/repo/wt-${i}`,
      username: 'chris',
      engine: 'claude',
      branch: 'main',
      head_sha: 'abc',
      head_observed_at: 't',
      task: 'x'.repeat(500),
      declared_paths: Array.from({ length: 200 }, (_, j) => `api/src/file-${j}.ts`),
      target_branch: 'main',
      agent_address_bound: true,
      heartbeat_at: 't',
      expires_at: 't',
    })),
    leases: [
      {
        request_id: 'r1',
        worktree_id: 'w0',
        target_branch: 'main',
        verdict: 'allow',
        decided_by: 'policy',
        reason: 'y'.repeat(2000),
        overlap: ['a', 'b'],
        lease_expires_at: 't',
        requested_at: 't',
      },
    ],
    stale: [{ worktree_id: 's1' }, { worktree_id: 's2' }],
  };

  it('keeps the clone identity and swaps the heavy lists for counts', () => {
    const out = summarizeCloneEntry(entry);
    expect(out).toMatchObject({
      clone_id: 'c1',
      repo_root: '/srv/repo',
      fqdn: 'h.example',
      worktree_count: 30,
      worktrees_truncated: true,
      lease_count: 1,
      stale_count: 2,
    });
    expect(out).not.toHaveProperty('stale');
    expect(out['leases']).toEqual([
      { request_id: 'r1', worktree_id: 'w0', target_branch: 'main', verdict: 'allow', lease_expires_at: 't' },
    ]);
  });

  it('caps worktrees, clips tasks and drops declared paths', () => {
    const out = summarizeCloneEntry(entry);
    const worktrees = out['worktrees'] as Array<Record<string, unknown>>;
    expect(worktrees).toHaveLength(25);
    expect(worktrees[0]).not.toHaveProperty('declared_paths');
    expect(String(worktrees[0]!['task']).length).toBeLessThanOrEqual(121);
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(entry).length / 10);
  });
});

describe('reportedShaProblem', () => {
  it('accepts full commit SHAs, including ones with short zero runs', () => {
    expect(reportedShaProblem('51eee0cd7f1c4d8fe88f0ad72e6245897ea92854')).toBeNull();
    expect(reportedShaProblem('0000000a' + 'b'.repeat(32))).toBeNull(); // seven leading zeros
    expect(reportedShaProblem('b'.repeat(33) + '0000000')).toBeNull(); // seven trailing zeros
    expect(reportedShaProblem('ab' + '0'.repeat(20) + 'cd'.repeat(9))).toBeNull(); // zeros inside
    expect(reportedShaProblem('c'.repeat(64))).toBeNull(); // SHA-256 object format
  });

  it('refuses a short hash padded with zeros and the null SHA', () => {
    // The reported case: an agent padded `git rev-parse --short` output to 40 characters.
    expect(reportedShaProblem('51eee0cd7' + '0'.repeat(31))).toMatch(/padded short hash/);
    expect(reportedShaProblem('0'.repeat(31) + '51eee0cd7')).toMatch(/padded short hash/);
    expect(reportedShaProblem('51eee0cd7f1c4d8f' + '0'.repeat(48))).toMatch(/padded short hash/);
    expect(reportedShaProblem('0'.repeat(40))).toMatch(/padded short hash/);
  });

  it('keeps the format rule for short, long and non-hex values', () => {
    for (const bad of ['51eee0cd7', 'a'.repeat(39), 'a'.repeat(65), 'A'.repeat(40), 'g'.repeat(40)]) {
      expect(reportedShaProblem(bad)).toMatch(/full 40-64 lowercase hex/);
    }
  });

  it('is enforced by git_release before any lease or report is touched', async () => {
    // The fake database throws on any use, so a refusal proves the check runs first.
    const db = new Proxy({}, { get: () => { throw new Error('database touched'); } });
    const director = new GitDirectorService({ db } as unknown as ConstructorParameters<typeof GitDirectorService>[0]);
    const host = { id: 1 } as Host;
    const report = { request_id: 'r1', worktree_path: '/srv/repo', outcome: 'merged' };
    await expect(director.release({ ...report, target_head_sha: 'abc1234' + '0'.repeat(33) }, host)).rejects.toThrow(/padded short hash/);
    await expect(
      director.release(
        { ...report, target_head_sha: '0'.repeat(40), correction_id: '6f1c2b8e-5d4a-4f3e-9a2b-1c0d9e8f7a6b', correction_reason: 'Fix the SHA' },
        host,
      ),
    ).rejects.toThrow(/padded short hash/);
  });
});
