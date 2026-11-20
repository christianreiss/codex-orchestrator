/**
 * Host memory (`memory_store`), project memory (`project_memory_upsert`) and
 * the admin console writing either scope validate one memory the same way
 * (memory-validation.ts). Until 2026-11-20 they were three copies that
 * disagreed (API-KNOW-07). Each case runs through every surface's own entry
 * code and compares the verdict: the normalized values, or the first failing
 * field and its message. Only the envelope differs (MCP `extra.errors` by
 * field, admin `param`), and the key is named `id` on host and admin but
 * `key` on project memory.
 */
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../../src/http/errors.js';
import {
  normalizeContent,
  normalizeMemoryKey,
  normalizeMetadata,
  normalizeTags,
} from '../../../src/services/admin-memory-model.js';
import { HostProjectsService } from '../../../src/services/host-projects.js';
import { McpMemoriesService } from '../../../src/services/mcp-memories.js';
import { MEMORY_MAX_CONTENT } from '../../../src/services/memory-validation.js';

interface Input {
  key: unknown;
  content: unknown;
  tags?: unknown;
  metadata?: unknown;
}
type Verdict =
  | { ok: true; key: string; content: string; tags: string[]; metadata: Record<string, unknown> | null }
  | { ok: false; field: string; message: string };

/** Project and host disagree on the key's name only; compare it as `<key>`. */
function failed(field: string, message: string): Verdict {
  const key = field === 'id' || field === 'key';
  return { ok: false, field: key ? '<key>' : field, message: key ? message.replace(/^(id|key)\b/, '<key>') : message };
}

const FIELDS = ['id', 'content', 'metadata', 'tags'] as const;

function hostMemory(input: Input): Verdict {
  const service = new McpMemoriesService({} as never);
  const errors: Record<string, string[]> = {};
  const key = service.normalizeKey(input.key, false, errors);
  const content = service.normalizeContent(input.content, errors);
  const metadata = service.normalizeMetadata(input.metadata, errors);
  const tags = service.normalizeTags(input.tags, errors);
  const field = FIELDS.find((name) => errors[name]?.length);
  return field ? failed(field, errors[field]![0]!) : { ok: true, key: key!, content, tags, metadata };
}

function projectMemory(input: Input): Verdict {
  const service = new HostProjectsService({} as never);
  try {
    return { ok: true, ...service.normalizeMemoryPayload({ ...input }) };
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    const [field, messages] = Object.entries((error.extra as { errors: Record<string, string[]> }).errors)[0]!;
    return failed(field, messages[0]!);
  }
}

function adminMemory(scope: 'host' | 'project') {
  return (input: Input): Verdict => {
    try {
      return {
        ok: true,
        key: normalizeMemoryKey(input.key, scope),
        content: normalizeContent(input.content, MEMORY_MAX_CONTENT),
        metadata: normalizeMetadata(input.metadata),
        tags: normalizeTags(input.tags, scope),
      };
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return failed(error.param ?? '', error.message);
    }
  };
}

const longTag = 't'.repeat(65);
const CASES: Array<[name: string, input: Input, expected: Verdict]> = [
  ['a trimmed key, content and tag set', { key: '  deploy.crane  ', content: '  body  ', tags: ['  Ops ', 'ops', '', 'deploy'], metadata: { b: 1 } },
    { ok: true, key: 'deploy.crane', content: 'body', tags: ['Ops', 'deploy'], metadata: { b: 1 } }],
  ['a missing key', { key: '   ', content: 'body' }, failed('id', 'id is required')],
  ['a numeric key', { key: 42, content: 'body' }, failed('id', 'id must be a string')],
  ['an overlong key', { key: 'k'.repeat(129), content: 'body' }, failed('id', 'id must be 128 characters or fewer')],
  ['a key outside the charset', { key: 'deploy crane', content: 'body' },
    failed('id', 'id may only contain letters, numbers, dots, underscores, hyphens, and colons')],
  ['missing content', { key: 'k', content: '   ' }, failed('content', 'content is required')],
  ['numeric content', { key: 'k', content: 5 }, failed('content', 'content must be a string')],
  ['overlong content', { key: 'k', content: 'c'.repeat(MEMORY_MAX_CONTENT + 1) },
    failed('content', `content must be ${MEMORY_MAX_CONTENT} characters or fewer`)],
  ['array metadata', { key: 'k', content: 'body', metadata: [] }, failed('metadata', 'metadata must be an object')],
  ['a comma-separated tag string', { key: 'k', content: 'body', tags: 'ops, deploy' },
    failed('tags', 'tags must be an array of strings')],
  ['a non-string tag', { key: 'k', content: 'body', tags: ['ops', 7] }, failed('tags', 'tags must be strings')],
  ['too many tags, one of them too long', { key: 'k', content: 'body', tags: [longTag, ...Array.from({ length: 33 }, (_, i) => `t${i}`)] },
    failed('tags', `tag "${longTag}" is longer than 64 characters`)],
];

describe('memory validation parity', () => {
  describe.each([
    ['memory_store (host)', hostMemory],
    ['project_memory_upsert', projectMemory],
    ['admin console, host scope', adminMemory('host')],
    ['admin console, project scope', adminMemory('project')],
  ] as const)('%s', (_surface, validate) => {
    it.each(CASES)('decides %s like every other memory store', (_name, input, expected) => {
      expect(validate(input)).toEqual(expected);
    });
  });

  // The one deliberate difference is by scope: host memory refuses coco keys
  // to steer agents to project memory, which is where those keys belong.
  it('reserves coco keys in host scope only', () => {
    const coco = { key: 'coco.plan', content: 'body' };
    for (const verdict of [hostMemory(coco), adminMemory('host')(coco)]) {
      expect(verdict).toMatchObject({ ok: false, field: '<key>', message: expect.stringContaining('reserved for CoCo') });
    }
    for (const verdict of [projectMemory(coco), adminMemory('project')(coco)]) {
      expect(verdict).toMatchObject({ ok: true, key: 'coco.plan' });
    }
  });
});
