import { describe, expect, it } from 'vitest';
import {
  allowsImplicitSkillInvocation,
  compareUtf8Bytewise,
  computeSkillBundleDigest,
  effectiveSkillDigest,
  inspectStoredSkillBundle,
  isSourceOwnedSkill,
} from '../../../src/services/skill-provenance.js';
import { createHash } from 'node:crypto';

describe('skill provenance helpers', () => {
  it('uses non-blank source_type as the ownership marker', () => {
    expect(isSourceOwnedSkill({ sourceType: 'github' })).toBe(true);
    expect(isSourceOwnedSkill({ sourceType: '  ' })).toBe(false);
    expect(isSourceOwnedSkill({ sourceRepository: 'mattpocock/skills' })).toBe(false);
  });

  it('prefers a valid bundle digest and falls back from malformed values', () => {
    const manifestSha = 'a'.repeat(64);
    const bundleSha = 'B'.repeat(64);
    expect(effectiveSkillDigest({ bundleSha256: bundleSha }, manifestSha)).toBe(bundleSha.toLowerCase());
    expect(effectiveSkillDigest({ bundleSha256: 'not-a-digest' }, manifestSha)).toBe(manifestSha);
    expect(effectiveSkillDigest({}, manifestSha)).toBe(manifestSha);
  });

  it('only disables implicit invocation for a true top-level frontmatter flag', () => {
    expect(allowsImplicitSkillInvocation('Body only')).toBe(true);
    expect(allowsImplicitSkillInvocation('---\ndisable-model-invocation: false\n---\nBody')).toBe(true);
    expect(allowsImplicitSkillInvocation('---\ndisable-model-invocation: true\n---\nBody')).toBe(false);
    expect(allowsImplicitSkillInvocation('---\ndisable-model-invocation: "TRUE"\n---\nBody')).toBe(false);
    expect(allowsImplicitSkillInvocation('Body\n\ndisable-model-invocation: true')).toBe(true);
  });

  it('verifies every stored file and the canonical complete-bundle digest', () => {
    const manifest = '---\nname: test\n---\nBody';
    const content = '# Guide';
    const manifestSha = createHash('sha256').update(manifest).digest('hex');
    const fileSha = createHash('sha256').update(content).digest('hex');
    const bundleSha = computeSkillBundleDigest([
      { path: 'SKILL.md', sha256: manifestSha },
      { path: 'guide.md', sha256: fileSha },
    ]);
    const row = { manifest, sha256: manifestSha, bundleSha256: bundleSha };
    const files = [{ path: 'guide.md', sha256: fileSha, content }];

    expect(inspectStoredSkillBundle(row, files)).toMatchObject({ valid: true, bundleSha256: bundleSha });
    expect(inspectStoredSkillBundle(row, [{ ...files[0]!, content: 'tampered' }])).toMatchObject({
      valid: false,
      reason: 'file sha256 mismatch: guide.md',
    });
  });

  it('orders non-ASCII bundle paths by raw UTF-8 bytes like the Go wrapper', () => {
    const files = [
      { path: 'ä.md', sha256: 'b'.repeat(64) },
      { path: 'z.md', sha256: 'a'.repeat(64) },
    ];
    expect(files.map((file) => file.path).sort(compareUtf8Bytewise)).toEqual(['z.md', 'ä.md']);

    const expected = createHash('sha256')
      .update(`z.md\0${'a'.repeat(64)}\n`)
      .update(`ä.md\0${'b'.repeat(64)}\n`)
      .digest('hex');
    expect(computeSkillBundleDigest(files)).toBe(expected);
  });
});
