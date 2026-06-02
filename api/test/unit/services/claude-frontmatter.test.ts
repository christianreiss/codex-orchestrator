import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import {
  serializeFrontmatter,
  parseFrontmatter,
  validateForKind,
  normalizeKind,
  normalizeSlug,
  KIND_DIRS,
} from '../../../src/services/claude-frontmatter.js';

/** Extract the YAML frontmatter block (between the --- fences) from a .md body. */
function frontmatterBlock(md: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (!m || m[1] === undefined) throw new Error('no frontmatter block');
  return m[1];
}

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

  // The serializer is hand-rolled YAML-lite; these tests are otherwise
  // self-referential (our parser reads our serializer). This cross-checks the
  // output against a REAL YAML parser (js-yaml) — what Claude Code uses — so a
  // serializer bug that produces something only we accept is caught. Wrong
  // frontmatter makes Claude Code silently ignore the file.
  it('produces frontmatter a real YAML parser reads identically (subagent)', () => {
    const md = serializeFrontmatter(
      { name: 'reviewer', description: 'Reviews code: be strict, flag bugs', tools: ['Read', 'Grep', 'Bash'], model: 'claude-sonnet-4-6', color: 'blue' },
      'You are a reviewer.',
    );
    const parsed = yaml.load(frontmatterBlock(md)) as Record<string, unknown>;
    expect(parsed).toEqual({
      name: 'reviewer',
      description: 'Reviews code: be strict, flag bugs', // colon survived quoting
      tools: ['Read', 'Grep', 'Bash'], // block list -> array
      model: 'claude-sonnet-4-6',
      color: 'blue',
    });
  });

  it('produces frontmatter a real YAML parser reads identically (command)', () => {
    const md = serializeFrontmatter(
      { description: 'Deploy the app', 'argument-hint': '<env>', 'allowed-tools': ['Bash', 'Read'] },
      'Deploy to $1.',
    );
    const parsed = yaml.load(frontmatterBlock(md)) as Record<string, unknown>;
    expect(parsed['argument-hint']).toBe('<env>'); // angle brackets survived quoting
    expect(parsed['allowed-tools']).toEqual(['Bash', 'Read']);
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
