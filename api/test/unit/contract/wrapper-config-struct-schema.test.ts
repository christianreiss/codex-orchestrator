import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * wrapper-config-schema.test.ts diffs the payload `wrapper-config.ts` bakes
 * against `wrappers/schemas/host-config-v1.json`, but the consumer half was
 * unguarded: both wrappers hand-mirror that schema in Go json tags, and a
 * renamed or misnested tag decodes to a zero value silently — the failure class
 * that already shipped once when the wrapper client structs decoded the wrong
 * keys.
 *
 * This reads the tags of `Config`/`Orchestrator`/`Host`/`EngineOptions`/
 * `Wrapper` out of the shared cxx config package and diffs each engine view against the schema
 * properties at its nesting path: a tag naming nothing the schema declares
 * fails, and a declared property nothing decodes fails unless ALLOWED names it.
 * The two structs decode different subsets on purpose, so the allowlist is per
 * wrapper rather than a byte-parity check between them.
 */

const SCHEMA = resolve(import.meta.dirname, '../../../../wrappers/schemas/host-config-v1.json');
const CXX_CONFIG = resolve(import.meta.dirname, '../../../../wrappers/cxx/internal/config/config.go');

/**
 * Schema properties a wrapper deliberately does not decode, keyed
 * `<wrapper> <schema path>` with the reason. Everything else the schema
 * declares must have a field, `required` or not.
 */
const ALLOWED: Record<string, string> = {
  'cdx documents': 'AGENTS.md/client-config digests are synced from /auth, not the baked config',
  'cdx skills': 'the skill set is synced from GET /skills, not the baked config',
  'cdx etag': 'the etag fingerprints the payload for the server; the wrapper never reads it back',
  'clx documents': 'AGENTS.md/client-config digests are synced from /auth, not the baked config',
  'clx skills': 'the skill set is synced from GET /skills, not the baked config',
  'clx etag': 'the etag fingerprints the payload for the server; the wrapper never reads it back',
};

/** Body of the brace-delimited block whose opening `{` is at `open`. */
const block = (source: string, open: number): string => {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && (depth -= 1) === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces at offset ${open}`);
};

const GO_TAG = /`[^`]*\bjson:"([^",]+)/g;

/** json tags of the fields of a Go struct, in declaration order. */
const goTags = (file: string, struct: string): string[] => {
  const source = readFileSync(file, 'utf8');
  const header = new RegExp(`\\btype ${struct} struct \\{`).exec(source);
  if (!header) throw new Error(`type ${struct} struct not found in ${file}`);
  const body = block(source, header.index + header[0].length - 1);
  return [...body.matchAll(GO_TAG)].map((tag) => tag[1]!);
};

interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  required?: string[];
}

const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as SchemaNode;

/** The object node the dotted `path` names, which must declare properties. */
const nodeAt = (path: string): SchemaNode => {
  let node = schema;
  for (const name of path ? path.split('.') : []) {
    const child = node.properties?.[name];
    if (!child) throw new Error(`host-config-v1.json declares no ${path}`);
    node = child;
  }
  if (!node.properties) throw new Error(`host-config-v1.json declares no properties at ${path || '(root)'}`);
  return node;
};

/** Each Go type and the schema path whose properties it decodes. */
const TYPES = [
  { type: 'Config', path: '' },
  { type: 'Orchestrator', path: 'orchestrator' },
  { type: 'Host', path: 'host' },
  { type: 'EngineOptions', path: 'engine_options' },
  { type: 'AgentMessaging', path: 'agent_messaging' },
  { type: 'Wrapper', path: 'wrapper' },
];

const WRAPPERS = [
  { wrapper: 'cdx', file: CXX_CONFIG },
  { wrapper: 'clx', file: CXX_CONFIG },
];

const at = (path: string, name: string): string => (path ? `${path}.${name}` : name);

interface StructDiff {
  /** Tags naming nothing the schema declares at that path, as `path.key`. */
  undeclared: string[];
  /** Declared properties no field decodes, as `path.key`. */
  undecoded: string[];
}

/** Diffs one wrapper's tags, looked up per Go type, against the schema. */
function diffAgainstSchema(wrapper: string, tagsFor: (type: string) => string[]): StructDiff {
  const diff: StructDiff = { undeclared: [], undecoded: [] };

  for (const { type, path } of TYPES) {
    const properties = Object.keys(nodeAt(path).properties!);
    const tags = tagsFor(type);
    for (const tag of tags) {
      if (!properties.includes(tag)) diff.undeclared.push(at(path, tag));
    }
    for (const name of properties) {
      if (tags.includes(name) || `${wrapper} ${at(path, name)}` in ALLOWED) continue;
      diff.undecoded.push(at(path, name));
    }
  }

  return diff;
}

describe('wrapper config structs against host-config-v1.json', () => {
  it('extracts the tags and schema properties it is meant to compare', () => {
    // A scan that read nothing would pass the comparisons below on both sides.
    expect(goTags(CXX_CONFIG, 'Host')).toContain('browseros_mcp_enabled');
    expect(goTags(CXX_CONFIG, 'Host')).toContain('agent_messaging_enabled');
    expect(goTags(CXX_CONFIG, 'EngineOptions')).toContain('reasoning_effort_override');
    expect(goTags(CXX_CONFIG, 'EngineOptions')).toContain('claude_model_override');
    for (const { wrapper, file } of WRAPPERS) {
      for (const { type } of TYPES) {
        expect(goTags(file, type).length, `${wrapper} ${type}`).toBeGreaterThan(2);
      }
    }
    expect(Object.keys(nodeAt('').properties!)).toContain('etag');
    expect(nodeAt('wrapper').required).toContain('binary_sha256');
  });

  for (const { wrapper, file } of WRAPPERS) {
    it(`${wrapper} decodes exactly the keys the schema declares`, () => {
      const diff = diffAgainstSchema(wrapper, (type) => goTags(file, type));
      expect(diff.undeclared, `rename the ${wrapper} json tag to a key the schema declares`).toEqual(
        [],
      );
      expect(
        diff.undecoded,
        `give ${wrapper} a field for the key, or allowlist it with a reason`,
      ).toEqual([]);
    });
  }

  it('reports the offending path.key for a renamed tag and a dropped field', () => {
    const tags = new Map(TYPES.map(({ type }) => [type, goTags(CXX_CONFIG, type)]));
    tags.set('Host', [...tags.get('Host')!.filter((tag) => tag !== 'fqdn'), 'peers']);

    const diff = diffAgainstSchema('cdx', (type) => tags.get(type)!);
    expect(diff.undeclared).toEqual(['host.peers']);
    expect(diff.undecoded).toEqual(['host.fqdn']);
  });

  it('keeps the allowlist to omissions that still exist', () => {
    const stale = Object.keys(ALLOWED).filter((entry) => {
      const [wrapper, key] = entry.split(' ');
      const file = WRAPPERS.find((w) => w.wrapper === wrapper)?.file;
      if (!file || !key) return true;
      const dot = key.lastIndexOf('.');
      const path = dot === -1 ? '' : key.slice(0, dot);
      const name = dot === -1 ? key : key.slice(dot + 1);
      const type = TYPES.find((t) => t.path === path)?.type;
      if (!type) return true;
      return !(name in nodeAt(path).properties!) || goTags(file, type).includes(name);
    });
    expect(
      stale,
      'drop the allowlist entry: the key is gone from the schema or the wrapper decodes it now',
    ).toEqual([]);
  });
});
