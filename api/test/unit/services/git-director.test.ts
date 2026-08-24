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
  normalizeJudgeVerdict,
  normalizePath,
  normalizeRemote,
  overlappingPaths,
  resolveVerdict,
} from '../../../src/services/git-director.js';
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

  it('takes the judge only when there is a real contention', () => {
    const judged = { verdict: 'allow' as const, reason: 'Both edits append to distinct blocks.' };
    const out = resolveVerdict({ holderPresent: true, overlap: ['a.ts'], judged, judgeConsulted: true });
    expect(out.decidedBy).toBe('llm');
    expect(out.verdict).toBe('allow');
    expect(out.reason).toBe(judged.reason);
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
