/**
 * MCP resource URI routing.
 *
 * Supports the following URI families:
 *   - `memory://<key>`                          — host-scoped MCP memory
 *   - `shared://<slug>`                         — fleet-wide shared memory document
 *   - `project://<slug>`                        — shared project bootstrap payload
 *   - `project://<slug>/files/<stored_name>`    — single project file (raw content)
 *   - `project://<slug>/memory/<key>`           — single project-scoped memory
 *   - `skill://<slug>`                          — skill manifest
 */
import type { Host } from '../db/schema.js';
import type { McpMemoriesService } from './mcp-memories.js';
import type { SharedMemoriesService } from './shared-memories.js';
import type { HostProjectsService } from './host-projects.js';
import type { HostSkillsService } from './host-skills.js';

export interface ResourceDeps {
  memories: McpMemoriesService;
  /** Optional; when absent the `shared://` scheme is not advertised or readable. */
  sharedMemories?: SharedMemoriesService;
  projects: HostProjectsService;
  skills: HostSkillsService;
}

export interface ResourceDescriptor {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceContent {
  uri: string;
  name?: string;
  mimeType?: string;
  text?: string;
  json?: unknown;
}

export interface ResourceReadResponse {
  contents: Array<ResourceContent>;
}

const URI_RE = /^([a-z]+):\/\/(.+)$/;
const FILES_INFIX = '/files/';
const MEMORY_INFIX = '/memory/';
const PROJECT_FILES_LIST_CAP = 50;
const PROJECT_MEMORIES_LIST_CAP = 50;
const SHARED_MEMORIES_LIST_CAP = 50;

interface ProjectFileSubResource {
  storedName: string;
}

interface ProjectMemorySubResource {
  key: string;
}

interface ParsedUri {
  scheme: string;
  id: string;
  subPath: string | null;
  projectFile: ProjectFileSubResource | null;
  projectMemory: ProjectMemorySubResource | null;
}

function parseUri(uri: string): ParsedUri {
  const m = URI_RE.exec(uri);
  if (!m || !m[1] || !m[2]) throw new Error('Invalid resource URI: ' + uri);
  const scheme = m[1];
  const rest = m[2];
  // Slug must not contain a slash; treat any leading slash-delimited token as
  // the resource id and the remainder as the sub-path.
  const slashIdx = rest.indexOf('/');
  if (slashIdx === -1) {
    return {
      scheme,
      id: decodeURIComponent(rest),
      subPath: null,
      projectFile: null,
      projectMemory: null,
    };
  }
  const id = decodeURIComponent(rest.slice(0, slashIdx));
  const subPath = rest.slice(slashIdx); // includes the leading '/'
  let projectFile: ProjectFileSubResource | null = null;
  let projectMemory: ProjectMemorySubResource | null = null;
  if (scheme === 'project' && subPath.startsWith(FILES_INFIX)) {
    const storedNameRaw = subPath.slice(FILES_INFIX.length);
    if (storedNameRaw.length > 0) {
      projectFile = { storedName: decodeURIComponent(storedNameRaw) };
    }
  } else if (scheme === 'project' && subPath.startsWith(MEMORY_INFIX)) {
    // Memory keys cannot contain '/' (see MEMORY_KEY_RE in host-projects.ts), so
    // unlike stored_name the remainder is a single decodable segment.
    const keyRaw = subPath.slice(MEMORY_INFIX.length);
    if (keyRaw.length > 0) {
      projectMemory = { key: decodeURIComponent(keyRaw) };
    }
  }
  return { scheme, id, subPath, projectFile, projectMemory };
}

function isBinaryMime(mime: string | null | undefined): boolean {
  if (!mime) return false;
  const lower = mime.toLowerCase();
  if (lower.startsWith('text/')) return false;
  if (lower === 'application/json') return false;
  if (lower === 'application/xml') return false;
  if (lower === 'application/javascript') return false;
  if (lower.endsWith('+json') || lower.endsWith('+xml')) return false;
  return true;
}

function buildProjectFileUri(slug: string, storedName: string): string {
  const segments = storedName.split('/').map((s) => encodeURIComponent(s));
  return `project://${encodeURIComponent(slug)}/files/${segments.join('/')}`;
}

/**
 * `shared://` addresses whole documents and has no sub-resources, so a URI with
 * a path after the slug is a caller error. Without this it silently resolved to
 * the parent document — meaning `resources/delete shared://runbook/section`
 * deleted the entire runbook.
 */
function assertNoSharedSubPath(parsed: ParsedUri, uri: string): void {
  if (parsed.subPath !== null && parsed.subPath !== '' && parsed.subPath !== '/') {
    throw new Error(`shared:// addresses a whole document and has no sub-resources: ${uri}`);
  }
}

/**
 * `shared_memory_search` advertises `shared://{slug}#{ordinal}` so a hit points
 * at its passage. Feeding that URI straight back in must resolve the document,
 * not look for a slug with a `#2` on the end.
 */
function stripFragment(id: string): string {
  const hash = id.indexOf('#');
  return hash === -1 ? id : id.slice(0, hash);
}

function buildProjectMemoryUri(slug: string, key: string): string {
  return `project://${encodeURIComponent(slug)}/memory/${encodeURIComponent(key)}`;
}

export class McpResourcesService {
  constructor(private readonly deps: ResourceDeps) {}

  listTemplates(): Array<Record<string, unknown>> {
    const templates: Array<Record<string, unknown>> = [
      { uriTemplate: 'memory://{key}', name: 'memory', description: 'Host-scoped MCP memory by key', mimeType: 'application/json' },
      { uriTemplate: 'project://{slug}', name: 'project', description: 'Shared project (bootstrap payload)', mimeType: 'application/json' },
      {
        uriTemplate: 'project://{slug}/files/{stored_name}',
        name: 'project_file',
        description: 'Single project file (raw content)',
        mimeType: 'text/plain',
      },
      {
        uriTemplate: 'project://{slug}/memory/{key}',
        name: 'project_memory',
        description: 'Single project-scoped memory by key',
        mimeType: 'application/json',
      },
      { uriTemplate: 'skill://{slug}', name: 'skill', description: 'Skill manifest by slug', mimeType: 'text/markdown' },
    ];
    if (this.deps.sharedMemories) {
      templates.push({
        uriTemplate: 'shared://{slug}',
        name: 'shared_memory',
        description: 'Fleet-wide shared memory document by slug (visible from every host and either engine)',
        mimeType: 'text/markdown',
      });
    }
    return templates;
  }

  async list(host: Host): Promise<ResourceDescriptor[]> {
    const [projects, skills] = await Promise.all([
      this.deps.projects.listProjects(host),
      // List ALL skills as resources (engine=null ⇒ no engine filter). Previously
      // hardcoded to codex, which hid any claude-specific skill from the resource
      // catalogue; the resource list is engine-agnostic and read is by slug.
      this.deps.skills.listSkills(host, null),
    ]);
    const resources: ResourceDescriptor[] = [];
    for (const p of projects.projects) {
      resources.push({
        uri: `project://${encodeURIComponent(p.slug)}`,
        name: p.title,
        description: p.description,
        mimeType: 'application/json',
      });
      // Enumerate per-project files (capped) so MCP clients can discover them
      // without an additional tools/call round-trip.
      try {
        const filesResp = (await this.deps.projects.listFiles(p.slug, host)) as {
          files?: Array<{
            stored_name?: string;
            description?: string | null;
            mime_type?: string | null;
          }>;
        };
        const files = filesResp?.files ?? [];
        for (const f of files.slice(0, PROJECT_FILES_LIST_CAP)) {
          const storedName = typeof f.stored_name === 'string' ? f.stored_name : '';
          if (!storedName) continue;
          const mime = (typeof f.mime_type === 'string' && f.mime_type) || 'text/plain';
          const descr = typeof f.description === 'string' ? f.description : '';
          resources.push({
            uri: buildProjectFileUri(p.slug, storedName),
            name: storedName,
            description: descr,
            mimeType: mime,
          });
        }
      } catch {
        // Skip projects whose file listing fails — keep the top-level entry.
      }
      // Enumerate per-project memories (capped, previews only) so a client that
      // speaks resources rather than tools can still discover what a project
      // remembers without guessing keys.
      try {
        const memResp = (await this.deps.projects.listMemories(p.slug, { include_content: false }, host)) as {
          memories?: Array<{ key?: string; preview?: string }>;
        };
        const memories = memResp?.memories ?? [];
        for (const m of memories.slice(0, PROJECT_MEMORIES_LIST_CAP)) {
          const key = typeof m.key === 'string' ? m.key : '';
          if (!key) continue;
          resources.push({
            uri: buildProjectMemoryUri(p.slug, key),
            name: key,
            description: typeof m.preview === 'string' ? m.preview : '',
            mimeType: 'application/json',
          });
        }
      } catch {
        // Skip projects whose memory listing fails — keep the top-level entry.
      }
    }
    // Shared memories are fleet-wide, so unlike the project/skill listings above
    // there is nothing host-specific to resolve first.
    if (this.deps.sharedMemories) {
      try {
        for (const m of await this.deps.sharedMemories.listRecent(SHARED_MEMORIES_LIST_CAP)) {
          resources.push({
            uri: m.uri,
            name: m.title,
            description: m.summary ?? m.preview,
            mimeType: 'text/markdown',
          });
        }
      } catch {
        // A failing shared-memory listing must not blank the whole catalogue.
      }
    }
    for (const s of skills.skills as Array<Record<string, unknown>>) {
      const slug = String(s['slug'] ?? '');
      if (!slug) continue;
      resources.push({
        uri: `skill://${encodeURIComponent(slug)}`,
        name: String(s['display_name'] ?? slug),
        description: typeof s['description'] === 'string' ? (s['description'] as string) : '',
        mimeType: 'text/markdown',
      });
    }
    return resources;
  }

  async read(uri: string, host: Host): Promise<ResourceReadResponse> {
    const parsed = parseUri(uri);
    const { scheme, id } = parsed;
    if (scheme === 'memory') {
      const result = await this.deps.memories.retrieve({ id }, host);
      return {
        contents: [
          {
            uri,
            name: id,
            mimeType: 'application/json',
            text: JSON.stringify(result),
          },
        ],
      };
    }
    if (scheme === 'project') {
      if (parsed.projectMemory) {
        const result = await this.deps.projects.getMemory(id, parsed.projectMemory.key, host);
        return {
          contents: [
            {
              uri,
              name: parsed.projectMemory.key,
              mimeType: 'application/json',
              text: JSON.stringify(result),
            },
          ],
        };
      }
      if (parsed.projectFile) {
        const { file } = await this.deps.projects.readFile(
          id,
          { storedName: parsed.projectFile.storedName },
          host,
        );
        const mime = file.mime_type ?? 'text/plain';
        const content: ResourceContent = {
          uri,
          name: file.stored_name,
          mimeType: isBinaryMime(mime) ? 'application/octet-stream' : mime,
          text: file.content,
        };
        return { contents: [content] };
      }
      const bootstrap = await this.deps.projects.bootstrap(id, host);
      return {
        contents: [
          { uri, name: id, mimeType: 'application/json', text: JSON.stringify(bootstrap) },
        ],
      };
    }
    if (scheme === 'shared') {
      if (!this.deps.sharedMemories) throw new Error('Shared memory is not available on this server');
      assertNoSharedSubPath(parsed, uri);
      const found = await this.deps.sharedMemories.readForResource(stripFragment(id));
      if (!found) throw new Error('Shared memory not found: ' + id);
      return {
        contents: [{ uri, name: found.summary.title, mimeType: 'text/markdown', text: found.content }],
      };
    }
    if (scheme === 'skill') {
      const skill = await this.deps.skills.retrieve(id, null, host);
      const manifest = typeof skill['manifest'] === 'string' ? (skill['manifest'] as string) : JSON.stringify(skill);
      return {
        contents: [
          { uri, name: id, mimeType: 'text/markdown', text: manifest },
        ],
      };
    }
    throw new Error('Unsupported resource scheme: ' + scheme);
  }

  /**
   * Note the fidelity limit: this path only carries `text`, so tags and metadata
   * are unreachable here. project_memory_upsert remains the full-fidelity surface.
   */
  async create(uri: string, params: Record<string, unknown>, host: Host): Promise<Record<string, unknown>> {
    const parsed = parseUri(uri);
    const text = typeof params['text'] === 'string' ? (params['text'] as string) : '';
    if (parsed.scheme === 'project' && parsed.projectMemory) {
      return (await this.deps.projects.upsertMemory(
        parsed.id,
        { key: parsed.projectMemory.key, content: text },
        host,
      )) as Record<string, unknown>;
    }
    if (parsed.scheme === 'shared') {
      if (!this.deps.sharedMemories) throw new Error('Shared memory is not available on this server');
      assertNoSharedSubPath(parsed, uri);
      // No engine here: the resource surface carries no engine hint, unlike
      // tools/call which threads the X-Engine header through. Provenance is
      // recorded as host-only for this path. Title/summary/tags/metadata are
      // omitted rather than blanked — `write` preserves what it is not given,
      // so a text-only resource update cannot strip a document's labels.
      return (await this.deps.sharedMemories.write({ slug: stripFragment(parsed.id), content: text }, host, null)) as Record<string, unknown>;
    }
    if (parsed.scheme !== 'memory') {
      throw new Error('Only memory://, shared://{slug} and project://{slug}/memory/{key} resources can be created');
    }
    return (await this.deps.memories.store({ id: parsed.id, content: text }, host)) as Record<string, unknown>;
  }

  async update(uri: string, params: Record<string, unknown>, host: Host): Promise<Record<string, unknown>> {
    return this.create(uri, params, host);
  }

  async delete(uri: string, host: Host): Promise<Record<string, unknown>> {
    const parsed = parseUri(uri);
    if (parsed.scheme === 'project' && parsed.projectMemory) {
      return (await this.deps.projects.deleteMemory(parsed.id, parsed.projectMemory.key, host)) as Record<string, unknown>;
    }
    if (parsed.scheme === 'shared') {
      if (!this.deps.sharedMemories) throw new Error('Shared memory is not available on this server');
      assertNoSharedSubPath(parsed, uri);
      return (await this.deps.sharedMemories.delete({ slug: stripFragment(parsed.id) }, host, null)) as Record<string, unknown>;
    }
    if (parsed.scheme !== 'memory') {
      throw new Error('Only memory://, shared://{slug} and project://{slug}/memory/{key} resources can be deleted');
    }
    return (await this.deps.memories.delete({ id: parsed.id }, host)) as Record<string, unknown>;
  }
}
