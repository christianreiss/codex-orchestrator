import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  serializeFrontmatter,
  parseFrontmatter,
  validateForKind,
  normalizeKind,
  normalizeSlug,
  KIND_DIRS,
} from '../../../src/services/claude-frontmatter.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('claude-frontmatter serialize/parse', () => {
  it('serializes scalars + list fields in a stable order', () => {
    const body = serializeFrontmatter(
      { description: 'Reviews code', name: 'reviewer', model: 'sonnet', tools: ['Read', 'Grep'] },
      'You are a reviewer.',
    );
    expect(body).toBe(
      ['---', 'name: reviewer', 'description: Reviews code', 'tools:', '  - Read', '  - Grep', 'model: sonnet', '---', '', 'You are a reviewer.', ''].join(
        '\n',
      ),
    );
  });

  it('is sha-stable regardless of input key order', () => {
    const a = serializeFrontmatter({ name: 'x', description: 'd', model: 'opus' }, 'body');
    const b = serializeFrontmatter({ model: 'opus', description: 'd', name: 'x' }, 'body');
    expect(sha(a)).toBe(sha(b));
  });

  it('round-trips: serialize(parse(body)) === body (idempotent)', () => {
    const body = serializeFrontmatter(
      { name: 'deploy', description: 'Deploys', 'allowed-tools': ['Bash'] },
      'Run the deploy.\n\nWith details.',
    );
    const parsed = parseFrontmatter(body);
    expect(parsed.frontmatter['name']).toBe('deploy');
    expect(parsed.frontmatter['allowed-tools']).toEqual(['Bash']);
    expect(serializeFrontmatter(parsed.frontmatter, parsed.content)).toBe(body);
  });

  it('quotes values that could be misread as YAML structure', () => {
    const body = serializeFrontmatter({ name: 'x', description: 'a: b #c' }, 'z');
    expect(body).toContain('description: "a: b #c"');
    expect(parseFrontmatter(body).frontmatter['description']).toBe('a: b #c');
  });

  it('parses inline lists and comma values, preserves unknown keys', () => {
    const body = '---\nname: t\ndescription: d\ntools: [Read, Write]\ncolor: blue\n---\nhi\n';
    const { frontmatter, content } = parseFrontmatter(body);
    expect(frontmatter['tools']).toEqual(['Read', 'Write']);
    expect(frontmatter['color']).toBe('blue');
    expect(content.trim()).toBe('hi');
  });

  it('returns empty frontmatter when no block is present', () => {
    const { frontmatter, content } = parseFrontmatter('just a body\n');
    expect(frontmatter).toEqual({});
    expect(content).toBe('just a body\n');
  });
});

describe('claude-frontmatter validation + helpers', () => {
  it('requires name+description for subagents', () => {
    expect(() => validateForKind('subagent', { name: 'x' })).toThrow();
    expect(() => validateForKind('subagent', { name: 'x', description: 'd' })).not.toThrow();
  });

  it('requires description for commands, nothing for output-styles', () => {
    expect(() => validateForKind('command', {})).toThrow();
    expect(() => validateForKind('command', { description: 'd' })).not.toThrow();
    expect(() => validateForKind('output-style', {})).not.toThrow();
  });

  it('normalizeKind accepts spelling variants and rejects junk', () => {
    expect(normalizeKind('subagents')).toBe('subagent');
    expect(normalizeKind('agents')).toBe('subagent');
    expect(normalizeKind('commands')).toBe('command');
    expect(normalizeKind('output_styles')).toBe('output-style');
    expect(() => normalizeKind('plugins')).toThrow();
  });

  it('maps kinds to ~/.claude dirs', () => {
    expect(KIND_DIRS.subagent).toBe('agents');
    expect(KIND_DIRS.command).toBe('commands');
    expect(KIND_DIRS['output-style']).toBe('output-styles');
  });

  it('normalizeSlug rejects path traversal', () => {
    expect(() => normalizeSlug('../etc/passwd')).toThrow();
    expect(() => normalizeSlug('a/b')).toThrow();
    expect(() => normalizeSlug('')).toThrow();
    expect(normalizeSlug('code-reviewer')).toBe('code-reviewer');
  });
});
