import { createHash } from 'node:crypto';
import { vi } from 'vitest';

export const REVISION = 'a'.repeat(40);
export const NOW = new Date('2026-07-29T12:00:00.000Z');
export const API = 'https://api.github.com/repos/mattpocock/skills';
const RAW = `https://raw.githubusercontent.com/mattpocock/skills/${REVISION}`;

interface FixtureOptions {
  pluginSkills?: unknown[];
  truncated?: boolean;
  treeMutator?: (tree: TreeEntry[]) => void;
  rawMutator?: (files: Map<string, string>) => void;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

export interface FetchFixture {
  fetch: typeof globalThis.fetch;
  calls: string[];
}

function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content);
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

export function blob(path: string, content: string, mode = '100644'): TreeEntry {
  return { path, mode, type: 'blob', sha: gitBlobSha(content), size: Buffer.byteLength(content) };
}

export function tree(path: string): TreeEntry {
  return { path, mode: '040000', type: 'tree', sha: 'b'.repeat(40) };
}

function jsonResponse(value: unknown): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
  });
}

function textResponse(value: string): Response {
  return new Response(value, {
    status: 200,
    headers: { 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength(value)) },
  });
}

export function fixture(options: FixtureOptions = {}): FetchFixture {
  const tdd = [
    '---',
    'name: tdd',
    'description: "Test-driven development: red, green, refactor."',
    '---',
    '',
    '# TDD',
    '',
    'Read [tests](tests.md).',
    '',
  ].join('\n');
  const grill = [
    '---',
    'name: grill-me',
    "description: 'Interview the user until the plan is clear.'",
    'disable-model-invocation: true',
    '---',
    '',
    '# Grill me',
    '',
  ].join('\n');
  const openai = [
    'interface:',
    '  display_name: "TDD"',
    '  short_description: "Red-green development"',
    '',
  ].join('\n');
  const tests = '# Tests\n\nTest behavior, not implementation.\n';
  const excluded = '---\nname: private-note\ndescription: Never publish this.\n---\n';
  const license = 'MIT License\n\nCopyright (c) 2026 Matt Pocock\n\nPermission is hereby granted.\n';
  const plugin = JSON.stringify({
    name: 'mattpocock-skills',
    version: '1.2.0',
    skills: options.pluginSkills ?? ['./skills/engineering/tdd', './skills/productivity/grill-me'],
  });

  const raw = new Map<string, string>([
    ['.claude-plugin/plugin.json', plugin],
    ['LICENSE', license],
    ['skills/engineering/tdd/SKILL.md', tdd],
    ['skills/engineering/tdd/agents/openai.yaml', openai],
    ['skills/engineering/tdd/tests.md', tests],
    ['skills/productivity/grill-me/SKILL.md', grill],
    ['skills/personal/private-note/SKILL.md', excluded],
  ]);
  options.rawMutator?.(raw);
  const entries: TreeEntry[] = [
    blob('.claude-plugin/plugin.json', raw.get('.claude-plugin/plugin.json')!),
    blob('LICENSE', raw.get('LICENSE')!),
    tree('skills/engineering/tdd'),
    blob('skills/engineering/tdd/SKILL.md', raw.get('skills/engineering/tdd/SKILL.md')!),
    tree('skills/engineering/tdd/agents'),
    blob('skills/engineering/tdd/agents/openai.yaml', raw.get('skills/engineering/tdd/agents/openai.yaml')!),
    blob('skills/engineering/tdd/tests.md', raw.get('skills/engineering/tdd/tests.md')!),
    tree('skills/productivity/grill-me'),
    blob('skills/productivity/grill-me/SKILL.md', raw.get('skills/productivity/grill-me/SKILL.md')!),
    tree('skills/personal/private-note'),
    blob('skills/personal/private-note/SKILL.md', raw.get('skills/personal/private-note/SKILL.md')!),
  ];
  options.treeMutator?.(entries);

  const calls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url === `${API}/commits/main`) return jsonResponse({ sha: REVISION });
    if (url === `${API}/git/trees/${REVISION}?recursive=1`) {
      return jsonResponse({ truncated: options.truncated ?? false, tree: entries });
    }
    if (url.startsWith(`${RAW}/`)) {
      const path = url.slice(`${RAW}/`.length).split('/').map(decodeURIComponent).join('/');
      const content = raw.get(path);
      if (content !== undefined) return textResponse(content);
    }
    return new Response('missing', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}
