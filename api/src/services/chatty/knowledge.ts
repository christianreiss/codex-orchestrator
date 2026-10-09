import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { chunkContent } from '../shared-memory-chunker.js';
import { McpToolsRegistry } from '../mcp-tools.js';
import { administrationTools } from './tools.js';
import { signature } from './contracts.js';

export interface KnowledgeSource {
  id: string;
  title: string;
  heading: string;
  body: string;
  path: string;
  sha256: string;
}
export interface KnowledgeBundle {
  version: string;
  sources: KnowledgeSource[];
}
const DOCS = /^(interface-.+|OVERVIEW|API|ADMIN|auth-runner|chatty|wrapper-v2-architecture)\.md$/;

export function buildKnowledge(repo: string): KnowledgeBundle {
  const files: string[] = [];
  for (const dir of ['docs', 'public/admin/manual/articles']) {
    const full = resolve(repo, dir);
    if (!existsSync(full)) continue;
    for (const name of readdirSync(full).sort())
      if (name.endsWith('.md') && (dir !== 'docs' || DOCS.test(name))) files.push(`${dir}/${name}`);
  }
  const sources: KnowledgeSource[] = [];
  for (const path of files) {
    const body = readFileSync(resolve(repo, path), 'utf8');
    const sha256 = signature(body);
    const title = /^#\s+(.+)$/m.exec(body)?.[1] ?? /^title:\s*(.+)$/m.exec(body)?.[1] ?? basename(path);
    for (const chunk of chunkContent(body))
      sources.push({
        id: `${signature(path).slice(0, 16)}-${chunk.ordinal}`,
        title,
        heading: chunk.heading ?? title,
        body: chunk.content,
        path,
        sha256,
      });
  }
  // Registry construction describes handlers but does not invoke them.
  const metadataOnly = new Proxy(
    {},
    {
      get: () => {
        throw new Error('Knowledge builds may not invoke product services');
      },
    },
  );
  const registry = new McpToolsRegistry(
    Object.fromEntries(
      [
        'memories',
        'projects',
        'skills',
        'sharedMemories',
        'resources',
        'secrets',
        'board',
        'gitDirector',
        'transfers',
        'schedules',
        'taskMessaging',
      ].map((k) => [k, metadataOnly]),
    ) as never,
  );
  const descriptors = [
    ...registry
      .list('operator')
      .map((t) => ({ path: `mcp://tools/${t.name}`, title: `MCP ${t.name}`, body: JSON.stringify(t) })),
    ...administrationTools().map((t) => ({
      path: `chatty://tools/${t.name}`,
      title: `Chatty ${t.name}`,
      body: JSON.stringify({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        confirmation: t.confirm,
      }),
    })),
  ];
  for (const item of descriptors)
    for (const chunk of chunkContent(item.body))
      sources.push({
        id: `${signature(item.path).slice(0, 16)}-${chunk.ordinal}`,
        title: item.title,
        heading: item.title,
        body: chunk.content,
        path: item.path,
        sha256: signature(item.body),
      });
  return { version: signature(sources), sources };
}

let cachedBundle: KnowledgeBundle | undefined;
const ALIASES: Record<string, string[]> = {
  migrationen: ['migration', 'schema'],
  idempotente: ['idempotent'],
  passkeys: ['passkey'],
  zugang: ['auth', 'account', 'credential'],
  zugänge: ['accounts', 'auth'],
  konto: ['account'],
  kontingent: ['quota', 'usage'],
  konten: ['accounts'],
  schlüssel: ['keys', 'secret'],
  benutzer: ['user', 'role'],
  rechte: ['capability', 'authorization'],
  berechtigungen: ['capability', 'authorization'],
  zeitplan: ['schedule'],
  zeitpläne: ['schedules'],
  dokumentation: ['manual', 'interface'],
  erinnerung: ['memory'],
  projekt: ['project'],
  aufgaben: ['todo', 'board'],
  ausführen: ['execution'],
  sicherheit: ['security'],
  gesperrt: ['disabled', 'suspended'],
  modelle: ['models'],
  einstellungen: ['settings', 'config'],
  standard: ['default'],
  anmeldung: ['login', 'auth'],
};
const STOPWORDS = new Set(
  'the a an of in on to for is are does do how what when where why and or with this that it its ich wir wie was ist sind der die das den dem ein eine einen und oder mit bei von zu im kann man funktioniert funktionieren macht finde nutze works work happens'.split(
    ' ',
  ),
);
const searchIndexes = new WeakMap<
  KnowledgeBundle,
  Array<{ source: KnowledgeSource; body: string; title: string }>
>();
export function searchKnowledge(bundle: KnowledgeBundle, query: string, limit = 8) {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_./-]{2,}/gu) ?? [])].filter(
    (w) => !STOPWORDS.has(w),
  );
  const terms = [...new Set(words.flatMap((w) => [w, ...(ALIASES[w] ?? [])]))];
  if (!terms.length) return [];
  let index = searchIndexes.get(bundle);
  if (!index) {
    index = bundle.sources.map((source) => ({
      source,
      title: `${source.title} ${source.heading}`.toLowerCase(),
      body: source.body.toLowerCase(),
    }));
    searchIndexes.set(bundle, index);
  }
  const weights = new Map(
    terms.map((term) => [
      term,
      Math.log(
        1 +
          index!.length / (1 + index!.filter((s) => s.body.includes(term) || s.title.includes(term)).length),
      ),
    ]),
  );
  return index
    .map(({ source, title, body }) => {
      const score = terms.reduce(
        (sum, term) =>
          sum +
          weights.get(term)! * ((title.includes(term) ? 3 : 0) + Math.min(3, body.split(term).length - 1)),
        0,
      );
      return { ...source, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export function loadKnowledge(): KnowledgeBundle {
  if (cachedBundle) return cachedBundle;
  // Bundled server.js is beside the private knowledge artifact. Development
  // executes under api/; never depend on a checkout in the production image.
  const candidates = [
    resolve(import.meta.dirname, 'chatty-knowledge.json'),
    resolve(process.cwd(), 'dist/chatty-knowledge.json'),
  ];
  for (const path of candidates)
    if (existsSync(path)) return (cachedBundle = JSON.parse(readFileSync(path, 'utf8')) as KnowledgeBundle);
  return (cachedBundle = buildKnowledge(resolve(import.meta.dirname, '../../../..')));
}

export function sourceView(source: KnowledgeSource) {
  return { ...source, href: `/admin/chatty/sources/${source.id}` };
}
